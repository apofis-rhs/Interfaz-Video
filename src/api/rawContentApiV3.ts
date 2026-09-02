import { API_BASE_URL } from './config'
import type { MomentoVisualUnionV3, SegmentProsodySummaryV3, SujetoV3 } from './analysisApiV3'

// GET /api/v3/video/{video_id}/transcripcion y /momentos-visuales — ver
// app/services/video_v3/analysis_api/router.py. Tipos reales importados de
// analysisApiV3.ts (VideoV3Result) para no duplicar/desincronizar el
// contrato: ambos endpoints devuelven exactamente los mismos shapes que
// transcript/{subjects,momentos_visuales} dentro de VideoV3Result.
//
// Timestamps: transcripcion trae inicio/fin como string "MM:SS" (ver
// SegmentProsodySummaryV3); momentos-visuales los trae como number, segundos
// absolutos ya remapeados (ver MomentoVisualUnionV3) — NO es el mismo
// formato entre los dos endpoints, no asumir uno por el otro.

export type { SegmentProsodySummaryV3, SujetoV3, MomentoVisualUnionV3 }

export interface MomentosVisualesResponseV3 {
  subjects: SujetoV3[]
  momentos_visuales: MomentoVisualUnionV3[]
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

export async function fetchTranscripcionV3(videoId: string): Promise<SegmentProsodySummaryV3[]> {
  const res = await fetch(`${API_BASE_URL}/api/v3/video/${videoId}/transcripcion`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export async function fetchMomentosVisualesV3(videoId: string): Promise<MomentosVisualesResponseV3> {
  const res = await fetch(`${API_BASE_URL}/api/v3/video/${videoId}/momentos-visuales`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}
