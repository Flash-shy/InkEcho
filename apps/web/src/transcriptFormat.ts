/** Shared segment shape (WebSocket STT events and REST session detail). */
export type TranscriptSegmentRow = {
  id: string;
  seq: number;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
};

function formatMs(ms: number | null): string {
  if (ms == null) return "—";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m > 0 ? `${m}:${r.toString().padStart(2, "0")}` : `${r}s`;
}

export function formatSegmentMeta(s: TranscriptSegmentRow, segments: TranscriptSegmentRow[]): string {
  const hasRange = s.start_ms != null || s.end_ms != null;
  if (hasRange) {
    return `Segment ${s.seq + 1} · ${formatMs(s.start_ms)}–${formatMs(s.end_ms)}`;
  }
  if (segments.length > 1) {
    return `Segment ${s.seq + 1} of ${segments.length} · no timestamps`;
  }
  return "Full clip · no timestamps from this STT provider";
}
