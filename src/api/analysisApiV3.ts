import { API_BASE_URL } from './config'

// Calcado de app/services/video_v3/analysis_api/router.py y del árbol que
// arma tree_reconstruction.py (FinalEvaluationTree / EvaluatedCriterionNode),
// verificado directamente contra el código del backend (2026-08-06, tras el
// split de evidencia visual/auditiva + resolución de timestamps reales en
// Fase 4 + merged_timeline).
//
// Diferencias de contrato frente a analysisApiV2 (no es solo un rename):
// - No hay `general_feedback` ni `call_incomplete`/`is_off_topic` — v3 no
//   sintetiza un feedback general, solo el árbol de criterios.
// - `score` es 0-10 en hojas primary, 0-100 en nodos intermedios/roots
//   (mezclados en el mismo árbol), y `null` en hojas secondary — ahí lo que
//   importa es `detected`, no un número.
// - La evidencia de cada nodo viene en DOS listas separadas por modalidad
//   (`evidencia_visual`/`evidencia_auditiva`, nunca una sola `evidence`
//   mixta) — cada entrada ya trae `chunk_number` + `inicio`/`fin` REALES en
//   segundos (resueltos en Fase 4 contra merged_timeline), no solo un id de
//   referencia como en versiones anteriores de este contrato.
// - GET /analisis/{id} devuelve `resultado` como VideoV3Result completo
//   (transcript + subjects + momentos_visuales + evaluation_tree +
//   merged_timeline + time_elapsed_seconds), NO el árbol directamente — el
//   árbol de criterios vive en `resultado.evaluation_tree`.

export type AnalysisStatusV3 = 'running' | 'done' | 'error' | 'not_found'

export interface StartAnalysisV3Response {
  video_id: string
  status: 'analysis_started'
}

export type TierCriterioV3 = 'EXC' | 'BUE' | 'REG' | 'BAJ' | 'NULO'
export type LongitudEvidenciaV3 = 'seccion' | 'momento' | 'palabra'

// Ver tree_reconstruction_schemas.py::EvidenciaVisualResuelta. `id` se
// conserva aunque inicio/fin ya estén resueltos -- sirve para re-resolver
// la cita contra VideoV3Result.merged_timeline si hace falta (nunca contra
// VideoV3Result.momentos_visuales, que usa un esquema de id distinto).
export interface EvidenciaVisualResueltaV3 {
  chunk_number: number
  id: string
  inicio: number
  fin: number
  explicación: string
}

// Ver tree_reconstruction_schemas.py::EvidenciaAuditivaResuelta. inicio/fin
// pueden venir angostados a la palabra/frase exacta (ver palabra_exacta)
// en vez del segmento de transcripción completo.
export interface EvidenciaAuditivaResueltaV3 {
  chunk_number: number
  id: string
  inicio: number
  fin: number
  cita_textual: string
  palabra_exacta: string | null
  longitud_evidencia: LongitudEvidenciaV3
}

export interface EvaluatedCriterionNodeV3 {
  id: string
  name: string
  type_criteria: 'primary' | 'secondary'
  weight: number
  score: number | null
  nivel: TierCriterioV3 | null
  detected: boolean | null
  feedback: string | null
  evidencia_visual: EvidenciaVisualResueltaV3[] | null
  evidencia_auditiva: EvidenciaAuditivaResueltaV3[] | null
  children?: EvaluatedCriterionNodeV3[] | null
}

export interface FinalEvaluationTreeV3 {
  video_id: string
  total_score: number | null
  criteria: EvaluatedCriterionNodeV3[]
}

// Ver audio_assemblyai_schemas.py::ProsodySummary/SegmentProsodySummary.
export interface ProsodySummaryV3 {
  pace: string
  pauses: string
  clarity: string
  pitch_variation: string
  loudness: string
  voice_quality: string
  emphasis: string
  emotion: string
}

export interface SegmentProsodySummaryV3 {
  speaker: string
  texto: string
  inicio: string // MM:SS
  fin: string // MM:SS
  duracion_s: number
  prosody_summary: ProsodySummaryV3
}

// Ver feedback_scorer_schemas.py::CambiosApariencia/Sujeto/MomentosVisuales/
// ChunkTranscriptSegment.
export interface CambiosAparienciaV3 {
  momento_aproximado: string // MM:SS
  descripcion: string
}

export interface SujetoV3 {
  sujeto_id: string
  nombre: string | null
  descripcion_apariencia: string
  cambios_apariencia: CambiosAparienciaV3[]
}

// Mismo shape para el momento visual GLOBAL (VideoV3Result.momentos_visuales,
// ids de 4 dígitos) y el CHUNK-SCOPED (MergedTimelineChunkFinal.momentos_visuales,
// ids de 2 dígitos) -- es la misma clase Pydantic del lado del backend, solo
// cambia el espacio de ids según en qué lista aparece (ver docstring de
// VideoV3Result.merged_timeline).
export interface MomentoVisualUnionV3 {
  id: string
  sujeto_id: string
  tipo_foco: string
  talking: boolean
  inicio: number // segundos absolutos, ya remapeados
  fin: number
  descripcion: string
}

// Ver feedback_scorer_schemas.py::ChunkTranscriptSegment (words excluido de
// la serialización -- uso interno del backend para angostar evidencia).
export interface ChunkTranscriptSegmentV3 {
  id: string
  speaker_id: string
  inicio: number
  fin: number
  texto: string
}

// Ver feedback_scorer_schemas.py::MergedTimelineChunkFinal. El companion
// object que resuelve evidencia_visual/evidencia_auditiva a un segmento
// real: buscar el chunk cuyo chunk_number coincida, y dentro de él, el
// elemento de momentos_visuales o audio_segments cuyo id coincida.
export interface MergedTimelineChunkFinalV3 {
  chunk_number: number
  primary_speaker_id: string
  primary_subject_id: string | null
  nombre_sujeto_primario: string | null
  subjects: SujetoV3[]
  momentos_visuales: MomentoVisualUnionV3[]
  audio_segments: ChunkTranscriptSegmentV3[]
}

// Ver evaluation_adapters.py::VideoV3Result.
export interface VideoV3Result {
  video_id: string
  transcript: SegmentProsodySummaryV3[]
  subjects: SujetoV3[]
  momentos_visuales: MomentoVisualUnionV3[]
  evaluation_tree: FinalEvaluationTreeV3
  // Puede tener huecos (chunks descartados por no útiles) -- NO indexar por
  // posición/chunk_number, buscar por .chunk_number.
  merged_timeline: MergedTimelineChunkFinalV3[]
  time_elapsed_seconds: number
}

export interface AnalysisStatusV3Response {
  video_id: string
  status: AnalysisStatusV3
  resultado?: VideoV3Result | null
  error?: string | null
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') return data.detail
    return JSON.stringify(data)
  } catch {
    return res.statusText || `Error ${res.status}`
  }
}

export async function startAnalysisV3(videoId: string, rubric: object): Promise<StartAnalysisV3Response> {
  const res = await fetch(`${API_BASE_URL}/api/v3/video/iniciar-analisis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, rubric }),
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export async function fetchAnalysisStatusV3(videoId: string): Promise<AnalysisStatusV3Response> {
  const res = await fetch(`${API_BASE_URL}/api/v3/video/analisis/${videoId}`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}
