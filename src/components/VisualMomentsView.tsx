import { useEffect, useState } from 'react'
import {
  fetchMomentosVisualesV3,
  type MomentoVisualUnionV3,
  type MomentosVisualesResponseV3,
} from '../api/rawContentApiV3'
import { formatTimestamp } from '../utils/formatTimestamp'

interface Props {
  videoId: string
  onSeek: (seconds: number) => void
  // Si viene (ver AnalysisPanel.tsx -- resultado cargado a mano desde una
  // carpeta de corrida ya calificada, ver offlineResultsV3.ts), se muestra
  // ESTO en vez de pedir los momentos visuales en vivo al backend -- videoId
  // queda sin usar en ese caso.
  offlineData?: MomentosVisualesResponseV3
}

const TIPO_FOCO_LABELS: Record<string, string> = {
  persona: 'Persona',
  objeto: 'Objeto',
  animal: 'Animal',
  escena: 'Escena',
}

// tipo_foco llega como string suelto desde el backend (ver
// feedback_scorer_schemas.py::MomentosVisuales) — a diferencia del enum
// estricto de 4 valores de la etapa de análisis por chunk, así que el label
// cae al valor crudo si no lo reconoce, en vez de romper.
function tipoFocoLabel(tipoFoco: string): string {
  return TIPO_FOCO_LABELS[tipoFoco] ?? tipoFoco
}

// nombre es null hasta que se identifica al sujeto — mismo placeholder que
// ya usa el backend para este caso (ver audio_video_merge.py).
function sujetoLabel(sujetoId: string, subjects: MomentosVisualesResponseV3['subjects']): string {
  const sujeto = subjects.find((s) => s.sujeto_id === sujetoId)
  return sujeto?.nombre ?? `Sujeto ${sujetoId} (sin nombre)`
}

export function VisualMomentsView({ videoId, onSeek, offlineData }: Props) {
  const [data, setData] = useState<MomentosVisualesResponseV3 | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setData(await fetchMomentosVisualesV3(videoId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando los momentos visuales.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (offlineData) return // modo offline: nada que pedir en vivo
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, offlineData])

  const displayedData = offlineData ?? data
  const items: MomentoVisualUnionV3[] = displayedData?.momentos_visuales ?? []

  return (
    <div className="raw-content-view">
      {!offlineData && (
        <div className="raw-content-view__header">
          <button type="button" className="button button--secondary" onClick={load} disabled={loading}>
            {loading ? 'Cargando…' : 'Actualizar'}
          </button>
        </div>
      )}

      {error && !offlineData && <p className="analysis-panel__error">{error}</p>}

      {displayedData && items.length === 0 && !loading && !error && (
        <p className="raw-content-view__empty">
          Todavía no hay momentos visuales disponibles — empieza un análisis o espera a que avance.
        </p>
      )}

      {items.length > 0 && (
        <ul className="raw-content-list">
          {items.map((item) => (
            <li key={item.id} className="raw-content-list__item">
              <button type="button" className="timestamp-link" onClick={() => onSeek(item.inicio)}>
                {formatTimestamp(item.inicio)}–{formatTimestamp(item.fin)}
              </button>
              <span className="raw-content-list__label">
                {tipoFocoLabel(item.tipo_foco)} · {sujetoLabel(item.sujeto_id, displayedData!.subjects)}
                {item.talking ? ' (hablando)' : ''}:
              </span>
              <span className="raw-content-list__text">{item.descripcion}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
