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
    "You are a strict, factual document analysis assistant for Visibility Docs AI. "
    "STRICT GROUNDING DIRECTIVE: Base every fact, date, number, name, and figure ONLY on the provided document context. "
    "Do NOT assume, infer, or hallucinate outside knowledge or information not explicitly present in the files. "
    "If information is missing or not found in the context, explicitly state that it is not available in the documents. "
    "Answer naturally in the same language as the user's question. "
    "Be thorough, detailed, and extract all relevant information from the context. "
    "CRITICAL: Do NOT output raw JSON objects, JSON code blocks, or _field_confidence dictionaries — always write human-readable Markdown responses."
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
            temperature=0.0,
            max_tokens=3072,
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
        # Escape any remaining single braces so LangChain template variables aren't confused
        clean_sp = sp.replace("{", "{{").replace("}", "}}") if "{" in sp else sp

        prompt = ChatPromptTemplate.from_messages([
            ("system", clean_sp),
            MessagesPlaceholder(variable_name="history"),
            ("human", "Document Context:\n{context}\n\nQuestion: {question}"),
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

        if system_prompt:
            changed = self.update_system_prompt(system_prompt)
            if changed:
                chat_log.info(f"System prompt updated to agent-specific prompt ({len(system_prompt)} chars)")

        chain_inputs = {
            "question": question,
            "context": context,
        }

        if is_followup and not context:
            context = self.get_last_context(session_id)
            chain_inputs["context"] = context
            chat_log.info(f"No new context — reusing previous session context ({len(context)} chars)")

        if context:
            self.set_last_context(session_id, context)

        # ── Inject last assistant response for conversational continuity ──
        if context:
            try:
                h = get_session_history(session_id or "default")
                for m in reversed(h.messages):
                    if isinstance(m, AIMessage):
                        txt = m.content.strip()
                        if txt and txt not in context:
                            context += f"\n--\n[Previous Response]\n{txt[:500]}\n[/Previous Response]"
                        break
            except Exception:
                pass

        # ── Trim history to stay within Groq free-tier TPM limits (12K TPM max) ──
        try:
            hist = get_session_history(session_id or "default")
            if hist is not None and len(hist.messages) > 6:
                kept = hist.messages[-6:]
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
