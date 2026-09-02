export type UploadSource = 'local' | 'google_drive' | 'onedrive' | 'dropbox' | 'youtube'

export type RemoteSource = Exclude<UploadSource, 'local'>

// Los 3 orígenes que se resuelven con un picker nativo (login + elegir archivo)
// en vez de pegar una URL.
export type ProviderSource = 'google_drive' | 'onedrive' | 'dropbox'

export type UploadPhase = 'idle' | 'selecting' | 'uploading' | 'processing' | 'ready' | 'error'

export interface LocalSessionResponse {
  upload_session_url: string
  video_id: string
  gcs_uri: string
  expires_in_seconds: number
}

export type BackendStatus = 'uploading' | 'downloading' | 'processing' | 'ready' | 'error'

export interface VideoStatusResponse {
  video_id: string
  status: BackendStatus
  error_message?: string
  read_url?: string
  expires_in_seconds?: number
}

export interface FromUrlResponse {
  video_id: string
  status: 'queued'
}
