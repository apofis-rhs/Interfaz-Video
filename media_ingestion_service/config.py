"""
Configuración del módulo de ingesta de media.

Todas las variables se leen de env vars (o del .env, igual que
app/core/config.py). Bucket y project id hacen fallback a los valores del
pipeline de video (VIDEO_GCS_BUCKET / VERTEX_AI_PROJECT_ID) para no duplicar
configuración cuando se comparte el mismo bucket.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.config import settings as core_settings


class MediaIngestionSettings(BaseSettings):
    MEDIA_INGESTION_GCS_BUCKET: str = ""
    MEDIA_INGESTION_PROJECT_ID: str = ""

    # Lista separada por comas de content types de video aceptados
    MEDIA_INGESTION_ALLOWED_CONTENT_TYPES: str = "video/mp4,video/quicktime,video/webm"

    # Tamaño máximo aceptado por archivo (default: 5 GiB)
    MEDIA_INGESTION_MAX_SIZE_BYTES: int = 5 * 1024 ** 3

    # Vigencia de la sesión resumible. GCS la fija en una semana y no es
    # negociable por API; se expone en config para informarla al cliente y
    # poder ajustarla si Google cambia el límite.
    MEDIA_INGESTION_SESSION_EXPIRATION_SECONDS: int = 7 * 24 * 3600

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def gcs_bucket(self) -> str:
        return self.MEDIA_INGESTION_GCS_BUCKET or core_settings.VIDEO_GCS_BUCKET

    @property
    def project_id(self) -> str:
        return self.MEDIA_INGESTION_PROJECT_ID or core_settings.VERTEX_AI_PROJECT_ID

    @property
    def allowed_content_types(self) -> frozenset[str]:
        return frozenset(
            ct.strip().lower()
            for ct in self.MEDIA_INGESTION_ALLOWED_CONTENT_TYPES.split(",")
            if ct.strip()
        )


media_ingestion_settings = MediaIngestionSettings()
