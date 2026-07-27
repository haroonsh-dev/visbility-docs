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
    "You are a strict, direct document analysis assistant.\n"
    "CRITICAL RULES:\n"
    "1. Answer questions DIRECTLY using ONLY the provided Document Context.\n"
    "2. DO NOT provide general background info, textbook definitions, introductory essays, or domain explanations (e.g. NEVER explain what 'Electrical Engineering' or 'Invoices' are in general).\n"
    "3. DO NOT use external world knowledge. DO NOT hallucinate, guess, or invent details.\n"
    "4. Support queries in English, Urdu (اردو), and Roman Urdu. Reply in the EXACT same language and script as the user's question.\n"
    "5. If the answer is not in the context, say 'I cannot find this information in the document.' and STOP immediately."
)

AGENT_SYSTEM_PROMPT = (
    "You are a strict, direct document analysis assistant. Follow the Agent Instructions carefully.\n"
    "CRITICAL RULES:\n"
    "1. Answer DIRECTLY using ONLY the provided Document Context.\n"
    "2. DO NOT include general background info, textbook definitions, or domain explanations (e.g., NEVER explain what 'Electrical Engineering' is in general).\n"
    "3. DO NOT use external world knowledge. DO NOT hallucinate, guess, or invent details.\n"
    "4. Answer in the same language and script as the user's question (e.g. reply in Roman Urdu if asked in Roman Urdu).\n"
    "5. If the exact answer is not in the context, state that it is not available in the documents."
)


def get_session_history(session_id: str) -> InMemoryChatMessageHistory:
    if session_id not in _store:
        _store[session_id] = InMemoryChatMessageHistory()
    return _store[session_id]


class ConversationService:
    def __init__(self):
        from .provider_manager import provider_manager
        api_key = provider_manager.get_groq_key()
        self.llm = None
        self._chain = None
        self._chain_with_history = None
        self._last_context: dict[str, str] = {}
        self._current_system_prompt = SYSTEM_PROMPT
        if api_key and api_key.startswith("gsk_") and "your_groq" not in api_key:
            self.reconfigure(api_key)

    def reconfigure(self, api_key: str = None):
        from .provider_manager import provider_manager
        key = api_key or provider_manager.get_groq_key()
        key = (key or "").strip()
        if not key or not key.startswith("gsk_") or "your_groq" in key:
            self.llm = None
            self._chain = None
            self._chain_with_history = None
            return False

        self.llm = ChatGroq(
            api_key=key,
            model="llama-3.3-70b-versatile",
            temperature=0.0,
            max_tokens=2048,
        )
        self._setup_chain(self._current_system_prompt)
        return True

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

        # Ensure we ONLY keep the very last question and answer (2 messages)
        hist = None
        try:
            hist = get_session_history(session_id or "default")
            if hist is not None and len(hist.messages) > 2:
                # Keep exactly the last human message and AI response
                kept = hist.messages[-2:]
                hist.clear()
                for m in kept:
                    hist.add_message(m)
                chat_log.info("Trimmed history to strictly keep ONLY the last question and answer.")
        except Exception as e:
            chat_log.info(f"History trim failed: {e}")

        # Ensure API key from AI Settings is active
        from .provider_manager import provider_manager
        configured_key = provider_manager.get_groq_key()
        if not configured_key or not configured_key.startswith("gsk_"):
            from fastapi import HTTPException
            raise HTTPException(
                status_code=400,
                detail="Groq API Key is not configured. Please configure your Groq API Key in AI Settings."
            )

        if self.llm is None or getattr(self.llm, "groq_api_key", None) != configured_key:
            self.reconfigure(configured_key)

        # Dynamic Model Routing (Waterfall)
        estimated_chars = len(chain_inputs.get("agent_instructions", "")) + len(chain_inputs.get("context", "")) + len(chain_inputs.get("question", ""))
        if hist is not None:
            for m in hist.messages:
                estimated_chars += len(m.content)
        
        estimated_tokens = estimated_chars / 4
        target_model = "llama-3.3-70b-versatile"
        if self.llm and getattr(self.llm, "model_name", "llama-3.3-70b-versatile") != target_model:
            self.llm = ChatGroq(
                api_key=configured_key,
                model=target_model,
                temperature=0.0,
                max_tokens=2048,
            )
            self._setup_chain(self._current_system_prompt)


        chat_log.info(f"Invoking LangChain chain: model={target_model}, followup={is_followup}")
        _logger.info(f"[CHAT] session={session_id}, context_len={len(context)}, is_followup={is_followup}")
        if not self._chain_with_history:
            from fastapi import HTTPException
            raise HTTPException(
                status_code=400,
                detail="Groq LLM chain initialization failed. Please re-enter your Groq API Key in AI Settings."
            )

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
