"""
Router de FastAPI para la generación de sesiones de subida resumible a GCS.
"""

from fastapi import APIRouter, HTTPException

from app.media_ingestion_service.upload.schemas import (
    UploadSessionRequest,
    UploadSessionResponse,
)
from app.media_ingestion_service.upload.session import (
    InvalidUploadRequestError,
    UnsupportedContentTypeError,
    UploadSessionCreationError,
    create_upload_session,
)

media_router_upload = APIRouter()


@media_router_upload.post(
    "/upload/local-session",
    response_model=UploadSessionResponse,
    summary="Crear sesión de subida resumible a GCS",
)
def create_local_upload_session(request: UploadSessionRequest) -> UploadSessionResponse:
    """
    Inicia una sesión de subida resumible en GCS y devuelve la URL para que el
    navegador suba el video directo al bucket, junto con el gcs_uri final
    esperado (gs://bucket/raw/{video_id}/{filename}).
    """
    try:
        return create_upload_session(request)
    except (UnsupportedContentTypeError, InvalidUploadRequestError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UploadSessionCreationError as exc:
        # El error real de GCS ya quedó logueado en session.py; al cliente
        # solo se le expone el mensaje genérico.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
