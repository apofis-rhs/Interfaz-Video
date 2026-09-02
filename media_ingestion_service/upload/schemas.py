"""
Esquemas Pydantic del endpoint de sesión de subida resumible a GCS.
"""

from uuid import UUID

from pydantic import BaseModel, Field


class UploadSessionRequest(BaseModel):
    filename: str = Field(
        ...,
        min_length=1,
        max_length=1024,
        description="Nombre del archivo tal como lo tiene el cliente; se usa solo el basename",
        examples=["clase_matematicas.mp4"],
    )
    content_type: str = Field(
        ...,
        description="MIME type del video (ver lista soportada en config)",
        examples=["video/mp4"],
    )
    size_bytes: int = Field(
        ...,
        gt=0,
        description="Tamaño exacto del archivo en bytes; GCS rechaza subidas que no coincidan",
    )
    video_id: UUID = Field(
        ...,
        description="UUID generado por el cliente para correlacionar el video en fases posteriores",
    )
    origin: str | None = Field(
        default=None,
        description=(
            "Origin del navegador que hará la subida (p. ej. https://app.qualidot.net). "
            "Si se envía, GCS restringe la sesión a ese Origin vía CORS."
        ),
    )


class UploadSessionResponse(BaseModel):
    upload_session_url: str = Field(
        ..., description="URL de la sesión resumible; el navegador sube el archivo con PUT a esta URL"
    )
    video_id: UUID
    gcs_uri: str = Field(
        ...,
        description="URI final esperado del objeto en GCS",
        examples=["gs://mi-bucket/raw/9b2f.../clase_matematicas.mp4"],
    )
    expires_in_seconds: int = Field(
        ..., description="Vigencia de la sesión resumible (GCS la fija en una semana)"
    )
