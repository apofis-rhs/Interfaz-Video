import { useEffect, useState } from 'react'
import { fetchTranscripcionV3, type SegmentProsodySummaryV3 } from '../api/rawContentApiV3'
import { parseTimestampToSeconds } from '../utils/formatTimestamp'

interface Props {
  videoId: string
  onSeek: (seconds: number) => void
  // Si viene (ver AnalysisPanel.tsx -- resultado cargado a mano desde una
  // carpeta de corrida ya calificada, ver offlineResultsV3.ts), se muestra
  // ESTO en vez de pedir la transcripción en vivo al backend -- videoId
  // queda sin usar en ese caso.
  offlineItems?: SegmentProsodySummaryV3[]
}

export function TranscriptView({ videoId, onSeek, offlineItems }: Props) {
  const [items, setItems] = useState<SegmentProsodySummaryV3[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setItems(await fetchTranscripcionV3(videoId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando la transcripción.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (offlineItems) return // modo offline: nada que pedir en vivo
    void load()
    // Solo al montar/cambiar de video — actualizaciones posteriores (mientras
    // el análisis sigue corriendo) las dispara el usuario con el botón.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, offlineItems])

  const displayedItems = offlineItems ?? items

  return (
    <div className="raw-content-view">
      {!offlineItems && (
        <div className="raw-content-view__header">
          <button type="button" className="button button--secondary" onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : 'Actualizar'}
          </button>
        </div>
      )}

      {error && !offlineItems && <p className="analysis-panel__error">{error}</p>}

      {displayedItems && displayedItems.length === 0 && !loading && !error && (
        <p className="raw-content-view__empty">
          Todavía no hay transcripción disponible — empieza un análisis o espera a que avance.
        </p>
      )}

      {displayedItems && displayedItems.length > 0 && (
        <ul className="raw-content-list">
          {displayedItems.map((item, index) => (
            <li key={index} className="raw-content-list__item">
              <button
                type="button"
                className="timestamp-link"
                onClick={() => onSeek(parseTimestampToSeconds(item.inicio))}
              >
                {item.inicio}
              </button>
              <span className="raw-content-list__label">Hablante {item.speaker}:</span>
              <span className="raw-content-list__text">{item.texto}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
