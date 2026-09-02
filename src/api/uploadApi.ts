import { API_BASE_URL } from './config'
import type { FromUrlResponse, LocalSessionResponse, VideoStatusResponse } from './types'

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') return data.detail
    return JSON.stringify(data)
  } catch {
    return res.statusText || `Error ${res.status}`
  }
}

export async function createLocalSession(
  filename: string,
  contentType: string,
  sizeBytes: number,
  videoId: string,
): Promise<LocalSessionResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/upload/local-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      content_type: contentType,
      size_bytes: sizeBytes,
      video_id: videoId,
      origin: window.location.origin,
    }),
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export type UploadProgressCallback = (bytesUploaded: number, totalBytes: number) => void

// Local: el archivo ya está completo en el navegador como Blob/File. Se usa
// XMLHttpRequest (no fetch) porque es la única API con progreso de subida
// nativo (xhr.upload.onprogress) con soporte universal en navegadores.
export function uploadBlobWithProgress(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  onProgress: UploadProgressCallback,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`La subida a GCS falló (${xhr.status}).`))
    }
    xhr.onerror = () => reject(new Error('La subida a GCS falló (error de red).'))
    xhr.send(blob)
  })
}

// Drive/OneDrive/Dropbox: se encadena el stream de descarga del proveedor
// directo al PUT de subida (ver providers/*.ts) — descarga y subida corren
// en paralelo en vez de bufferear el archivo completo antes de subirlo. El
// progreso se mide en bytes que ya pasaron por el TransformStream hacia el
// body del PUT (aproximado: fetch puede bufferear internamente un poco, no
// es 100% "bytes ya confirmados por GCS", pero es la señal disponible).
export async function uploadStreamWithProgress(
  uploadUrl: string,
  stream: ReadableStream<Uint8Array>,
  contentType: string,
  sizeBytes: number,
  onProgress: UploadProgressCallback,
): Promise<void> {
  let uploaded = 0
  const trackedStream = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        uploaded += chunk.byteLength
        onProgress(uploaded, sizeBytes)
        controller.enqueue(chunk)
      },
    }),
  )

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      // Con un body streaming, fetch no puede inferir el tamaño total (no
      // sabe cuándo termina el stream) — GCS lo necesita para aceptar la
      // sesión resumible como completa, así que se manda explícito.
      'Content-Length': String(sizeBytes),
    },
    body: trackedStream,
    // Requerido por la spec de fetch al mandar un ReadableStream como body.
    duplex: 'half',
  } as RequestInit)
  if (!res.ok) {
    throw new Error(`La subida a GCS falló (${res.status}).`)
  }
}

export async function startYoutubeImport(url: string, videoId: string): Promise<FromUrlResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/upload/from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, source: 'youtube', url }),
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export async function fetchVideoStatus(videoId: string): Promise<VideoStatusResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/upload/${videoId}/status`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}
