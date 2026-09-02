import { API_BASE_URL } from './config'

// Valores por defecto del proveedor de IA; se pueden sobreescribir por env
// sin tocar código. Soportados por el backend: gemini | qwen | twelvelabs.
const ANALYSIS_PROVIDER = import.meta.env.VITE_ANALYSIS_PROVIDER || 'gemini'
const ANALYSIS_MODEL = import.meta.env.VITE_ANALYSIS_MODEL || 'gemini-2.5-flash'

// Estados que reporta el backend (VideoTaskStatus en video_standard.py)
export type AnalysisBackendStatus =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'UPLOADING'
  | 'EVIDENCE_PROCESSING'
  | 'ANALYSIS_PROCESSING'
  | 'GENERATING_FEEDBACK'
  | 'COMPLETED'
  | 'FAILED'

export interface AnalysisStartResponse {
  task_id: string
  status: AnalysisBackendStatus
}

export interface AnalysisTask {
  status: AnalysisBackendStatus
  result?: unknown
  error?: string
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

export async function startVideoAnalysis(videoUrl: string, rubricFile: File): Promise<AnalysisStartResponse> {
  const form = new FormData()
  form.append('url', videoUrl)
  form.append('provider', ANALYSIS_PROVIDER)
  form.append('model', ANALYSIS_MODEL)
  form.append('rubric', rubricFile)

  const res = await fetch(`${API_BASE_URL}/api/v1/video/evaluations/links`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}

export async function fetchAnalysisTask(taskId: string): Promise<AnalysisTask> {
  const res = await fetch(`${API_BASE_URL}/api/v1/video/evaluations/status/${taskId}`)
  if (!res.ok) throw new Error(await parseErrorMessage(res))
  return res.json()
}
