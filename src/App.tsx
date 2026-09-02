import { useCallback, useEffect, useRef, useState } from 'react'
import { AnalysisPanel } from './components/AnalysisPanel'
import { CoordenadasPanel } from './components/CoordenadasPanel'
import { SourcePicker } from './components/SourcePicker'
import { StatusBanner } from './components/StatusBanner'
import { UrlSourceModal } from './components/UrlSourceModal'
import { VideoPlayer } from './components/VideoPlayer'
import { useVideoUpload } from './hooks/useVideoUpload'
import { preloadDropbox } from './providers/dropbox'
import { preloadGoogleDrive } from './providers/googleDrive'
import { preloadOneDrive } from './providers/oneDrive'

export default function App() {
  const {
    phase,
    errorMessage,
    readUrl,
    videoId,
    startedAt,
    progress,
    elapsedMs,
    startLocalUpload,
    startProviderPick,
    startYoutubeImport,
    reset,
  } = useVideoUpload()
  const [youtubeModalOpen, setYoutubeModalOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const busy = phase === 'selecting' || phase === 'uploading' || phase === 'processing'

  // Puente entre AnalysisPanel (transcripción/momentos/evidencia, sin acceso
  // directo al <video>) y el elemento real, que vive en VideoPlayer.
  const seekTo = useCallback((seconds: number) => {
    const el = videoRef.current
    if (!el) return
    el.currentTime = seconds
    void el.play()
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // Precargamos los SDKs de los 3 proveedores al montar (no al hacer clic):
  // el popup de login debe abrirse de forma síncrona dentro del onClick, y
  // eso solo funciona si el script ya está cargado en ese momento.
  useEffect(() => {
    void preloadGoogleDrive()
    void preloadOneDrive()
    void preloadDropbox()
  }, [])

  function handleYoutubeSubmit(url: string) {
    startYoutubeImport(url)
    setYoutubeModalOpen(false)
  }

  return (
    <div className="app">
      <h1>Subir video</h1>

      <SourcePicker
        disabled={busy}
        onPickLocal={startLocalUpload}
        onPickProvider={startProviderPick}
        onPickYoutube={() => setYoutubeModalOpen(true)}
      />

      <StatusBanner
        phase={phase}
        errorMessage={errorMessage}
        startedAt={startedAt}
        progress={progress}
        elapsedMs={elapsedMs}
      />

      {phase === 'error' && (
        <button type="button" className="button button--secondary" onClick={reset}>
          Intentar de nuevo
        </button>
      )}

      {phase === 'ready' && readUrl && <VideoPlayer ref={videoRef} src={readUrl} />}
      {phase === 'ready' && videoId && <AnalysisPanel videoId={videoId} onSeek={seekTo} />}
      {phase === 'ready' && readUrl && <CoordenadasPanel videoRef={videoRef} />}

      {youtubeModalOpen && (
        <UrlSourceModal
          source="youtube"
          onCancel={() => setYoutubeModalOpen(false)}
          onSubmit={handleYoutubeSubmit}
        />
      )}
    </div>
  )
}
