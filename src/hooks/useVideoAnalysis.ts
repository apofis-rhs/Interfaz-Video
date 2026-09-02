import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAnalysisStatusV3,
  startAnalysisV3,
  type FinalEvaluationTreeV3,
} from '../api/analysisApiV3'

const POLL_INTERVAL_MS = 3000
// El pipeline v3 (chunking + análisis multimodal por chunk + scoring +
// consolidación) puede tardar bastante más que la subida.
const POLL_TIMEOUT_MS = 30 * 60 * 1000

export type AnalysisPhase = 'idle' | 'running' | 'completed' | 'failed'

interface State {
  phase: AnalysisPhase
  result: FinalEvaluationTreeV3 | null
  errorMessage: string | null
}

const initialState: State = { phase: 'idle', result: null, errorMessage: null }

export function useVideoAnalysis() {
  const [state, setState] = useState<State>(initialState)
  const pollTimerRef = useRef<number | null>(null)
  const pollDeadlineRef = useRef<number>(0)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const fail = useCallback(
    (message: string) => {
      stopPolling()
      setState({ phase: 'failed', result: null, errorMessage: message })
    },
    [stopPolling],
  )

  const pollAnalysis = useCallback(
    (videoId: string) => {
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS
      stopPolling()
      pollTimerRef.current = window.setInterval(async () => {
        if (Date.now() > pollDeadlineRef.current) {
          fail('Tiempo de espera agotado esperando el análisis.')
          return
        }
        try {
          const status = await fetchAnalysisStatusV3(videoId)
          if (status.status === 'error') {
            fail(status.error || 'El análisis falló en el backend.')
            return
          }
          if (status.status === 'not_found') {
            // Terminal: el registro en memoria del backend no tiene este
            // video_id (nunca se disparó el análisis, o el servidor se
            // reinició). Reintentar el polling no lo va a resolver.
            fail('No se encontró un análisis en curso para este video (¿se reinició el backend?).')
            return
          }
          if (status.status === 'done') {
            stopPolling()
            if (!status.resultado) {
              fail('El backend marcó el análisis como listo pero no envió resultado.')
              return
            }
            // status.resultado es VideoV3Result completo (transcript +
            // subjects + momentos_visuales + evaluation_tree) — este panel
            // solo muestra el árbol de criterios, ver evaluation_tree.
            setState({ phase: 'completed', result: status.resultado.evaluation_tree, errorMessage: null })
            return
          }
          // status === 'running': sin cambio de fase, solo seguimos esperando
        } catch (err) {
          fail(err instanceof Error ? err.message : 'Error consultando el estado del análisis.')
        }
      }, POLL_INTERVAL_MS)
    },
    [fail, stopPolling],
  )

  const startAnalysis = useCallback(
    async (videoId: string, rubric: object) => {
      stopPolling()
      setState({ phase: 'running', result: null, errorMessage: null })
      try {
        await startAnalysisV3(videoId, rubric)
        pollAnalysis(videoId)
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Error iniciando el análisis.')
      }
    },
    [fail, pollAnalysis, stopPolling],
  )

  const resetAnalysis = useCallback(() => {
    stopPolling()
    setState(initialState)
  }, [stopPolling])

  return { ...state, startAnalysis, resetAnalysis }
}
