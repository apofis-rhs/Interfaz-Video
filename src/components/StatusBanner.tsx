import { useEffect, useState } from 'react'
import type { UploadPhase } from '../api/types'

const LABELS: Record<Exclude<UploadPhase, 'idle'>, string> = {
  selecting: 'Elige un archivo…',
  uploading: 'Subiendo…',
  processing: 'Procesando…',
  ready: 'Listo',
  error: 'Error',
}

interface Props {
  phase: UploadPhase
  errorMessage: string | null
  startedAt: number | null
  progress: number | null
  elapsedMs: number | null
}

function useElapsedSeconds(startedAt: number | null): number {
  const [, tick] = useState(0)

  useEffect(() => {
    if (startedAt === null) return
    const interval = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(interval)
  }, [startedAt])

  if (startedAt === null) return 0
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function StatusBanner({ phase, errorMessage, startedAt, progress, elapsedMs }: Props) {
  const elapsed = useElapsedSeconds(startedAt)

  if (phase === 'idle') return null

  const showElapsed = (phase === 'uploading' || phase === 'processing') && startedAt !== null

  return (
    <div className={`status-banner status-banner--${phase}`}>
      <span className="status-banner__label">
        {LABELS[phase]}
        {showElapsed && <span className="status-banner__elapsed"> ({formatElapsed(elapsed)})</span>}
        {phase === 'ready' && elapsedMs !== null && (
          <span className="status-banner__elapsed"> — tardó {formatElapsed(Math.floor(elapsedMs / 1000))}</span>
        )}
      </span>

      {phase === 'uploading' && progress !== null && (
        <div className="status-banner__progress-track">
          <div className="status-banner__progress-fill" style={{ width: `${progress}%` }} />
          <span className="status-banner__progress-label">{progress}%</span>
        </div>
      )}

      {phase === 'error' && errorMessage && (
        <span className="status-banner__message">{errorMessage}</span>
      )}
    </div>
  )
}
