import { type ChangeEvent } from "react";

export type TranscriptExportFormat = "md" | "txt" | "json";

type Props = {
  disabled?: boolean;
  onChoose: (format: TranscriptExportFormat) => void;
};

export async function downloadTranscriptExport(
  sessionId: string,
  format: TranscriptExportFormat,
): Promise<void> {
  const r = await fetch(`/api/sessions/${sessionId}/export?format=${format}&transcript_only=true`);
  if (!r.ok) {
    window.alert(`${r.status} ${await r.text()}`);
    return;
  }
  const blob = await r.blob();
  const cd = r.headers.get("Content-Disposition");
  let name = `inkecho-${sessionId}-transcript.${format}`;
  const m = cd?.match(/filename="([^"]+)"/);
  if (m?.[1]) name = m[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function TranscriptExportSelect({ disabled, onChoose }: Props) {
  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "md" || v === "txt" || v === "json") {
      onChoose(v);
    }
    e.target.value = "";
  };

  return (
    <div className="transcript-export-wrap">
      <label className="transcript-export-label">
        <span className="transcript-export-label-text">Export</span>
        <select
          className="export-transcript-select"
          defaultValue=""
          disabled={disabled}
          aria-label="Export transcript only, choose file format"
          onChange={onChange}
        >
          <option value="">Format…</option>
          <option value="md">Markdown (.md)</option>
          <option value="txt">Plain text (.txt)</option>
          <option value="json">JSON (.json)</option>
        </select>
      </label>
    </div>
  );
}
