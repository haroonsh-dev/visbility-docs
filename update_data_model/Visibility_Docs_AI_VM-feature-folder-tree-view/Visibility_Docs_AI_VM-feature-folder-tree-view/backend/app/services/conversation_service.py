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
            model="llama-3.3-70b-versatile",
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

        # ── Inject last assistant response for conversational continuity ──
        # Make the previous answer visible in the primary context (not just
        # the `history` placeholder) so the model always attends to it.
        if context:
            try:
                h = get_session_history(session_id or "default")
                for m in reversed(h.messages):
                    if isinstance(m, AIMessage):
                        txt = m.content.strip()
                        if txt and txt not in context:
                            context += f"\n--\n[Previous Response]\n{txt}\n[/Previous Response]"
                        break
            except Exception:
                pass

        # ── Trim history to stay within Groq free-tier TPM limits ──
        # The full history is sent on every turn; without trimming it grows
        # unbounded and eventually triggers a 413 "Request too large" error.
        try:
            hist = get_session_history(session_id or "default")
            if hist is not None and len(hist.messages) > 16:
                kept = hist.messages[-16:]
                hist.clear()
                for m in kept:
                    hist.add_message(m)
        except Exception:
            pass

        chat_log.info(f"Invoking LangChain chain: model=llama-3.3-70b-versatile, followup={is_followup}")
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
