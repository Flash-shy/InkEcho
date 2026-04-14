export type SessionSummaryState = {
  summary_status: string;
  summary_text?: string | null;
  summary_error?: string | null;
};

export function defaultSummaryState(): SessionSummaryState {
  return { summary_status: "idle" };
}
