import { API_BASE_URL } from './config'

// Calcado de app/services/video_v2/analysis_api/router.py y del árbol que
// arma reconstruct_evaluation_tree (app/services/video/criteria_logic.py),
// verificado directamente contra el código del backend.

export type AnalysisStatusV2 = 'running' | 'done' | 'error' | 'not_found'

export interface StartAnalysisV2Response {
  video_id: string
  status: 'analysis_started'
}

export interface TimestampMomentV2 {
  start: number
  end: number
  confidence: number
}

export interface TimestampEvidenceV2 {
  has_moments: boolean
  segment?: TimestampMomentV2 | null
  moments?: TimestampMomentV2[] | null
}

export interface AnalysisCriterionV2 {
  id: number
  name: string
  score: number
  evaluable: boolean
  feedback: string | null
  type_criteria?: string | null
  weight?: number | null
  type_weight?: string | null
  detected?: boolean | null
  evidence?: TimestampEvidenceV2 | null
  children?: AnalysisCriterionV2[] | null
}

export interface AnalysisResultV2 {
  general_feedback: string
  call_incomplete: boolean
  is_off_topic: boolean
  total_score: number
  detailed_criteria: AnalysisCriterionV2[]
}

export interface AnalysisStatusV2Response {
  video_id: string
  status: AnalysisStatusV2
  resultado?: AnalysisResultV2 | null
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

export async function startAnalysisV2(videoId: string, rubric: object): Promise<StartAnalysisV2Response> {
  const res = await fetch(`${API_BASE_URL}/api/v2/video/iniciar-analisis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, rubric }),
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export async function fetchAnalysisStatusV2(videoId: string): Promise<AnalysisStatusV2Response> {
  const res = await fetch(`${API_BASE_URL}/api/v2/video/analisis/${videoId}`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}
