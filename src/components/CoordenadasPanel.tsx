import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, RefObject } from 'react'
import { logInfo } from '../utils/logger'

// Forma esperada del JSON producido externamente por el script de grounding
// visual en Python (fuera de este repo). Cada momento visual ya no trae un
// único bbox (evidencia_espacial, formato viejo) — ahora trae
// desglose_corporal: hasta 7 slots opcionales (uno por categoría corporal),
// cada uno con su propio bbox y su propia ventana de tiempo. Un slot en
// null significa "no detectado para este momento", se filtra sin romper la
// UI. Se "aplana" cada momento a 0-7 EventoCuerpo independientes.
interface Bbox {
  x1: number
  y1: number
  x2: number
  y2: number
}

type Categoria =
  | 'senalamiento_objeto'
  | 'movimiento_manos'
  | 'movimiento_cabeza'
  | 'movimiento_ojos'
  | 'movimiento_boca'
  | 'cuerpo_completo'
  | 'otro'

const CATEGORIAS: Categoria[] = [
  'senalamiento_objeto',
  'movimiento_manos',
  'movimiento_cabeza',
  'movimiento_ojos',
  'movimiento_boca',
  'cuerpo_completo',
  'otro',
]

const CATEGORY_LABELS: Record<Categoria, string> = {
  senalamiento_objeto: 'Señalamiento',
  movimiento_manos: 'Manos',
  movimiento_cabeza: 'Cabeza',
  movimiento_ojos: 'Ojos',
  movimiento_boca: 'Boca',
  cuerpo_completo: 'Cuerpo completo',
  otro: 'Otro',
}

// Paleta: un color de borde distinto y consistente por categoría.
const CATEGORY_COLORS: Record<Categoria, string> = {
  senalamiento_objeto: '#e5c53a', // amarillo
  movimiento_manos: '#4ade80', // verde
  movimiento_cabeza: '#6c8cff', // azul (mismo accent primario del resto de la app)
  movimiento_ojos: '#22d3ee', // cian
  movimiento_boca: '#f472b6', // rosa
  cuerpo_completo: '#a78bfa', // violeta
  otro: '#9aa0aa', // gris
}

// Evento renderizable ya aplanado: un slot no-null de desglose_corporal,
// con la referencia al momento_visual que lo contenía.
interface EventoCuerpo {
  eventId: string // `${momentoVisualId}:${categoria}` — único, usado como key/id de fade
  momentoVisualId: string
  categoria: Categoria
  descripcion: string
  bbox: Bbox
  frame_w: number
  frame_h: number
  t_start: number
  t_end: number
  confidence?: number
}

interface DisplayedEvento {
  evento: EventoCuerpo
  active: boolean
}

// Cambio de entorno/fondo (cambio_entorno) o descripción de qué se ve en el
// foco cuando no hay una persona puntual (descripcion_foco) -- a diferencia
// de EventoCuerpo, SIN bbox: no hay una posición en el frame, solo una
// ventana de tiempo (la del momento_visual completo, t_start/t_end =
// inicio/fin de ESE momento) -- se muestra como banner de texto, no como
// cuadro (ver computeBannerStyle). Ambos campos son independientes y pueden
// venir juntos o por separado; al menos uno no vacío para que el momento
// genere un EventoEntorno.
interface EventoEntorno {
  momentoVisualId: string
  t_start: number
  t_end: number
  cambioEntorno?: string
  descripcionFoco?: string
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const MAX_SIMULTANEOUS = 3
const FADE_MS = 320
const LOW_CONFIDENCE_THRESHOLD = 0.5

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidBboxSlot(slot: Record<string, unknown>): slot is Record<string, unknown> & {
  bbox: Record<string, unknown>
  frame_w: number
  frame_h: number
  t_start: number
  t_end: number
} {
  const bbox = slot.bbox
  if (typeof bbox !== 'object' || bbox === null) return false
  const b = bbox as Record<string, unknown>
  return (
    isFiniteNumber(b.x1) &&
    isFiniteNumber(b.y1) &&
    isFiniteNumber(b.x2) &&
    isFiniteNumber(b.y2) &&
    isFiniteNumber(slot.frame_w) &&
    isFiniteNumber(slot.frame_h) &&
    isFiniteNumber(slot.t_start) &&
    isFiniteNumber(slot.t_end) &&
    (slot.frame_w as number) > 0 &&
    (slot.frame_h as number) > 0 &&
    (slot.t_end as number) >= (slot.t_start as number)
  )
}

// Parsea + aplana el JSON crudo. Devuelve todos los EventoCuerpo válidos
// encontrados en cualquier momento, todos los EventoEntorno (cambio_entorno/
// descripcion_foco, sin bbox -- ver su interfaz), cuántos momentos no
// tuvieron ningún slot corporal detectado (los 7 en null, o desglose_corporal
// ausente -- NO cuenta si el momento sí aportó un EventoEntorno), y un error
// de nivel superior cuando el JSON completo no matchea el shape esperado
// (objeto sin el array raíz, o formato viejo con evidencia_espacial en vez
// de desglose_corporal).
function parseGroundingJson(
  raw: unknown,
): { eventos: EventoCuerpo[]; entornos: EventoEntorno[]; momentosSinEventos: number; error: string | null } {
  if (typeof raw !== 'object' || raw === null) {
    return { eventos: [], entornos: [], momentosSinEventos: 0, error: 'El JSON no es un objeto.' }
  }
  const root = raw as Record<string, unknown>
  const list = root.visual_moments ?? root.momentos_visuales
  if (!Array.isArray(list)) {
    return { eventos: [], entornos: [], momentosSinEventos: 0, error: 'Falta el array "visual_moments".' }
  }

  // Detección de formato viejo: si NINGÚN momento trae desglose_corporal
  // pero al menos uno trae evidencia_espacial, es un JSON generado con el
  // pipeline anterior — se corta acá con un mensaje claro en vez de
  // procesar y terminar mostrando "0 eventos" sin explicación.
  let itemsWithDesglose = 0
  let itemsWithLegacyEvidencia = 0
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if ('desglose_corporal' in o) itemsWithDesglose++
    else if ('evidencia_espacial' in o) itemsWithLegacyEvidencia++
  }
  if (itemsWithDesglose === 0 && itemsWithLegacyEvidencia > 0) {
    return {
      eventos: [],
      entornos: [],
      momentosSinEventos: 0,
      error:
        'Este JSON parece del formato anterior ("evidencia_espacial") — volvé a generarlo con el pipeline actualizado (desglose_corporal).',
    }
  }

  const eventos: EventoCuerpo[] = []
  const entornos: EventoEntorno[] = []
  let momentosSinEventos = 0

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string') continue
    const momentoId = o.id

    // cambio_entorno/descripcion_foco -- a nivel del MOMENTO, no de
    // desglose_corporal, así que se leen antes/independiente de esa rama
    // (un momento sin ningún slot corporal puede igual aportar un
    // EventoEntorno, y viceversa).
    const cambioEntorno = typeof o.cambio_entorno === 'string' ? o.cambio_entorno.trim() : ''
    const descripcionFoco = typeof o.descripcion_foco === 'string' ? o.descripcion_foco.trim() : ''
    if ((cambioEntorno || descripcionFoco) && isFiniteNumber(o.inicio) && isFiniteNumber(o.fin) && (o.fin as number) > (o.inicio as number)) {
      entornos.push({
        momentoVisualId: momentoId,
        t_start: o.inicio as number,
        t_end: o.fin as number,
        cambioEntorno: cambioEntorno || undefined,
        descripcionFoco: descripcionFoco || undefined,
      })
    }

    const desglose = o.desglose_corporal
    if (typeof desglose !== 'object' || desglose === null) {
      momentosSinEventos++
      continue
    }
    const d = desglose as Record<string, unknown>

    let foundAny = false
    for (const categoria of CATEGORIAS) {
      const slot = d[categoria]
      if (typeof slot !== 'object' || slot === null) continue
      const s = slot as Record<string, unknown>
      if (!isValidBboxSlot(s)) continue
      const b = s.bbox as Record<string, unknown>

      eventos.push({
        eventId: `${momentoId}:${categoria}`,
        momentoVisualId: momentoId,
        categoria,
        descripcion: typeof s.descripcion === 'string' ? s.descripcion : '(sin descripción)',
        bbox: { x1: b.x1 as number, y1: b.y1 as number, x2: b.x2 as number, y2: b.y2 as number },
        frame_w: s.frame_w as number,
        frame_h: s.frame_h as number,
        t_start: s.t_start as number,
        t_end: s.t_end as number,
        confidence: isFiniteNumber(s.confidence) ? (s.confidence as number) : undefined,
      })
      foundAny = true
    }
    if (!foundAny) momentosSinEventos++
  }

  // "Nada para mostrar" ahora requiere que NINGUNA de las dos fuentes (bbox
  // corporal O banner de entorno/foco) haya producido algo -- antes, un JSON
  // con solo evidencia de entorno (sin ningún EventoCuerpo) caía acá como
  // error aunque tuviera contenido legítimo para mostrar.
  if (eventos.length === 0 && entornos.length === 0) {
    return {
      eventos: [],
      entornos: [],
      momentosSinEventos,
      error: 'No se encontró ningún evento con desglose_corporal ni cambio_entorno/descripcion_foco válido.',
    }
  }
  return { eventos, entornos, momentosSinEventos, error: null }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// bbox normalizado (0-1, respecto a frame_w/frame_h del frame extraído por
// el script de Python) → posición real en pantalla del <video>. Usa la
// misma fórmula que object-fit: contain — funciona igual si el <video> no
// tiene letterboxing (offsets terminan en ~0).
function computeBoxStyle(evento: EventoCuerpo, videoRect: Rect): CSSProperties {
  const { bbox, frame_w, frame_h } = evento
  const scale = Math.min(videoRect.width / frame_w, videoRect.height / frame_h)
  const offsetX = (videoRect.width - frame_w * scale) / 2
  const offsetY = (videoRect.height - frame_h * scale) / 2
  return {
    left: videoRect.left + offsetX + bbox.x1 * frame_w * scale,
    top: videoRect.top + offsetY + bbox.y1 * frame_h * scale,
    width: (bbox.x2 - bbox.x1) * frame_w * scale,
    height: (bbox.y2 - bbox.y1) * frame_h * scale,
    borderColor: CATEGORY_COLORS[evento.categoria],
  }
}

interface Props {
  videoRef: RefObject<HTMLVideoElement>
}

// Panel independiente de AnalysisPanel: carga a mano un JSON de grounding
// visual (producido fuera de este repo) y dibuja cuadros sobre el <video>
// de VideoPlayer, sincronizados con currentTime. Todo client-side, sin
// backend nuevo.
export function CoordenadasPanel({ videoRef }: Props) {
  const [eventos, setEventos] = useState<EventoCuerpo[] | null>(null)
  const [entornos, setEntornos] = useState<EventoEntorno[]>([])
  const [activeEntornos, setActiveEntornos] = useState<EventoEntorno[]>([])
  const [momentosSinEventos, setMomentosSinEventos] = useState(0)
  const [filename, setFilename] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [rect, setRect] = useState<Rect | null>(null)
  const [displayed, setDisplayed] = useState<Map<string, DisplayedEvento>>(new Map())

  // Ref espejo de `eventos`/`entornos`: el listener de 'timeupdate' se
  // suscribe una sola vez (no en cada carga de JSON) y lee el valor actual
  // por acá.
  const eventosRef = useRef<EventoCuerpo[] | null>(null)
  const entornosRef = useRef<EventoEntorno[]>([])
  const fadeTimers = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    eventosRef.current = eventos
  }, [eventos])

  useEffect(() => {
    entornosRef.current = entornos
  }, [entornos])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    function syncActiveEventos() {
      if (!video) return
      const t = video.currentTime

      // Entornos/foco -- independiente de si hay EventoCuerpo cargados (un
      // JSON puede traer solo banners de entorno, sin ningún cuadro
      // corporal), así que se sincroniza ANTES del early-return de abajo.
      // Sin fade ni límite de simultáneos (a diferencia de los cuadros): es
      // texto, no compite visualmente por espacio del mismo modo.
      const entornosActivos = entornosRef.current.filter((e) => t >= e.t_start && t <= e.t_end)
      setActiveEntornos(entornosActivos)

      const list = eventosRef.current
      if (!list) return
      // Filtro por ventana de tiempo del EVENTO individual (categoría),
      // no del momento_visual padre — dos categorías del mismo momento
      // pueden estar activas en rangos distintos.
      const inRange = list.filter((ev) => t >= ev.t_start && t <= ev.t_end)

      let visible = inRange
      if (inRange.length > MAX_SIMULTANEOUS) {
        visible = [...inRange]
          .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
          .slice(0, MAX_SIMULTANEOUS)
        logInfo(
          `CoordenadasPanel: ${inRange.length - MAX_SIMULTANEOUS} evento(s) ocultos (límite ${MAX_SIMULTANEOUS} simultáneos) en t=${t.toFixed(2)}s`,
        )
      }
      const visibleIds = new Set(visible.map((ev) => ev.eventId))

      setDisplayed((prev) => {
        const next = new Map(prev)
        for (const ev of visible) {
          next.set(ev.eventId, { evento: ev, active: true })
          const pendingTimer = fadeTimers.current.get(ev.eventId)
          if (pendingTimer !== undefined) {
            window.clearTimeout(pendingTimer)
            fadeTimers.current.delete(ev.eventId)
          }
        }
        for (const [id, entry] of next) {
          if (!visibleIds.has(id) && entry.active) {
            next.set(id, { ...entry, active: false })
            const timerId = window.setTimeout(() => {
              setDisplayed((p) => {
                const n2 = new Map(p)
                n2.delete(id)
                return n2
              })
              fadeTimers.current.delete(id)
            }, FADE_MS)
            fadeTimers.current.set(id, timerId)
          }
        }
        return next
      })
    }

    function updateRect() {
      if (!video) return
      const r = video.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }

    updateRect()
    const resizeObserver = new ResizeObserver(updateRect)
    resizeObserver.observe(video)
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    video.addEventListener('loadedmetadata', updateRect)
    video.addEventListener('timeupdate', syncActiveEventos)
    video.addEventListener('seeked', syncActiveEventos)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
      video.removeEventListener('loadedmetadata', updateRect)
      video.removeEventListener('timeupdate', syncActiveEventos)
      video.removeEventListener('seeked', syncActiveEventos)
    }
  }, [videoRef])

  // Limpieza de timers de fade pendientes al desmontar el panel.
  useEffect(() => {
    return () => {
      for (const timerId of fadeTimers.current.values()) window.clearTimeout(timerId)
      fadeTimers.current.clear()
    }
  }, [])

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      setParseError(`"${file.name}" no es un JSON válido.`)
      setEventos(null)
      setFilename(null)
      return
    }

    const result = parseGroundingJson(raw)
    if (result.error) {
      setParseError(result.error)
      setEventos(null)
      setEntornos([])
      setFilename(null)
      return
    }

    for (const timerId of fadeTimers.current.values()) window.clearTimeout(timerId)
    fadeTimers.current.clear()
    setDisplayed(new Map())
    setActiveEntornos([])
    setParseError(null)
    setEventos(result.eventos)
    setEntornos(result.entornos)
    setMomentosSinEventos(result.momentosSinEventos)
    setFilename(file.name)
    const momentosConEventos = new Set(result.eventos.map((ev) => ev.momentoVisualId)).size
    logInfo(
      `CoordenadasPanel: cargados ${result.eventos.length} evento(s) corporales de ${momentosConEventos} momento(s) y ` +
        `${result.entornos.length} banner(s) de entorno/foco desde "${file.name}" (${result.momentosSinEventos} ` +
        'momento(s) sin ningún slot corporal detectado, omitidos)',
    )
  }

  return (
    <div className="coordenadas-panel">
      <h2>Coordenadas (grounding visual)</h2>

      <div className="coordenadas-panel__actions">
        <label className="button button--source">
          {filename ? `JSON: ${filename}` : 'Cargar JSON de coordenadas'}
          <input type="file" accept="application/json,.json" onChange={handleFileChange} hidden />
        </label>

        <label className="coordenadas-panel__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={!eventos && entornos.length === 0}
          />
          Mostrar overlay
        </label>
      </div>

      {parseError && <p className="coordenadas-panel__error">{parseError}</p>}

      {(eventos || entornos.length > 0) && !parseError && (
        <p className="coordenadas-panel__status">
          {(eventos?.length ?? 0)} evento(s) corporales
          {entornos.length > 0 ? ` y ${entornos.length} banner(s) de entorno/foco` : ''} cargados
          {momentosSinEventos > 0 ? ` (${momentosSinEventos} momento(s) sin slots corporales detectados, omitidos)` : ''}.
          Reproducí el video para verlos sincronizados.
        </p>
      )}

      {enabled && rect && activeEntornos.length > 0 && (
        <div className="coordenadas-entorno-banner" style={{ left: rect.left, top: rect.top, width: rect.width }}>
          {activeEntornos.map((entorno) => (
            <div key={entorno.momentoVisualId} className="coordenadas-entorno-banner__item">
              {entorno.cambioEntorno && <span>🌍 Entorno: {entorno.cambioEntorno}</span>}
              {entorno.descripcionFoco && <span>🔍 Foco: {entorno.descripcionFoco}</span>}
            </div>
          ))}
        </div>
      )}

      {enabled &&
        rect &&
        [...displayed.values()].map(({ evento, active }) => {
          const confidence = evento.confidence
          const lowConfidence = confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD
          const style = computeBoxStyle(evento, rect)
          const className = [
            'coordenadas-overlay-box',
            active ? 'is-active' : '',
            lowConfidence ? 'coordenadas-overlay-box--low-confidence' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div key={evento.eventId} className={className} style={style}>
              <span className="coordenadas-overlay-box__label">
                {CATEGORY_LABELS[evento.categoria]} · {truncate(evento.descripcion, 50)}
                {confidence !== undefined ? ` (${(confidence * 100).toFixed(0)}%)` : ''}
              </span>
            </div>
          )
        })}
    </div>
  )
}
