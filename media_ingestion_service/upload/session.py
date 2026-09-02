"""
Lógica de creación de sesiones de subida resumible a GCS.

El cliente (navegador) recibe la URL de sesión y sube el archivo directo al
bucket con PUT, sin pasar los bytes por este microservicio. Las credenciales
se resuelven vía ADC (GOOGLE_APPLICATION_CREDENTIALS ya exportado en
app/core/config.py).
"""

import logging
import posixpath
from functools import lru_cache
from uuid import UUID

from google.cloud import storage

from app.media_ingestion_service.config import media_ingestion_settings
from app.media_ingestion_service.upload.schemas import (
    UploadSessionRequest,
    UploadSessionResponse,
)

logger = logging.getLogger(__name__)


class UnsupportedContentTypeError(ValueError):
    """El content_type no está en la lista de tipos de video soportados."""


class InvalidUploadRequestError(ValueError):
    """La petición es inválida por algo distinto al content_type (filename, tamaño)."""


class UploadSessionCreationError(RuntimeError):
    """GCS falló al iniciar la sesión resumible."""


@lru_cache(maxsize=1)
def _get_storage_client() -> storage.Client:
    return storage.Client(project=media_ingestion_settings.project_id or None)


def build_object_name(video_id: UUID, filename: str) -> str:
    """
    Patrón consistente de nombre de objeto: raw/{video_id}/{filename}.

    Se usa solo el basename del filename para que rutas o '..' enviados por el
    cliente no puedan escapar del prefijo raw/{video_id}/.
    """
    basename = posixpath.basename(filename.replace("\\", "/")).strip()
    if not basename or basename in {".", ".."}:
        raise InvalidUploadRequestError(f"Nombre de archivo inválido: {filename!r}")
    return f"raw/{video_id}/{basename}"


def create_upload_session(request: UploadSessionRequest) -> UploadSessionResponse:
    """
    Valida la petición e inicia una sesión de subida resumible en GCS.

    Raises:
        UnsupportedContentTypeError: content_type fuera de la lista soportada.
        InvalidUploadRequestError: filename inutilizable o tamaño fuera de límite.
        UploadSessionCreationError: GCS no pudo crear la sesión (o falta bucket).
    """
    settings = media_ingestion_settings

    if request.content_type.lower() not in settings.allowed_content_types:
        raise UnsupportedContentTypeError(
            f"content_type no soportado: {request.content_type!r}. "
            f"Soportados: {sorted(settings.allowed_content_types)}"
        )

    if request.size_bytes > settings.MEDIA_INGESTION_MAX_SIZE_BYTES:
        raise InvalidUploadRequestError(
            f"Archivo de {request.size_bytes} bytes excede el máximo de "
            f"{settings.MEDIA_INGESTION_MAX_SIZE_BYTES} bytes"
        )

    object_name = build_object_name(request.video_id, request.filename)

    bucket_name = settings.gcs_bucket
    if not bucket_name:
        logger.error(
            "MEDIA_INGESTION_GCS_BUCKET / VIDEO_GCS_BUCKET sin configurar; "
            "no se puede crear la sesión de subida"
        )
        raise UploadSessionCreationError("Bucket de GCS no configurado")

    try:
        blob = _get_storage_client().bucket(bucket_name).blob(object_name)
        session_url = blob.create_resumable_upload_session(
            content_type=request.content_type,
            size=request.size_bytes,
            origin=request.origin,
        )
    except Exception as exc:
        logger.exception(
            "Fallo al crear sesión resumible en GCS (bucket=%s, object=%s): %s",
            bucket_name,
            object_name,
            exc,
        )
        raise UploadSessionCreationError(
            "GCS no pudo iniciar la sesión de subida"
        ) from exc

    return UploadSessionResponse(
        upload_session_url=session_url,
        video_id=request.video_id,
        gcs_uri=f"gs://{bucket_name}/{object_name}",
        expires_in_seconds=settings.MEDIA_INGESTION_SESSION_EXPIRATION_SECONDS,
    )
