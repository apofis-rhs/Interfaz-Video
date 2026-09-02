/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_GOOGLE_CLIENT_ID: string
  readonly VITE_GOOGLE_API_KEY: string
  readonly VITE_GOOGLE_APP_ID: string
  readonly VITE_DROPBOX_APP_KEY: string
  readonly VITE_MS_CLIENT_ID: string
  readonly VITE_ANALYSIS_PROVIDER?: string
  readonly VITE_ANALYSIS_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
