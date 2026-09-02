/** mm:ss (o h:mm:ss para videos de una hora o más). Usado para etiquetar los
 * timestamps clicables de transcripción/momentos visuales/evidencia. */
export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

/** Inverso de formatTimestamp: "MM:SS" o "H:MM:SS" -> segundos totales.
 * Usado para transcripción (ver SegmentProsodySummaryV3), que trae
 * inicio/fin como string MM:SS en vez de segundos absolutos. */
export function parseTimestampToSeconds(mmss: string): number {
  const partes = mmss.split(':').map(Number)
  if (partes.some((p) => Number.isNaN(p))) return 0
  return partes.reduce((total, parte) => total * 60 + parte, 0)
}
