import { parseTimestampToSeconds } from '../utils/formatTimestamp'
import type {
  EvaluatedCriterionNodeV3,
  EvidenciaAuditivaResueltaV3,
  EvidenciaVisualResueltaV3,
  FinalEvaluationTreeV3,
  SegmentProsodySummaryV3,
  TierCriterioV3,
} from './analysisApiV3'
import type { MomentosVisualesResponseV3 } from './rawContentApiV3'

// Adaptador para reutilizar una corrida YA calificada del pipeline manual
// (app/services/video_v3/test.py, ver evaluation_tree.json/visuals.json/
// transcripcion_es.json en su carpeta de salida) sin pasar por el backend
// en vivo (/api/v3/video/iniciar-analisis, que dispara un análisis nuevo).
// Todo client-side: recibe los 3 JSON ya parseados (subidos a mano por el
// usuario) y arma el MISMO shape que ya consume AnalysisPanel/TranscriptView/
// VisualMomentsView cuando vienen del backend en vivo.
//
// Por qué hace falta cruzar 3 archivos y no basta con evaluation_tree.json:
// CriterioScoringNode.evidencia_visual/evidencia_auditiva (ver
// criterio_scoring/schemas.py::EvidenciaVisualCriterioGlobal/
// EvidenciaAuditivaCriterioGlobal) solo trae {id, explicación/cita_textual}
// -- una REFERENCIA al momento visual/segmento de audio citado, sin
// inicio/fin reales. En el pipeline viejo de producción esa resolución
// (id -> segundos reales) la hacía tree_reconstruction.py del lado del
// backend (ver chunk_number/inicio/fin YA resueltos en
// EvaluatedCriterionNodeV3); acá se hace del lado del cliente, cruzando el
// `id` contra visuals.json (evidencia_visual) / transcripcion_es.json
// (evidencia_auditiva) -- MISMO espacio de ids global entero en los 3
// archivos (nunca chunk-scoped), así que el cruce es un lookup directo por
// id, sin necesidad de merged_timeline.

export interface OfflineResultV3 {
  tree: FinalEvaluationTreeV3
  transcript: SegmentProsodySummaryV3[]
  visualMoments: MomentosVisualesResponseV3
}

// ── Shapes crudos tal como los escriben video_v3/test.py (evaluation_tree.json
// vía CriterioScoringResult/CriterioScoringNode) y
// cargar_coordenadas/test_coordenadas.py (visuals.json, mismo shape que
// orden_contiguidad/test.py) -- SIN validar con una librería, a mano, mismo
// criterio "chico y explícito" que ya usa CoordenadasPanel.tsx.parseGroundingJson. ──

interface EvidenciaVisualCruda {
  id: number
  explicación: string
}

interface EvidenciaAuditivaCruda {
  id: number
  longitud_evidencia: 'seccion' | 'momento' | 'palabra'
  cita_textual: string
  palabra_exacta: string | null
}

interface CriterioScoringNodeCrudo {
  id: string
  name: string
  type_criteria: 'primary' | 'secondary'
  weight: number
  score: number | null
  nivel: TierCriterioV3 | null
  detected: boolean | null
  feedback: string | null
  evidencia_visual: EvidenciaVisualCruda[] | null
  evidencia_auditiva: EvidenciaAuditivaCruda[] | null
  children: CriterioScoringNodeCrudo[] | null
}

interface CriterioScoringResultCrudo {
  video_id: string
  total_score: number | null
  criteria: CriterioScoringNodeCrudo[]
}

interface VisualMomentoCrudo {
  id: number
  sujeto_id: string
  tipo_foco: string
  talking: boolean
  inicio: number
  fin: number
  descripcion: string
}

interface ResumenProsodicoCrudo {
  ritmo: string
  pausas: string
  claridad: string
  variacion_tono: string
  volumen: string
  calidad_voz: string
  enfasis: string
  emocion: string
  // `muletillas` también viene en transcripcion_es.json pero
  // ProsodySummaryV3 no tiene campo equivalente (ver analysisApiV3.ts) --
  // se ignora acá, no se muestra en ningún lado del contrato actual.
}

interface TranscripcionEsCruda {
  id: number
  speaker: string
  texto: string
  inicio: string // "MM:SS"
  fin: string // "MM:SS"
  duracion_s: number
  resumen_prosodico: ResumenProsodicoCrudo
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validarEvaluationTree(raw: unknown): { data: CriterioScoringResultCrudo | null; error: string | null } {
  if (!isRecord(raw)) return { data: null, error: 'evaluation_tree.json no es un objeto.' }
  if (typeof raw.video_id !== 'string' || !Array.isArray(raw.criteria)) {
    return { data: null, error: 'evaluation_tree.json no tiene el shape esperado ({ video_id, total_score, criteria: [...] }).' }
  }
  return { data: raw as unknown as CriterioScoringResultCrudo, error: null }
}

function validarVisuals(raw: unknown): { data: VisualMomentoCrudo[] | null; error: string | null } {
  if (!Array.isArray(raw)) return { data: null, error: 'visuals.json no es un array.' }
  return { data: raw as VisualMomentoCrudo[], error: null }
}

function validarTranscripcion(raw: unknown): { data: TranscripcionEsCruda[] | null; error: string | null } {
  if (!Array.isArray(raw)) return { data: null, error: 'transcripcion_es.json no es un array.' }
  return { data: raw as TranscripcionEsCruda[], error: null }
}

// Resuelve evidencia_visual/evidencia_auditiva de UN nodo (crudo, sin
// inicio/fin) a la forma YA resuelta que espera CriterionRow (ver
// AnalysisPanel.tsx) -- id no encontrado en el archivo cruzado (no debería
// pasar contra una corrida consistente, pero un JSON armado/editado a mano
// podría desalinearse) cae a inicio=fin=0 en vez de lanzar, mismo criterio
// "no forzar match, pero tampoco romper toda la carga por una sola
// referencia colgada" que ya usa CoordenadasPanel.
function resolverNodo(
  nodo: CriterioScoringNodeCrudo,
  visualesPorId: Map<number, VisualMomentoCrudo>,
  transcripcionPorId: Map<number, TranscripcionEsCruda>,
): EvaluatedCriterionNodeV3 {
  const evidenciaVisual: EvidenciaVisualResueltaV3[] | null =
    nodo.evidencia_visual?.map((ev) => {
      const momento = visualesPorId.get(ev.id)
      return {
        // El pipeline nuevo (video_v3/test.py) no tiene noción de "chunk" --
        // campo solo por compatibilidad de tipo con EvidenciaVisualResueltaV3
        // (viene del pipeline VIEJO), CriterionRow nunca lo renderiza.
        chunk_number: 0,
        id: String(ev.id),
        inicio: momento?.inicio ?? 0,
        fin: momento?.fin ?? 0,
        explicación: ev.explicación,
      }
    }) ?? null

  const evidenciaAuditiva: EvidenciaAuditivaResueltaV3[] | null =
    nodo.evidencia_auditiva?.map((ev) => {
      const segmento = transcripcionPorId.get(ev.id)
      return {
        chunk_number: 0,
        id: String(ev.id),
        inicio: segmento ? parseTimestampToSeconds(segmento.inicio) : 0,
        fin: segmento ? parseTimestampToSeconds(segmento.fin) : 0,
        cita_textual: ev.cita_textual,
        palabra_exacta: ev.palabra_exacta,
        longitud_evidencia: ev.longitud_evidencia,
      }
    }) ?? null

  return {
    id: nodo.id,
    name: nodo.name,
    type_criteria: nodo.type_criteria,
    weight: nodo.weight,
    score: nodo.score,
    nivel: nodo.nivel,
    detected: nodo.detected,
    feedback: nodo.feedback,
    evidencia_visual: evidenciaVisual,
    evidencia_auditiva: evidenciaAuditiva,
    children: nodo.children?.map((hijo) => resolverNodo(hijo, visualesPorId, transcripcionPorId)) ?? null,
  }
}

/**
 * Arma un OfflineResultV3 a partir de los 3 JSON crudos (ya parseados) de
 * UNA MISMA carpeta de corrida de video_v3/test.py -- devuelve `error` (sin
 * `result`) si falta o no matchea el shape de alguno de los 3, nunca lanza.
 */
export function buildOfflineResult(
  evaluationTreeRaw: unknown,
  visualsRaw: unknown,
  transcripcionRaw: unknown,
): { result: OfflineResultV3 | null; error: string | null } {
  const arbol = validarEvaluationTree(evaluationTreeRaw)
  if (arbol.error || !arbol.data) return { result: null, error: arbol.error }

  const visuales = validarVisuals(visualsRaw)
  if (visuales.error || !visuales.data) return { result: null, error: visuales.error }

  const transcripcion = validarTranscripcion(transcripcionRaw)
  if (transcripcion.error || !transcripcion.data) return { result: null, error: transcripcion.error }

  const visualesPorId = new Map(visuales.data.map((m) => [m.id, m]))
  const transcripcionPorId = new Map(transcripcion.data.map((s) => [s.id, s]))

  const tree: FinalEvaluationTreeV3 = {
    video_id: arbol.data.video_id,
    total_score: arbol.data.total_score,
    criteria: arbol.data.criteria.map((nodo) => resolverNodo(nodo, visualesPorId, transcripcionPorId)),
  }

  const transcript: SegmentProsodySummaryV3[] = transcripcion.data.map((s) => ({
    speaker: s.speaker,
    texto: s.texto,
    inicio: s.inicio,
    fin: s.fin,
    duracion_s: s.duracion_s,
    prosody_summary: {
      pace: s.resumen_prosodico.ritmo,
      pauses: s.resumen_prosodico.pausas,
      clarity: s.resumen_prosodico.claridad,
      pitch_variation: s.resumen_prosodico.variacion_tono,
      loudness: s.resumen_prosodico.volumen,
      voice_quality: s.resumen_prosodico.calidad_voz,
      emphasis: s.resumen_prosodico.enfasis,
      emotion: s.resumen_prosodico.emocion,
    },
  }))

  const visualMoments: MomentosVisualesResponseV3 = {
    // El pipeline nuevo no persiste `subjects` en ningún archivo de la
    // corrida (confirmado -- ver docstring de cargar_coordenadas/
    // test_coordenadas.py) -- VisualMomentsView cae a su placeholder
    // "Sujeto {id} (sin nombre)" cuando no encuentra el sujeto, ver
    // sujetoLabel().
    subjects: [],
    momentos_visuales: visuales.data.map((m) => ({
      id: String(m.id),
      sujeto_id: m.sujeto_id,
      tipo_foco: m.tipo_foco,
      talking: m.talking,
      inicio: m.inicio,
      fin: m.fin,
      descripcion: m.descripcion,
    })),
  }

  return { result: { tree, transcript, visualMoments }, error: null }
}
