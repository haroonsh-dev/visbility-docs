from fastapi import APIRouter, HTTPException, Body, status
from ..models.schemas import ChatRequest, ChatResponse, ChatSessionResponse, ChatSessionListResponse
from ..services.chat_service import chat_service
from ..database import SupabaseDB

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])


@router.get(
    "/sessions",
    response_model=ChatSessionListResponse,
    summary="List chat sessions",
    description="List all chat sessions for an organization",
)
async def list_sessions(organization_id: str):
    sessions = SupabaseDB.list_chat_sessions(organization_id)
    return {"sessions": sessions, "total": len(sessions)}


@router.get(
    "/sessions/{session_id}",
    response_model=ChatSessionResponse,
    summary="Get chat session",
    description="Get a chat session with all its messages",
)
async def get_session(session_id: str):
    session = SupabaseDB.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete chat session",
    description="Delete a chat session and all its messages",
)
async def delete_session(session_id: str):
    SupabaseDB.delete_chat_session(session_id)
    return {"message": "Session deleted"}


@router.post(
    "",
    response_model=ChatResponse,
    summary="Chat with documents",
    description="Ask questions about selected documents using RAG + Groq AI",
)
async def chat_with_document(request: ChatRequest = Body(...)):
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    doc_ids = request.document_ids or ([request.document_id] if request.document_id else [])

    result = chat_service.chat_with_document(
        question=request.question,
        document_ids=doc_ids,
        organization_id=request.organization_id,
        document_type=request.document_type,
        phase3_agent=request.phase3_agent,
        status=request.status,
        date_from=request.date_from,
        date_to=request.date_to,
        chat_history=request.chat_history,
        session_id=request.session_id,
        selected_text=request.selected_text,
    )

    return ChatResponse(
        answer=result["answer"],
        sources=result["sources"],
        document_id=result["document_id"],
        history=result.get("history", []),
        session_id=result.get("session_id"),
    )


@router.post(
    "/all",
    response_model=ChatResponse,
    summary="Chat across all documents",
    description="Search across all documents and answer questions using RAG + Groq AI",
)
async def chat_all_documents(request: ChatRequest = Body(...)):
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    result = chat_service.chat_with_document(
        question=request.question,
        document_ids=[],
        organization_id=request.organization_id,
        document_type=request.document_type,
        phase3_agent=request.phase3_agent,
        status=request.status,
        date_from=request.date_from,
        date_to=request.date_to,
        chat_history=request.chat_history,
        session_id=request.session_id,
        selected_text=request.selected_text,
    )

    return ChatResponse(
        answer=result["answer"],
        sources=result["sources"],
        document_id=result["document_id"],
        history=result.get("history", []),
        session_id=result.get("session_id"),
    )
