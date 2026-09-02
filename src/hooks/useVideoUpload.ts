import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createLocalSession,
  fetchVideoStatus,
  startYoutubeImport as startYoutubeImportRequest,
  uploadBlobWithProgress,
  uploadStreamWithProgress,
} from '../api/uploadApi'
import type { BackendStatus, ProviderSource, UploadPhase } from '../api/types'
import { pickDropboxFile } from '../providers/dropbox'
import { pickGoogleDriveFile } from '../providers/googleDrive'
import { pickOneDriveFile } from '../providers/oneDrive'
import type { PickedFile } from '../providers/types'
import { formatBytes, formatElapsed, logError, logInfo } from '../utils/logger'
import { resolveVideoContentType } from '../utils/videoContentType'

const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 10 * 60 * 1000

const PROVIDER_PICKERS: Record<ProviderSource, () => Promise<PickedFile>> = {
  google_drive: pickGoogleDriveFile,
  onedrive: pickOneDriveFile,
  dropbox: pickDropboxFile,
}

const PROVIDER_LABELS: Record<ProviderSource, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
}

function mapBackendStatus(status: BackendStatus): UploadPhase {
  if (status === 'uploading' || status === 'downloading') return 'uploading'
  if (status === 'processing') return 'processing'
  if (status === 'ready') return 'ready'
  return 'error'
}

interface State {
  phase: UploadPhase
  errorMessage: string | null
  readUrl: string | null
  videoId: string | null
  startedAt: number | null
  progress: number | null // 0-100, solo durante 'uploading'
  elapsedMs: number | null // tiempo total congelado una vez llega a 'ready'
}

const initialState: State = {
  phase: 'idle',
  errorMessage: null,
  readUrl: null,
  videoId: null,
  startedAt: null,
  progress: null,
  elapsedMs: null,
}

export function useVideoUpload() {
  const [state, setState] = useState<State>(initialState)
  const pollTimerRef = useRef<number | null>(null)
  const pollDeadlineRef = useRef<number>(0)
  const lastLoggedPctRef = useRef<number>(-1)
  // Se incrementa cada vez que se detiene o reinicia el polling. Cada ciclo
  // de "tick" guarda con qué número arrancó y lo compara antes de actuar —
  // así una respuesta que llega tarde (después de haber parado o de haber
  // arrancado un poll nuevo) se descarta en vez de seguir disparando.
  const pollGenerationRef = useRef(0)

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const fail = useCallback(
    (message: string) => {
      logError(message)
      stopPolling()
      setState({
        phase: 'error',
        errorMessage: message,
        readUrl: null,
        videoId: null,
        startedAt: null,
        progress: null,
        elapsedMs: null,
      })
    },
    [stopPolling],
  )

  // setTimeout auto-programado en vez de setInterval: la siguiente consulta
  // solo se agenda DESPUÉS de que la anterior termina por completo. Con
  // setInterval, si fetchVideoStatus alguna vez tarda más que
  // POLL_INTERVAL_MS (típico justo después de una subida grande, con la red
  // todavía ocupada), pueden quedar varias llamadas superpuestas "en
  // vuelo" — cada una detecta 'ready' por su cuenta y sigue reportándolo
  // aunque ya se haya parado el polling "oficial" (bug real, visto en
  // producción: "Video listo." repetido ~20 veces tras una subida de 958 MB).
  const pollStatus = useCallback(
    (videoId: string) => {
      logInfo(`Consultando estado cada ${POLL_INTERVAL_MS / 1000}s (video_id=${videoId})…`)
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS
      stopPolling()
      const generation = pollGenerationRef.current

      const tick = async () => {
        if (pollGenerationRef.current !== generation) return // se detuvo o empezó otro poll

        if (Date.now() > pollDeadlineRef.current) {
          fail('Tiempo de espera agotado esperando el video.')
          return
        }
        try {
          const status = await fetchVideoStatus(videoId)
          if (pollGenerationRef.current !== generation) return // respuesta tardía, ya no aplica

          if (status.status === 'error') {
            fail(status.error_message || 'El backend reportó un error procesando el video.')
            return
          }
          if (status.status === 'ready') {
            stopPolling()
            if (!status.read_url) {
              fail('El backend marcó el video como listo pero no envió read_url.')
              return
            }
            let elapsedMs: number | null = null
            setState((prev) => {
              elapsedMs = prev.startedAt ? Date.now() - prev.startedAt : null
              return {
                ...prev,
                phase: 'ready',
                errorMessage: null,
                readUrl: status.read_url ?? null,
                startedAt: null,
                progress: null,
                elapsedMs,
              }
            })
            logInfo(`Video listo${elapsedMs !== null ? ` — tardó ${formatElapsed(elapsedMs)}` : ''}.`)
            return
          }
          const newPhase = mapBackendStatus(status.status)
          setState((prev) => (prev.phase === newPhase ? prev : { ...prev, phase: newPhase }))
          pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
        } catch (err) {
          if (pollGenerationRef.current !== generation) return
          fail(err instanceof Error ? err.message : 'Error consultando el estado del video.')
        }
      }

      void tick()
    },
    [fail, stopPolling],
  )

  // Camino compartido por Local, Google Drive, OneDrive y Dropbox. Local
  // manda un Blob (el archivo ya está completo en el navegador, progreso vía
  // XMLHttpRequest); los 3 proveedores mandan un ReadableStream encadenado
  // directo desde su propia descarga (progreso vía TransformStream) — la
  // descarga y el PUT a GCS corren en paralelo en vez de bufferear el
  // archivo completo antes de empezar a subirlo.
  //
  // El timer (startedAt) arranca ACÁ, no en el clic del botón — para
  // Drive/OneDrive/Dropbox el picker (login + elegir archivo) es un paso
  // previo con duración controlada por el usuario, no por la subida en sí.
  // Si el timer arrancara antes, un archivo elegido rápido pero subido
  // lento se vería igual que uno elegido lento pero subido rápido.
  const uploadToGcs = useCallback(
    async (filename: string, contentTypeHint: string, size: number, body: Blob | ReadableStream<Uint8Array>) => {
      const contentType = resolveVideoContentType(filename, contentTypeHint)
      if (!contentType) {
        fail(`"${filename}" no es un video soportado (mp4, mov o webm).`)
        return
      }

      logInfo(`Archivo elegido: "${filename}" (${formatBytes(size)}, ${contentType}).`)

      const videoId = crypto.randomUUID()
      setState((prev) => ({ ...prev, phase: 'uploading', videoId, startedAt: Date.now(), progress: null }))

      const onProgress = (uploaded: number, total: number) => {
        const pct = total > 0 ? Math.min(100, Math.round((uploaded / total) * 100)) : null
        setState((prev) => (prev.progress === pct ? prev : { ...prev, progress: pct }))
        if (pct !== null && pct >= lastLoggedPctRef.current + 10) {
          lastLoggedPctRef.current = pct
          logInfo(`Subiendo… ${pct}% (${formatBytes(uploaded)} / ${formatBytes(total)})`)
        }
      }

      try {
        lastLoggedPctRef.current = -1
        logInfo('Creando sesión de subida resumible en GCS…')
        const session = await createLocalSession(filename, contentType, size, videoId)
        logInfo(`Sesión creada, subiendo a ${session.gcs_uri}…`)

        if (body instanceof Blob) {
          await uploadBlobWithProgress(session.upload_session_url, body, contentType, onProgress)
        } else {
          await uploadStreamWithProgress(session.upload_session_url, body, contentType, size, onProgress)
        }

        logInfo('Subida a GCS completa, esperando confirmación del backend…')
        setState((prev) => ({ ...prev, phase: 'processing', progress: null }))
        pollStatus(videoId)
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Error subiendo el archivo.')
      }
    },
    [fail, pollStatus],
  )

  // Reset común al arrancar un intento nuevo. Deliberadamente sin
  // startedAt: cada camino lo setea recién cuando la transferencia real
  // empieza (ver comentario en uploadToGcs).
  const resetForNewAttempt = useCallback(
    (phase: 'selecting' | 'uploading') => {
      stopPolling()
      setState({
        phase,
        errorMessage: null,
        readUrl: null,
        videoId: null,
        startedAt: null,
        progress: null,
        elapsedMs: null,
      })
    },
    [stopPolling],
  )

  const startLocalUpload = useCallback(
    (file: File) => {
      logInfo('Origen: Local.')
      // No hay picker que esperar: el archivo ya viene elegido (el <input
      // type=file> nativo ya se cerró), así que pasa directo a 'uploading'.
      resetForNewAttempt('uploading')
      void uploadToGcs(file.name, file.type, file.size, file)
    },
    [resetForNewAttempt, uploadToGcs],
  )

  const startProviderPick = useCallback(
    (source: ProviderSource) => {
      logInfo(`Origen: ${PROVIDER_LABELS[source]}. Abriendo selector…`)
      // 'selecting': sin timer visible mientras el usuario inicia sesión y
      // navega el picker — ese tiempo lo controla el usuario, no la red.
      resetForNewAttempt('selecting')
      PROVIDER_PICKERS[source]()
        .then((picked) => uploadToGcs(picked.filename, picked.contentType, picked.size, picked.stream))
        .catch((err) => fail(err instanceof Error ? err.message : 'Error eligiendo el archivo.'))
    },
    [fail, resetForNewAttempt, uploadToGcs],
  )

  const startYoutubeImport = useCallback(
    async (url: string) => {
      logInfo(`Origen: YouTube (${url}).`)
      // Sin picker externo que esperar (la URL ya se escribió en nuestro
      // propio modal), así que el timer sí arranca ya en 'uploading'.
      resetForNewAttempt('uploading')
      const videoId = crypto.randomUUID()
      setState((prev) => ({ ...prev, videoId, startedAt: Date.now() }))
      try {
        logInfo('Encolando descarga en el backend…')
        await startYoutubeImportRequest(url, videoId)
        setState((prev) => ({ ...prev, phase: 'processing' }))
        pollStatus(videoId)
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Error iniciando la importación.')
      }
    },
    [fail, pollStatus, resetForNewAttempt],
  )

  const reset = useCallback(() => {
    stopPolling()
    setState(initialState)
  }, [stopPolling])

  return { ...state, startLocalUpload, startProviderPick, startYoutubeImport, reset }
}
