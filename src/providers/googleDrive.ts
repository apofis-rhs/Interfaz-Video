import { loadScript } from '../utils/loadScript'
import { logInfo } from '../utils/logger'
import { ALLOWED_VIDEO_CONTENT_TYPES } from '../utils/videoContentType'
import type { PickedFile } from './types'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

let tokenClient: any = null
let pickerLibReady = false
let sdkPromise: Promise<void> | null = null

function ensureGoogleSdkLoaded(): Promise<void> {
  if (sdkPromise) return sdkPromise

  sdkPromise = Promise.all([
    loadScript('https://apis.google.com/js/api.js'),
    loadScript('https://accounts.google.com/gsi/client'),
  ]).then(
    () =>
      new Promise<void>((resolve) => {
        window.gapi.load('picker', () => {
          pickerLibReady = true
          resolve()
        })
      }),
  )
  return sdkPromise
}

export async function preloadGoogleDrive(): Promise<void> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) return

  await ensureGoogleSdkLoaded()
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: '',
  })
}

export function pickGoogleDriveFile(): Promise<PickedFile> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY
  const appId = import.meta.env.VITE_GOOGLE_APP_ID
  if (!clientId || !apiKey || !appId) {
    return Promise.reject(
      new Error('Falta configurar VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY / VITE_GOOGLE_APP_ID.'),
    )
  }
  if (!tokenClient || !pickerLibReady) {
    return Promise.reject(
      new Error('Google Drive todavía no terminó de cargar, intenta de nuevo en un momento.'),
    )
  }

  logInfo('Google Drive: pidiendo access token…')
  return new Promise<PickedFile>((resolve, reject) => {
    tokenClient.callback = async (response: { access_token?: string; error?: string }) => {
      if (response.error || !response.access_token) {
        reject(new Error(`Error de autenticación con Google: ${response.error ?? 'sin access_token'}`))
        return
      }
      logInfo('Google Drive: autenticado, abriendo picker…')
      try {
        resolve(await showPickerAndDownload(response.access_token, apiKey, appId))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Error descargando el archivo de Drive.'))
      }
    }
    tokenClient.requestAccessToken({ prompt: '' })
  })
}

function showPickerAndDownload(accessToken: string, apiKey: string, appId: string): Promise<PickedFile> {
  return new Promise<PickedFile>((resolve, reject) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
    view.setMimeTypes(ALLOWED_VIDEO_CONTENT_TYPES.join(','))

    const picker = new window.google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      // Requerido por el scope drive.file: sin esto, el token no recibe el
      // grant sobre el archivo elegido y la API lo devuelve como 404.
      .setAppId(appId)
      .addView(view)
      .setCallback((data: any) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data[window.google.picker.Response.DOCUMENTS][0]
          logInfo(`Google Drive: archivo elegido (id=${doc.id}), leyendo metadata…`)
          downloadDriveFile(doc.id, accessToken).then(resolve, (err) =>
            reject(err instanceof Error ? err : new Error('Error descargando el archivo de Drive.')),
          )
        } else if (data.action === window.google.picker.Action.CANCEL) {
          reject(new Error('Selección cancelada.'))
        }
      })
      .build()
    picker.setVisible(true)
  })
}

async function driveApiError(res: Response, action: string): Promise<Error> {
  const body = await res.json().catch(() => null)
  const reason = body?.error?.message ?? res.statusText
  return new Error(
    `${action} (HTTP ${res.status}): ${reason}. Revisa que "Google Drive API" (no solo Picker API) esté habilitada en el mismo proyecto de Google Cloud que el Client ID/API key.`,
  )
}

async function downloadDriveFile(fileId: string, accessToken: string): Promise<PickedFile> {
  const authHeaders = { Authorization: `Bearer ${accessToken}` }

  // size y mimeType (no solo name) para poder abrir la sesión de GCS antes
  // de terminar de bajar el archivo — necesario para el streaming pipe.
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType`, {
    headers: authHeaders,
  })
  if (!metaRes.ok) throw await driveApiError(metaRes, 'No se pudo leer la metadata del archivo de Drive')
  const meta = await metaRes.json()

  const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: authHeaders,
  })
  if (!contentRes.ok) throw await driveApiError(contentRes, 'No se pudo descargar el archivo de Drive')
  if (!contentRes.body) {
    throw new Error('El navegador no soporta streaming de respuesta para este archivo.')
  }

  return {
    filename: meta.name ?? 'video.mp4',
    contentType: meta.mimeType ?? 'application/octet-stream',
    size: Number(meta.size ?? 0),
    stream: contentRes.body,
  }
}
