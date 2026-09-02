import type { RemoteSource } from '../api/types'

export const SOURCE_LABELS: Record<RemoteSource, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  youtube: 'YouTube',
}

const PATTERNS: Record<RemoteSource, RegExp> = {
  google_drive: /drive\.google\.com/i,
  onedrive: /(1drv\.ms|onedrive\.live\.com|sharepoint\.com)/i,
  dropbox: /dropbox\.com/i,
  youtube: /(youtube\.com|youtu\.be)/i,
}

export function validateSourceUrl(source: RemoteSource, url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return 'Pega un enlace.'

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'La URL no es válida.'
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'La URL debe empezar con http:// o https://.'
  }

  if (!PATTERNS[source].test(trimmed)) {
    return `Ese enlace no parece ser de ${SOURCE_LABELS[source]}.`
  }

  return null
}
