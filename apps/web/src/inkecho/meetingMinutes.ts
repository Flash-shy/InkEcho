import { INKECHO_API_PREFIX } from "./http";

/**
 * POST /sessions/{id}/meeting-minutes — start background job (same as MCP `generate_meeting_minutes` first step).
 * Caller should poll GET /sessions/{id} for `minutes_status` / `minutes_text`.
 */
export async function startMeetingMinutes(sessionId: string): Promise<void> {
  const r = await fetch(`${INKECHO_API_PREFIX}/sessions/${sessionId}/meeting-minutes`, { method: "POST" });
  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`${r.status} ${msg}`);
  }
}
