import os
import re
import sys
import tempfile
import asyncio
import httpx
from fastapi import HTTPException


def extract_drive_id(url: str) -> str:
    patterns = [
        r"/file/d/([a-zA-Z0-9_-]+)",
        r"id=([a-zA-Z0-9_-]+)",
        r"/d/([a-zA-Z0-9_-]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return ""


async def _download_gdown_async(url_directa: str, output_path: str, timeout: float = 600.0):
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "gdown", url_directa, "-O", output_path,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode != 0:
            raise RuntimeError(f"gdown falló (código {proc.returncode}): {stderr.decode().strip()}")
    except (asyncio.TimeoutError, asyncio.CancelledError):
        proc.kill()
        await proc.communicate()
        raise


async def download_video_from_url(url: str) -> str:
    """
    Descarga un video desde una URL.
    Usa gdown (subprocess) para Google Drive y httpx para Dropbox/directo.
    """
    drive_id = extract_drive_id(url)
    fd, temp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    success = False

    try:
        if drive_id:
            url_directa = f"https://drive.google.com/uc?id={drive_id}"
            print(f"\n[INFO] Detectado link de Drive. Usando gdown para el ID: {drive_id}")

            try:
                await _download_gdown_async(url_directa, temp_path, timeout=600.0)
            except asyncio.TimeoutError:
                raise HTTPException(408, "Timeout: gdown tardó más de 10 minutos descargando el archivo.")
            except asyncio.CancelledError:
                raise
            except RuntimeError as e:
                raise HTTPException(400, str(e))

            if os.path.exists(temp_path) and os.path.getsize(temp_path) < 50000:
                with open(temp_path, "rb") as f:
                    if b"<html" in f.read(500).lower():
                        raise HTTPException(400, "gdown no pudo saltar la seguridad. El archivo sigue privado o bloqueado por cuota.")

        else:
            print(f"\n[INFO] Detectado link directo/Dropbox. Usando httpx.")
            headers = {"User-Agent": "Mozilla/5.0"}
            async with httpx.AsyncClient(follow_redirects=True, headers=headers, timeout=600.0) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with open(temp_path, "wb") as f:
                        async for chunk in response.aiter_bytes(chunk_size=65536):
                            f.write(chunk)

        success = True
        return temp_path

    except (HTTPException, asyncio.CancelledError):
        raise
    except Exception as e:
        raise HTTPException(400, f"Error en la descarga: {str(e)}")
    finally:
        if not success and os.path.exists(temp_path):
            os.remove(temp_path)
