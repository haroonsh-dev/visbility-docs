import time
import logging
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_groq import ChatGroq
from ..config import settings
from .orchestration_logger import get_chat_logger, C

_logger = logging.getLogger("visibility-docs")

_store: dict[str, InMemoryChatMessageHistory] = {}

SYSTEM_PROMPT = (
    "You are a document analysis assistant. Answer questions based ONLY on the provided document context. "
    "If the answer is not in the context, say 'I cannot find this information in the document.'"
)

AGENT_SYSTEM_PROMPT = (
    "You are a helpful document analysis assistant. "
    "Follow the Agent Instructions carefully. "
    "Answer in the same language as the user's question. "
    "Be thorough and extract all relevant information from the context."
)


def get_session_history(session_id: str) -> InMemoryChatMessageHistory:
    if session_id not in _store:
        _store[session_id] = InMemoryChatMessageHistory()
    return _store[session_id]


class ConversationService:
    def __init__(self):
        api_key = settings.GROQ_API_KEY
        self.llm = ChatGroq(
            api_key=api_key,
            model="llama-3.1-8b-instant",
            temperature=0.1,
            max_tokens=2048,
        ) if api_key and api_key != "gsk_your_groq_api_key" else None
        self._chain = None
        self._chain_with_history = None
        self._last_context: dict[str, str] = {}
        self._current_system_prompt = SYSTEM_PROMPT
        self._setup_chain(self._current_system_prompt)

    def _setup_chain(self, system_prompt: str = None):
        if not self.llm:
            self._chain = None
            self._chain_with_history = None
            return

        sp = system_prompt or SYSTEM_PROMPT
        if sp == SYSTEM_PROMPT or "{" not in sp:
            prompt = ChatPromptTemplate.from_messages([
                ("system", sp),
                MessagesPlaceholder(variable_name="history"),
                ("human", "{agent_instructions}Document Context:\n{context}\n\nQuestion: {question}"),
            ])
        else:
            prompt = ChatPromptTemplate.from_messages([
                ("system", AGENT_SYSTEM_PROMPT),
                MessagesPlaceholder(variable_name="history"),
                ("human", "{agent_instructions}Document Context:\n{context}\n\nQuestion: {question}"),
            ])

        self._chain = prompt | self.llm

        self._chain_with_history = RunnableWithMessageHistory(
            self._chain,
            get_session_history,
            input_messages_key="question",
            history_messages_key="history",
        )

    def update_system_prompt(self, prompt_text: str):
        """Rebuild the chain with a new system prompt (e.g. an agent .md file)."""
        if prompt_text and prompt_text != self._current_system_prompt:
            self._current_system_prompt = prompt_text
            self._setup_chain(prompt_text)
            return True
        return False

    def load_history_from_db(self, session_id: str, messages: list[dict]):
        """Seed in-memory history from DB messages for this session."""
        sid = session_id or "default"
        history = get_session_history(sid)
        if history.messages:
            chat_log = get_chat_logger()
            chat_log.info(f"History already in memory for session '{sid}' ({len(history.messages)} msgs)")
            return
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role == "user":
                history.add_user_message(content)
            elif role == "assistant":
                history.add_ai_message(content)
        if messages:
            chat_log = get_chat_logger()
            chat_log.info(f"Loaded {len(messages)} messages from DB into session '{sid}'")

    def set_last_context(self, session_id: str, context: str):
        if session_id:
            self._last_context[session_id] = context

    def get_last_context(self, session_id: str) -> str:
        return self._last_context.get(session_id, "")

    def chat(self, question: str, context: str, session_id: str = None, is_followup: bool = False,
             system_prompt: str = None) -> str:
        if not self._chain_with_history:
            return "Groq API is not configured."

        chat_log = get_chat_logger()
        config = {"configurable": {"session_id": session_id or "default"}} if session_id else \
                 {"configurable": {"session_id": "default"}}

        # Build chain inputs based on whether we have agent instructions
        chain_inputs = {"question": question}

        if system_prompt:
            changed = self.update_system_prompt(system_prompt)
            if changed:
                chat_log.info(f"System prompt updated to agent-specific prompt ({len(system_prompt)} chars)")

        if system_prompt and "{" in system_prompt:
            # Agent prompt has {text}/{filename} — pass as agent_instructions instead
            chain_inputs["agent_instructions"] = "Agent Instructions:\n" + system_prompt + "\n\n"
        else:
            chain_inputs["agent_instructions"] = ""
        chain_inputs["context"] = context

        if is_followup and not context:
            context = self.get_last_context(session_id)
            chain_inputs["context"] = context
            chat_log.info(f"No new context — reusing previous session context ({len(context)} chars)")

        if context:
            self.set_last_context(session_id, context)

        # Inject last assistant response for conversational continuity
        if context:
            try:
                h = get_session_history(session_id or "default")
                for m in reversed(h.messages):
                    if isinstance(m, AIMessage):
                        txt = m.content.strip()
                        if txt and txt not in context:
                            context += f"\n--\n[Previous Response]\n{txt}\n[/Previous Response]"
                            chain_inputs["context"] = context
                        break
            except Exception:
                pass

        # History compression and dynamic token optimization
        hist = None
        try:
            hist = get_session_history(session_id or "default")
            if hist is not None and len(hist.messages) > 6:
                messages_to_compress = hist.messages[:-4]
                kept = hist.messages[-4:]
                
                # Summarize old messages using a fast LLM
                from .groq_service import GroqService
                groq_srv = GroqService()
                old_text = ""
                for m in messages_to_compress:
                    role = "User" if isinstance(m, HumanMessage) else "Assistant"
                    old_text += f"{role}: {m.content}\n"
                
                summary_prompt = "Summarize the key points of the following chat history in 1-2 short sentences so an AI assistant can remember the context:\n\n" + old_text
                summary_result = groq_srv.chat([{"role": "user", "content": summary_prompt}], max_tokens=150, temperature=0.1, model="llama-3.1-8b-instant")
                
                # Reset history with the summary
                hist.clear()
                from langchain_core.messages import SystemMessage
                hist.add_message(SystemMessage(content=f"[Prior Conversation Summary: {summary_result.strip()}]"))
                for m in kept:
                    hist.add_message(m)
                chat_log.info(f"Compressed {len(messages_to_compress)} old messages into a summary.")
        except Exception as e:
            chat_log.info(f"History compression failed: {e}")

        # Dynamic Model Routing (Waterfall)
        estimated_chars = len(chain_inputs.get("agent_instructions", "")) + len(chain_inputs.get("context", "")) + len(chain_inputs.get("question", ""))
        if hist is not None:
            for m in hist.messages:
                estimated_chars += len(m.content)
        
        estimated_tokens = estimated_chars / 4
        target_model = "llama-3.1-8b-instant"
        if estimated_tokens > 4500:
            target_model = "llama-3.2-90b-vision-preview"
            chat_log.info(f"Payload ~{int(estimated_tokens)} tokens. Dynamically switching to {target_model}")
        
        if self.llm and getattr(self.llm, "model_name", "llama-3.1-8b-instant") != target_model:
            api_key = settings.GROQ_API_KEY
            self.llm = ChatGroq(
                api_key=api_key,
                model=target_model,
                temperature=0.1,
                max_tokens=2048,
            )
            self._setup_chain(self._current_system_prompt)


        chat_log.info(f"Invoking LangChain chain: model={target_model}, followup={is_followup}")
        _logger.info(f"[CHAT] session={session_id}, context_len={len(context)}, is_followup={is_followup}")
        t0 = time.time()
        response = self._chain_with_history.invoke(
            chain_inputs,
            config=config,
        )
        duration = time.time() - t0
        output_len = len(response.content)
        chat_log.info(f"LangChain invoke done: {output_len} chars in {duration:.1f}s")
        _logger.info(f"[CHAT] LLM response: {output_len} chars in {duration:.1f}s")
        return response.content

    def get_history(self, session_id: str = None) -> list[dict]:
        sid = session_id or "default"
        history = _store.get(sid)
        if not history:
            return []
        msgs = history.messages
        result = []
        for m in msgs:
            if isinstance(m, HumanMessage):
                result.append({"role": "user", "content": m.content})
            elif isinstance(m, AIMessage):
                result.append({"role": "assistant", "content": m.content})
        return result


conversation_service = ConversationService()
