import { PublicClientApplication, type Configuration } from '@azure/msal-browser'
import { logInfo } from '../utils/logger'
import type { PickedFile } from './types'

// La v8 del picker de OneDrive es una página hosteada por Microsoft con la
// que se habla por postMessage/MessageChannel (no un SDK con función
// OneDrive.open() como la v7.2). A diferencia de v7.2, no depende de sondear
// window.closed, así que evita el problema de Cross-Origin-Opener-Policy que
// rompía la versión anterior en Chrome.
const BASE_URL = 'https://onedrive.live.com/picker'
const AUTHORITY = 'https://login.microsoftonline.com/consumers'

let msalApp: PublicClientApplication | null = null
let msalInitPromise: Promise<void> | null = null

function getMsalApp(): PublicClientApplication {
  if (!msalApp) {
    const clientId = import.meta.env.VITE_MS_CLIENT_ID
    const config: Configuration = {
      auth: {
        clientId,
        authority: AUTHORITY,
        redirectUri: window.location.origin,
      },
    }
    msalApp = new PublicClientApplication(config)
  }
  return msalApp
}

export async function preloadOneDrive(): Promise<void> {
  const clientId = import.meta.env.VITE_MS_CLIENT_ID
  if (!clientId) return
  if (!msalInitPromise) {
    msalInitPromise = getMsalApp().initialize()
  }
  await msalInitPromise
}

async function acquireToken(resource: string): Promise<string> {
  const app = getMsalApp()
  const scopes = [`${resource.replace(/\/$/, '')}/.default`]

  const accounts = app.getAllAccounts()
  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({ scopes, account: accounts[0] })
      return result.accessToken
    } catch {
      // cae al popup de login de abajo
    }
  }

  // overrideInteractionInProgress: un intento anterior (de esta sesión de
  // navegador u otra pestaña) puede haber dejado el flag interno de MSAL
  // como "interacción en curso" sin limpiarlo (p. ej. si el popup se cerró
  // manualmente). Sin esto, todo login posterior falla con
  // "interaction_in_progress" aunque no haya ningún popup real abierto.
  const result = await app.loginPopup({ scopes, overrideInteractionInProgress: true })
  app.setActiveAccount(result.account)
  return result.accessToken
}

interface PickerCommandMessage {
  type: 'command' | 'notification'
  data: {
    id: string
    data: { command: string; [key: string]: unknown }
    notification?: string
  }
}

interface PickedItem {
  id: string
  name: string
  parentReference: { driveId: string }
  '@sharePoint.endpoint': string
}

export async function pickOneDriveFile(): Promise<PickedFile> {
  const clientId = import.meta.env.VITE_MS_CLIENT_ID
  if (!clientId) {
    throw new Error('Falta configurar VITE_MS_CLIENT_ID.')
  }

  // Se abre la ventana ANTES de pedir el token (debe pasar de forma
  // síncrona dentro del clic para no ser bloqueada). Se navega recién
  // después de conseguir el token, con el token ya listo — si en vez de
  // esto se navegaba directo al picker y se pedía el token de forma
  // reactiva (vía el comando "authenticate" por postMessage), el popup de
  // login de MSAL quedaba demasiado lejos del gesto del usuario y el
  // navegador lo bloqueaba en silencio, dejando el picker sin sesión.
  const win = window.open('', 'OneDrivePicker', 'width=1080,height=680')
  if (!win) {
    throw new Error('El navegador bloqueó el popup de OneDrive. Habilita popups para este sitio.')
  }

  let initialToken: string
  try {
    initialToken = await acquireToken(BASE_URL)
  } catch (err) {
    win.close()
    throw err instanceof Error ? err : new Error('No se pudo iniciar sesión con Microsoft.')
  }

  return new Promise<PickedFile>((resolve, reject) => {
    const channelId = crypto.randomUUID()
    let port: MessagePort | null = null
    let settled = false

    const cleanup = () => {
      window.removeEventListener('message', onWindowMessage)
      window.clearInterval(closedCheck)
      if (!win.closed) win.close()
    }

    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }

    // Red de seguridad: si el usuario cierra la ventana del SO en vez de
    // cancelar dentro del picker, no llega ningún mensaje. Chrome puede
    // bloquear esta lectura por COOP; si falla, simplemente se ignora.
    const closedCheck = window.setInterval(() => {
      try {
        if (win.closed) settle(() => reject(new Error('Selección cancelada.')))
      } catch {
        // COOP bloqueó la lectura de `closed`; no es fatal, se sigue confiando en postMessage.
      }
    }, 1000)

    async function downloadPickedItem(item: PickedItem): Promise<PickedFile> {
      logInfo(`OneDrive: archivo elegido "${item.name}", leyendo metadata…`)
      const resource = item['@sharePoint.endpoint']
      const token = await acquireToken(resource)
      const metaRes = await fetch(
        `${resource}/drives/${item.parentReference.driveId}/items/${item.id}?select=id,name,size,@microsoft.graph.downloadUrl`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!metaRes.ok) {
        throw new Error(`No se pudo leer la metadata del archivo de OneDrive (HTTP ${metaRes.status}).`)
      }
      const meta = await metaRes.json()
      const downloadUrl = meta['@microsoft.graph.downloadUrl']
      if (!downloadUrl) {
        throw new Error('OneDrive no devolvió una URL de descarga para el archivo elegido.')
      }
      logInfo('OneDrive: empezando descarga…')
      const contentRes = await fetch(downloadUrl)
      if (!contentRes.ok) {
        throw new Error(`No se pudo descargar el archivo de OneDrive (HTTP ${contentRes.status}).`)
      }
      if (!contentRes.body) {
        throw new Error('El navegador no soporta streaming de respuesta para este archivo.')
      }
      return {
        filename: meta.name ?? item.name,
        contentType: contentRes.headers.get('content-type') ?? 'application/octet-stream',
        size: Number(meta.size ?? 0),
        stream: contentRes.body,
      }
    }

    async function onChannelMessage(message: MessageEvent<PickerCommandMessage>) {
      const payload = message.data
      if (payload.type !== 'command') return

      const messageId = payload.data.id
      const command = payload.data.data as { command: string; resource?: string; items?: PickedItem[] }
      port!.postMessage({ type: 'acknowledge', id: messageId })

      if (command.command === 'authenticate') {
        try {
          const token = await acquireToken(command.resource!)
          port!.postMessage({ type: 'result', id: messageId, data: { result: 'token', token } })
        } catch (err) {
          port!.postMessage({
            type: 'result',
            id: messageId,
            data: {
              result: 'error',
              error: { code: 'unableToObtainToken', message: err instanceof Error ? err.message : String(err) },
            },
          })
        }
        return
      }

      if (command.command === 'pick') {
        try {
          const item = command.items?.[0]
          if (!item) throw new Error('OneDrive no devolvió ningún archivo elegido.')
          const file = await downloadPickedItem(item)
          port!.postMessage({ type: 'result', id: messageId, data: { result: 'success' } })
          settle(() => resolve(file))
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Error descargando el archivo de OneDrive.'
          port!.postMessage({
            type: 'result',
            id: messageId,
            data: { result: 'error', error: { code: 'unusableItem', message } },
          })
          settle(() => reject(new Error(message)))
        }
        return
      }

      if (command.command === 'close') {
        settle(() => reject(new Error('Selección cancelada.')))
        return
      }

      port!.postMessage({
        type: 'result',
        id: messageId,
        data: { result: 'error', error: { code: 'unsupportedCommand', message: command.command } },
      })
    }

    function onWindowMessage(event: MessageEvent) {
      if (event.source !== win) return
      const message = event.data
      if (message?.type === 'initialize' && message.channelId === channelId) {
        port = event.ports[0]
        port.addEventListener('message', (e) => void onChannelMessage(e))
        port.start()
        port.postMessage({ type: 'activate' })
      }
    }

    window.addEventListener('message', onWindowMessage)

    const options = {
      sdk: '8.0',
      entry: { oneDrive: {} },
      authentication: {},
      messaging: { origin: window.location.origin, channelId },
    }
    const queryString = new URLSearchParams({ filePicker: JSON.stringify(options), locale: 'es-mx' })
    const url = `${BASE_URL}/_layouts/15/FilePicker.aspx?${queryString.toString()}`

    const form = win.document.createElement('form')
    form.setAttribute('action', url)
    form.setAttribute('method', 'POST')

    const tokenInput = win.document.createElement('input')
    tokenInput.setAttribute('type', 'hidden')
    tokenInput.setAttribute('name', 'access_token')
    tokenInput.setAttribute('value', initialToken)
    form.appendChild(tokenInput)

    win.document.body.appendChild(form)
    form.submit()
  })
}
