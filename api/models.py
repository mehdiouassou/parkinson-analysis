"""
Pydantic models for request/response validation.
"""

from pydantic import BaseModel
from typing import List


# =============================================================================
#                              TAGGING MODELS
# =============================================================================

class ActionLog(BaseModel):
    """Single action log entry for gait tagging."""
    id: int
    frame: int
    direction: int  # 0=Left, 1=Right, 2=Far to Near, 3=Near to Far
    action: str     # Human readable description


class SaveTaggingRequest(BaseModel):
    """Request to save tagging session logs."""
    videoFile: str
    logs: List[ActionLog]


# =============================================================================
#                            PROCESSING MODELS
# =============================================================================

class ProcessRequest(BaseModel):
    """Request to start processing a video batch."""
    batch_id: str  # Timestamp prefix e.g. "2026-02-17_12-30-45"


# =============================================================================
#                            RECORDING MODELS
# =============================================================================

class RecordingStartRequest(BaseModel):
    """Request to start a new recording session."""
    patientName: str = ""
    patientId: str = ""
