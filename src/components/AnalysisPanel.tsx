import { useState, type ChangeEvent } from 'react'
import type { EvaluatedCriterionNodeV3 } from '../api/analysisApiV3'
import { buildOfflineResult, type OfflineResultV3 } from '../api/offlineResultsV3'
import { useVideoAnalysis } from '../hooks/useVideoAnalysis'
import { formatTimestamp } from '../utils/formatTimestamp'
import { logError, logInfo } from '../utils/logger'
import { TranscriptView } from './TranscriptView'
import { VisualMomentsView } from './VisualMomentsView'

interface Props {
  videoId: string
  onSeek: (seconds: number) => void
}

type ViewTab = 'score' | 'transcript' | 'visual'

// Los 3 archivos que trae una carpeta de corrida de video_v3/test.py que
// hacen falta para reconstruir un resultado ya calificado (ver
// offlineResultsV3.ts) -- se identifican por SUBSTRING del nombre, no por
// posición/orden de selección, para que el usuario pueda seleccionar los 3
// (y de paso otros que no hacen falta, ej. transcription.json/resumen.json,
// que se ignoran) en un solo picker de archivos apuntando a la carpeta.
type RolArchivoOffline = 'evaluation_tree' | 'visuals' | 'transcripcion_es'
const ROLES_ARCHIVO_OFFLINE: RolArchivoOffline[] = ['evaluation_tree', 'visuals', 'transcripcion_es']

function detectarRolArchivoOffline(filename: string): RolArchivoOffline | null {
  const nombre = filename.toLowerCase()
  if (nombre.includes('evaluation_tree')) return 'evaluation_tree'
  if (nombre.includes('transcripcion_es')) return 'transcripcion_es'
  if (nombre.includes('visuals')) return 'visuals'
  return null
}

function ScoreTable({ criteria, onSeek }: { criteria: EvaluatedCriterionNodeV3[]; onSeek: (seconds: number) => void }) {
  return (
    <table className="analysis-panel__table">
      <thead>
        <tr>
          <th>Criterio</th>
          <th>Score</th>
          <th>Feedback / Evidencia</th>
        </tr>
      </thead>
      <tbody>
        {criteria.map((criterion) => (
          <CriterionRow key={criterion.id} criterion={criterion} depth={0} onSeek={onSeek} />
        ))}
      </tbody>
    </table>
  )
}

function validateRubricWrapper(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return 'El JSON no es un objeto.'
  }
  const rubric = (parsed as Record<string, unknown>).rubric
  if (typeof rubric !== 'object' || rubric === null) {
    return 'Falta el wrapper esperado: { "rubric": { ... } }.'
  }
  if (!('id' in rubric) || !('criteria' in rubric)) {
    return 'rubric.id y rubric.criteria son obligatorios.'
  }
  return null
}

// v3 mezcla escalas en el mismo árbol: hojas primary puntúan 0-10, nodos
// intermedios/roots 0-100, y hojas secondary no tienen score numérico (solo
// `detected`) — ver docstring de EvaluatedCriterionNodeV3.
function formatScore(criterion: EvaluatedCriterionNodeV3): string {
  const isLeaf = !criterion.children || criterion.children.length === 0
  if (isLeaf && criterion.type_criteria === 'secondary') {
    return criterion.detected ? '✓ Detectado' : '✗ No detectado'
  }
  if (criterion.score == null) return '—'
  const suffix = isLeaf ? '/10' : '/100'
  const nivel = criterion.nivel ? ` (${criterion.nivel})` : ''
  return `${criterion.score.toFixed(1)}${suffix}${nivel}`
}

function CriterionRow({
  criterion,
  depth,
  onSeek,
}: {
  criterion: EvaluatedCriterionNodeV3
  depth: number
  onSeek: (seconds: number) => void
}) {
  return (
    <>
      <tr>
        <td style={{ paddingLeft: `${depth * 1.25}rem` }}>{criterion.name}</td>
        <td>{formatScore(criterion)}</td>
        <td>
          {criterion.feedback}
          {((criterion.evidencia_visual && criterion.evidencia_visual.length > 0) ||
            (criterion.evidencia_auditiva && criterion.evidencia_auditiva.length > 0)) && (
            <ul className="evidence-list">
              {(criterion.evidencia_visual ?? []).map((ev, index) => (
                <li key={`vis-${index}`} className="evidence-list__item">
                  <button type="button" className="timestamp-link" onClick={() => onSeek(ev.inicio)}>
                    {formatTimestamp(ev.inicio)}–{formatTimestamp(ev.fin)}
                  </button>
                  <span className="evidence-list__label">Visual · {ev.id}:</span>
                  <span className="evidence-list__text">&ldquo;{ev.explicación}&rdquo;</span>
                </li>
              ))}
              {(criterion.evidencia_auditiva ?? []).map((ev, index) => (
                <li key={`aud-${index}`} className="evidence-list__item">
                  <button type="button" className="timestamp-link" onClick={() => onSeek(ev.inicio)}>
                    {formatTimestamp(ev.inicio)}–{formatTimestamp(ev.fin)}
                  </button>
                  <span className="evidence-list__label">Transcripción · {ev.id}:</span>
                  <span className="evidence-list__text">
                    &ldquo;{ev.cita_textual}&rdquo;
                    {ev.palabra_exacta ? ` (énfasis: "${ev.palabra_exacta}")` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </td>
      </tr>
      {criterion.children?.map((child) => (
        <CriterionRow key={child.id} criterion={child} depth={depth + 1} onSeek={onSeek} />
      ))}
    </>
  )
}

export function AnalysisPanel({ videoId, onSeek }: Props) {
  const { phase, result, errorMessage, startAnalysis, resetAnalysis } = useVideoAnalysis()
  const [rubric, setRubric] = useState<object | null>(null)
  const [rubricFilename, setRubricFilename] = useState<string | null>(null)
  const [rubricError, setRubricError] = useState<string | null>(null)
  const [tab, setTab] = useState<ViewTab>('score')

  // Resultado ya calificado, cargado a mano desde una carpeta de corrida de
  // video_v3/test.py -- ver offlineResultsV3.ts. Mientras esté cargado,
  // reemplaza al análisis en vivo en los 3 tabs (Score/Transcripción/
  // Momentos visuales), SIN tocar el video ni disparar ningún análisis
  // nuevo -- es una fuente de datos alternativa, client-side, mismo
  // criterio que ya usa CoordenadasPanel.tsx con su propio JSON.
  const [offlineResult, setOfflineResult] = useState<OfflineResultV3 | null>(null)
  const [offlineFilenames, setOfflineFilenames] = useState<string[] | null>(null)
  const [offlineError, setOfflineError] = useState<string | null>(null)

  function clearOfflineResult() {
    setOfflineResult(null)
    setOfflineFilenames(null)
    setOfflineError(null)
  }

  async function handleOfflineFilesChange(event: ChangeEvent<HTMLInputElement>) {
    // BUG encontrado 2026-08-17: `event.target.files` es el contenedor
    // FileList EN VIVO del input -- resetear `event.target.value = ''`
    // (para poder re-seleccionar la misma carpeta después) VACÍA ESE MISMO
    // contenedor, así que guardar una referencia a `event.target.files` y
    // leerla DESPUÉS del reset da length=0, aunque se haya "guardado" antes
    // (confirmado con los logs: length=3 arriba, length=0 dos líneas después
    // con la versión vieja de este handler). El resto de la app
    // (handleRubricChange/CoordenadasPanel) nunca pisó esto porque extraen
    // UN File individual (`files?.[0]`) -- un File es independiente de su
    // FileList padre y sobrevive el reset; acá hace falta lo mismo pero para
    // varios, así que se extraen TODOS los File a un array plano ANTES de
    // resetear `.value`.
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) {
      logInfo('AnalysisPanel: 0 archivo(s) en la selección (diálogo cancelado, o el picker no devolvió nada) -- nada que cargar.')
      return
    }

    logInfo(`AnalysisPanel: ${files.length} archivo(s) seleccionado(s) para carga offline: ${files.map((f) => f.name).join(', ')}`)

    // TODO el resto del handler va en un único try/catch -- antes,
    // buildOfflineResult() se llamaba SIN try/catch: si tiraba una excepción
    // (shape inesperado de alguna corrida) el handler se rompía en silencio
    // (promesa rechazada sin catch en React) y no tocaba ningún estado --
    // el bug real detrás de "no carga nada, sin mensaje" reportado en la
    // sesión del 2026-08-17. Ahora CUALQUIER falla, esperada o no, termina
    // en offlineError (visible) + logError (detalle completo en consola).
    try {
      const crudos: Partial<Record<RolArchivoOffline, unknown>> = {}
      const nombres: Partial<Record<RolArchivoOffline, string>> = {}
      for (const file of files) {
        const rol = detectarRolArchivoOffline(file.name)
        if (!rol) continue // se ignora cualquier archivo que no matchee (ej. transcription.json, resumen.json)
        try {
          crudos[rol] = JSON.parse(await file.text())
          nombres[rol] = file.name
        } catch (exc) {
          throw new Error(`"${file.name}" no es un JSON válido: ${exc instanceof Error ? exc.message : String(exc)}`)
        }
      }

      const faltantes = ROLES_ARCHIVO_OFFLINE.filter((rol) => !(rol in crudos))
      if (faltantes.length > 0) {
        throw new Error(
          `Faltan archivo(s) de la carpeta de corrida: ${faltantes.map((r) => `${r}.json`).join(', ')} -- ` +
            `seleccionaste ${files.length} archivo(s) (${files.map((f) => f.name).join(', ')}) -- ` +
            'seleccioná los 3 juntos (evaluation_tree.json, visuals.json, transcripcion_es.json).',
        )
      }

      const { result: parsed, error } = buildOfflineResult(crudos.evaluation_tree, crudos.visuals, crudos.transcripcion_es)
      if (error || !parsed) {
        throw new Error(error ?? 'No se pudo interpretar el resultado cargado.')
      }

      setOfflineError(null)
      setOfflineResult(parsed)
      const nombresCargados = ROLES_ARCHIVO_OFFLINE.map((rol) => nombres[rol]).filter((n): n is string => !!n)
      setOfflineFilenames(nombresCargados)
      logInfo(
        `AnalysisPanel: resultado offline cargado (${nombresCargados.join(', ')}) -- video_id=${parsed.tree.video_id}, ` +
          `total_score=${parsed.tree.total_score}, ${parsed.tree.criteria.length} criterio(s) raíz, ` +
          `${parsed.transcript.length} segmento(s) de transcripción, ${parsed.visualMoments.momentos_visuales.length} momento(s) visuales.`,
      )
    } catch (exc) {
      const mensaje = exc instanceof Error ? exc.message : String(exc)
      logError('AnalysisPanel: falló la carga de resultado offline.', exc)
      setOfflineError(mensaje)
      setOfflineResult(null)
      setOfflineFilenames(null)
    }
  }

  async function handleRubricChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setRubric(null)
      setRubricFilename(null)
      setRubricError(`"${file.name}" no es un JSON válido.`)
      return
    }

    const wrapperError = validateRubricWrapper(parsed)
    if (wrapperError) {
      setRubric(null)
      setRubricFilename(null)
      setRubricError(wrapperError)
      return
    }

    setRubricError(null)
    setRubric(parsed as object)
    setRubricFilename(file.name)
  }

  const running = phase === 'running'

  return (
    <div className="analysis-panel">
      <h2>Análisis rubricado</h2>

      <div className="analysis-panel__actions">
        <label className={`button button--source${running ? ' button--disabled' : ''}`}>
          {rubricFilename ? `JSON: ${rubricFilename}` : 'Agregar JSON'}
          <input
            type="file"
            accept="application/json,.json"
            onChange={handleRubricChange}
            disabled={running}
            hidden
          />
        </label>

        <button
          type="button"
          className="button button--primary"
          disabled={!rubric || running || !!offlineResult}
          title={offlineResult ? 'Quitá el resultado cargado para poder iniciar un análisis en vivo.' : undefined}
          onClick={() => rubric && startAnalysis(videoId, rubric)}
        >
          Empezar análisis
        </button>
      </div>

      {rubricError && <p className="analysis-panel__error">{rubricError}</p>}

      <div className="analysis-panel__offline">
        <p className="analysis-panel__feedback">
          ¿Este video ya fue calificado antes? Cargá su carpeta de corrida (evaluation_tree.json + visuals.json +
          transcripcion_es.json, ver video_v3/test.py) para ver el score/transcripción/momentos visuales sin volver a
          analizar.
        </p>
        <div className="analysis-panel__actions">
          <label className={`button button--source${running ? ' button--disabled' : ''}`}>
            {offlineFilenames ? `Cargados: ${offlineFilenames.join(', ')}` : 'Cargar carpeta de resultado ya calificado'}
            <input
              type="file"
              accept="application/json,.json"
              multiple
              onChange={handleOfflineFilesChange}
              disabled={running}
              hidden
            />
          </label>
          {offlineResult && (
            <button type="button" className="button button--secondary" onClick={clearOfflineResult}>
              Quitar resultado cargado (volver a análisis en vivo)
            </button>
          )}
        </div>
        {offlineError && <p className="analysis-panel__error">{offlineError}</p>}
      </div>

      <div className="analysis-panel__tabs">
        <button
          type="button"
          className={`button button--secondary${tab === 'score' ? ' button--active' : ''}`}
          onClick={() => setTab('score')}
        >
          Score
        </button>
        <button
          type="button"
          className={`button button--secondary${tab === 'transcript' ? ' button--active' : ''}`}
          onClick={() => setTab('transcript')}
        >
          Transcripción
        </button>
        <button
          type="button"
          className={`button button--secondary${tab === 'visual' ? ' button--active' : ''}`}
          onClick={() => setTab('visual')}
        >
          Momentos visuales
        </button>
      </div>

      {tab === 'score' && (
        <>
          {offlineResult ? (
            <>
              <div className="status-banner status-banner--ready">
                <span className="status-banner__label">
                  Resultado cargado desde archivo — puntaje total: {(offlineResult.tree.total_score ?? 0).toFixed(1)}/100
                </span>
              </div>
              <ScoreTable criteria={offlineResult.tree.criteria} onSeek={onSeek} />
            </>
          ) : (
            <>
              {running && (
                <div className="status-banner status-banner--processing">
                  <span className="status-banner__label">Analizando…</span>
                </div>
              )}

              {phase === 'failed' && (
                <>
                  <div className="status-banner status-banner--error">
                    <span className="status-banner__label">Error</span>
                    {errorMessage && <span className="status-banner__message">{errorMessage}</span>}
                  </div>
                  <button type="button" className="button button--secondary" onClick={resetAnalysis}>
                    Intentar de nuevo
                  </button>
                </>
              )}

              {phase === 'completed' && result && (
                <>
                  <div className="status-banner status-banner--ready">
                    <span className="status-banner__label">
                      Análisis completado — puntaje total: {(result.total_score ?? 0).toFixed(1)}/100
                    </span>
                  </div>
                  <ScoreTable criteria={result.criteria} onSeek={onSeek} />
                </>
              )}

              {phase === 'idle' && (
                <p className="raw-content-view__empty">Adjunta una rúbrica y empieza el análisis para ver el score.</p>
              )}
            </>
          )}
        </>
      )}

      {tab === 'transcript' && <TranscriptView videoId={videoId} onSeek={onSeek} offlineItems={offlineResult?.transcript} />}
      {tab === 'visual' && <VisualMomentsView videoId={videoId} onSeek={onSeek} offlineData={offlineResult?.visualMoments} />}
    </div>
  )
}
