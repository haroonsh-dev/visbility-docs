import logging
from fastapi import APIRouter, Depends, HTTPException
from ..auth_deps import get_current_user
from ..services.report_service import generate_report
from ..services.email_service import send_email

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


@router.post("/email", summary="Generate and email report of all documents")
async def email_report(
    organization_id: str,
    phase3_agent: str = "",
    current_user: dict = Depends(get_current_user),
):
    user_email = current_user.get("email", "")
    if not user_email:
        raise HTTPException(status_code=400, detail="User email not found in token")

    html, subject = generate_report(organization_id, phase3_agent)

    sent = send_email(user_email, subject, html)
    if not sent:
        raise HTTPException(status_code=500, detail="Failed to send email — check SMTP configuration")

    return {
        "message": "Report sent successfully",
        "sent_to": user_email,
        "subject": subject,
        "organization_id": organization_id,
        "phase3_agent": phase3_agent or None,
    }
