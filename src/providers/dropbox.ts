import { logInfo } from '../utils/logger'
import type { PickedFile } from './types'

let scriptPromise: Promise<void> | null = null

function ensureDropboxScriptLoaded(appKey: string): Promise<void> {
  if (window.Dropbox) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.id = 'dropboxjs'
    script.setAttribute('data-app-key', appKey)
    script.src = 'https://www.dropbox.com/static/api/2/dropins.js'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('No se pudo cargar el SDK de Dropbox.'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

export async function preloadDropbox(): Promise<void> {
  const appKey = import.meta.env.VITE_DROPBOX_APP_KEY
  if (!appKey) return
  await ensureDropboxScriptLoaded(appKey)
}

interface DropboxChooserFile {
  name: string
  link: string
  bytes: number
}

export function pickDropboxFile(): Promise<PickedFile> {
  const appKey = import.meta.env.VITE_DROPBOX_APP_KEY
  if (!appKey) {
    return Promise.reject(new Error('Falta configurar VITE_DROPBOX_APP_KEY.'))
  }
  if (!window.Dropbox) {
    return Promise.reject(new Error('Dropbox todavía no terminó de cargar, intenta de nuevo en un momento.'))
  }

  return new Promise<PickedFile>((resolve, reject) => {
    window.Dropbox.choose({
      linkType: 'direct',
      multiselect: false,
      extensions: ['.mp4', '.mov', '.webm'],
      success: (files: DropboxChooserFile[]) => {
        const picked = files[0]
        logInfo(`Dropbox: archivo elegido "${picked.name}", empezando descarga…`)
        fetch(picked.link)
          .then((res) => {
            if (!res.ok) throw new Error(`No se pudo descargar el archivo de Dropbox (HTTP ${res.status}).`)
            if (!res.body) throw new Error('El navegador no soporta streaming de respuesta para este archivo.')
            resolve({
              filename: picked.name,
              contentType: res.headers.get('content-type') ?? 'application/octet-stream',
              size: picked.bytes,
              stream: res.body,
            })
          })
          .catch((err) => reject(err instanceof Error ? err : new Error('Error descargando el archivo de Dropbox.')))
      },
      cancel: () => reject(new Error('Selección cancelada.')),
    })
  })
}
