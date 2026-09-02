// Debe reflejar MEDIA_INGESTION_ALLOWED_CONTENT_TYPES en
// media_ingestion_service/config.py. Si el backend cambia esa lista, actualizar aquí también.
export const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

export function resolveVideoContentType(filename: string, blobType: string): string | null {
  if (ALLOWED_VIDEO_CONTENT_TYPES.includes(blobType as (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number])) {
    return blobType
  }
  const byExtension = EXTENSION_CONTENT_TYPES[extensionOf(filename)]
  return byExtension ?? null
}
