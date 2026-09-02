const PREFIX = '[chunkInterface]'

export function logInfo(message: string, ...args: unknown[]): void {
  console.info(`${PREFIX} ${message}`, ...args)
}

export function logError(message: string, ...args: unknown[]): void {
  console.error(`${PREFIX} ${message}`, ...args)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

export function formatElapsed(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
