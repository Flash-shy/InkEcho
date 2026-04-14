/** How the clip was produced — drives queue badges and copy. */
export type CaptureKind = "display" | "display-mic" | "microphone" | "upload";

export function captureKindMeta(kind: CaptureKind): { tag: string; hint: string } {
  switch (kind) {
    case "display":
      return {
        tag: "Tab / window",
        hint: "Audio from the shared browser tab (e.g. other participants in a web meeting).",
      };
    case "display-mic":
      return {
        tag: "Tab + microphone",
        hint: "Tab audio plus your microphone—mixed together.",
      };
    case "microphone":
      return {
        tag: "Microphone only",
        hint: "Only your voice; no audio from a shared tab.",
      };
    case "upload":
      return {
        tag: "Upload",
        hint: "A recording or video file you chose on this computer.",
      };
  }
}
