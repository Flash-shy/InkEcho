import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

import { type CaptureKind, captureKindMeta } from "./captureTypes";

type RecordPhase = "idle" | "recording" | "stopped";

/** Audio-only containers cannot record display-capture streams that include a video track — pick video MIME first. */
function recorderMimeAttempts(stream: MediaStream): (string | undefined)[] {
  const hasVideo = stream.getVideoTracks().length > 0;
  const videoFirst = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  const audioOnly = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const preferred = hasVideo ? [...videoFirst, ...audioOnly] : audioOnly;
  const supported = preferred.filter(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
  return [...supported, undefined];
}

function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Mix tab/screen capture audio with microphone into one track for MediaRecorder.
 * Returns null if there is no audio at all.
 */
function buildMixedDisplayAndMic(
  displayStream: MediaStream,
  micStream: MediaStream | null,
): { stream: MediaStream; cleanup: () => void } | null {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const videoTracks = displayStream.getVideoTracks();
  const displayAudio = displayStream.getAudioTracks();

  if (displayAudio.length > 0) {
    const src = ctx.createMediaStreamSource(new MediaStream(displayAudio));
    src.connect(dest);
  }
  if (micStream) {
    const src = ctx.createMediaStreamSource(micStream);
    src.connect(dest);
  }

  const mixedAudio = dest.stream.getAudioTracks();
  if (mixedAudio.length === 0) {
    void ctx.close();
    displayStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    return null;
  }

  const out = new MediaStream([...videoTracks, ...mixedAudio]);
  void ctx.resume().catch(() => {});

  const cleanup = () => {
    displayStream.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return { stream: out, cleanup };
}

export type ClipReadyOptions = {
  /** When false, clip is only enqueued (e.g. auto-save before another capture); stay on Listen. Default: switch to Transcribe. */
  focusTranscribe?: boolean;
  captureKind?: CaptureKind;
};

type ListenPanelProps = {
  onClipReady?: (blob: Blob, label: string, options?: ClipReadyOptions) => void;
};

export function ListenPanel({ onClipReady }: ListenPanelProps) {
  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingLabel, setRecordingLabel] = useState<string | null>(null);
  const [recordingKind, setRecordingKind] = useState<CaptureKind | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  /** Latest finished clip (for auto-queue before starting another capture) */
  const pendingClipRef = useRef<{ blob: Blob; label: string; captureKind: CaptureKind } | null>(null);
  /** Stops display + mic + AudioContext when using mixed capture */
  const cleanupRef = useRef<(() => void) | null>(null);
  const [mixMicWithTab, setMixMicWithTab] = useState(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const tickRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopMeter = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setLevel(0);
  }, []);

  const stopStream = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    streamRef.current = null;
  }, []);

  const clearTick = useCallback(() => {
    if (tickRef.current != null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    startedAtRef.current = null;
    setElapsedSec(0);
  }, []);

  const teardownRecording = useCallback(() => {
    clearTick();
    stopMeter();
    stopStream();
    recorderRef.current = null;
    chunksRef.current = [];
  }, [clearTick, stopMeter, stopStream]);

  const revokeRecordingObjectUrl = useCallback(() => {
    setRecordingUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const recordingUrlUnmountRef = useRef<string | null>(null);
  const uploadUrlUnmountRef = useRef<string | null>(null);
  recordingUrlUnmountRef.current = recordingUrl;
  uploadUrlUnmountRef.current = uploadUrl;

  useEffect(() => {
    return () => {
      teardownRecording();
      if (recordingUrlUnmountRef.current) URL.revokeObjectURL(recordingUrlUnmountRef.current);
      if (uploadUrlUnmountRef.current) URL.revokeObjectURL(uploadUrlUnmountRef.current);
    };
  }, [teardownRecording]);

  useEffect(() => {
    if (phase === "stopped" && recordingBlob && recordingLabel && recordingKind) {
      pendingClipRef.current = { blob: recordingBlob, label: recordingLabel, captureKind: recordingKind };
    } else {
      pendingClipRef.current = null;
    }
  }, [phase, recordingBlob, recordingLabel, recordingKind]);

  useEffect(() => {
    if (!queueNotice) return;
    const t = window.setTimeout(() => setQueueNotice(null), 6500);
    return () => window.clearTimeout(t);
  }, [queueNotice]);

  const startMeter = useCallback((stream: MediaStream) => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      const a = analyserRef.current;
      if (!a) return;
      a.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255;
      setLevel(avg);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const beginRecorder = useCallback(
    (stream: MediaStream, label: string, kind: CaptureKind) => {
      chunksRef.current = [];
      const attempts = recorderMimeAttempts(stream);
      const onData = (e: BlobEvent) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      const bindStop = (rec: MediaRecorder) => () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "application/octet-stream" });
        setRecordingBlob(blob);
        setRecordingUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setRecordingLabel(label);
        setRecordingKind(kind);
        setPhase("stopped");
        clearTick();
        stopMeter();
        stopStream();
        recorderRef.current = null;
        chunksRef.current = [];
      };

      for (const mime of attempts) {
        let rec: MediaRecorder;
        try {
          rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        } catch {
          continue;
        }
        rec.ondataavailable = onData;
        rec.onstop = bindStop(rec);
        try {
          rec.start(250);
        } catch {
          rec.ondataavailable = null;
          rec.onstop = null;
          continue;
        }
        recorderRef.current = rec;
        setPhase("recording");
        setError(null);
        startedAtRef.current = performance.now();
        tickRef.current = window.setInterval(() => {
          if (startedAtRef.current == null) return;
          setElapsedSec((performance.now() - startedAtRef.current) / 1000);
        }, 200);
        return;
      }

      stopMeter();
      stopStream();
      setError(
        "Could not start recording for this capture (browser MIME / tracks). Try microphone-only, another Chromium-based browser, or ensure the shared tab includes video when using tab capture.",
      );
      setPhase("idle");
    },
    [clearTick, stopMeter, stopStream],
  );

  const clearFinishedPreview = useCallback(() => {
    revokeRecordingObjectUrl();
    setRecordingBlob(null);
    setRecordingLabel(null);
    setRecordingKind(null);
    setPhase("idle");
    setElapsedSec(0);
  }, [revokeRecordingObjectUrl]);

  /**
   * Before starting a new capture: enqueue the current “Clip ready” so it is not lost,
   * then clear the local preview. Does not switch to Transcribe (stay on Listen).
   */
  const replaceFinishedClipForNewCapture = useCallback(() => {
    const prev = pendingClipRef.current;
    if (prev && onClipReady) {
      onClipReady(prev.blob, prev.label, { focusTranscribe: false, captureKind: prev.captureKind });
      setQueueNotice("Previous clip was added to the transcription queue. Open Transcribe when you want to run STT.");
    }
    clearFinishedPreview();
  }, [onClipReady, clearFinishedPreview]);

  const onCaptureTab = useCallback(async () => {
    setError(null);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      let recordStream: MediaStream;
      let label: string;

      if (mixMicWithTab) {
        let micStream: MediaStream | null = null;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {
          setError(
            "Microphone not available; recording tab/screen audio only. Grant mic access or turn off “Also mix in microphone”.",
          );
        }
        const built = buildMixedDisplayAndMic(displayStream, micStream);
        if (!built) {
          setError(
            "No audio to record. Enable “Share tab audio” for a tab, or allow the microphone when mixing is on.",
          );
          teardownRecording();
          setPhase("idle");
          return;
        }
        recordStream = built.stream;
        cleanupRef.current = built.cleanup;
        label = "Tab / screen + microphone";
      } else {
        recordStream = displayStream;
        cleanupRef.current = () => displayStream.getTracks().forEach((t) => t.stop());
        label = "Tab or window capture";
        if (displayStream.getAudioTracks().length === 0) {
          setError(
            "No audio track on this share. In Chromium, pick a tab and enable “Share tab audio”, or turn on “Also mix in microphone”.",
          );
        }
      }

      replaceFinishedClipForNewCapture();
      streamRef.current = recordStream;
      startMeter(recordStream);
      const vt = recordStream.getVideoTracks()[0];
      vt?.addEventListener("ended", () => {
        if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
      });
      beginRecorder(recordStream, label, mixMicWithTab ? "display-mic" : "display");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Display capture was cancelled or failed.";
      setError(msg);
      teardownRecording();
      setPhase("idle");
    }
  }, [beginRecorder, mixMicWithTab, replaceFinishedClipForNewCapture, startMeter, teardownRecording]);

  const onMicOnly = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      replaceFinishedClipForNewCapture();
      streamRef.current = stream;
      cleanupRef.current = () => stream.getTracks().forEach((t) => t.stop());
      startMeter(stream);
      beginRecorder(stream, "Microphone", "microphone");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Microphone access was denied or unavailable.";
      setError(msg);
      teardownRecording();
      setPhase("idle");
    }
  }, [beginRecorder, replaceFinishedClipForNewCapture, startMeter, teardownRecording]);

  const onStop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
  }, []);

  const onDiscardRecording = useCallback(() => {
    clearFinishedPreview();
  }, [clearFinishedPreview]);

  const onAddRecordingToQueue = useCallback(() => {
    if (!recordingBlob || !onClipReady || !recordingKind) return;
    onClipReady(recordingBlob, recordingLabel ?? "Recording", {
      focusTranscribe: true,
      captureKind: recordingKind,
    });
    setQueueNotice("Added to the transcription queue.");
    clearFinishedPreview();
  }, [recordingBlob, recordingLabel, recordingKind, onClipReady, clearFinishedPreview]);

  const onDownload = useCallback(() => {
    if (!recordingBlob || !recordingUrl) return;
    const ext = recordingBlob.type.includes("webm") ? "webm" : recordingBlob.type.includes("mp4") ? "mp4" : "bin";
    const a = document.createElement("a");
    a.href = recordingUrl;
    a.download = `inkecho-capture-${Date.now()}.${ext}`;
    a.click();
  }, [recordingBlob, recordingUrl]);

  const onUploadPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list?.length) return;
      if (list.length > 1 && onClipReady) {
        for (let i = 0; i < list.length; i++) {
          const f = list.item(i)!;
          onClipReady(f, f.name, { captureKind: "upload" });
        }
        e.target.value = "";
        return;
      }
      const f = list[0];
      setUploadFile(f);
      setUploadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(f);
      });
      e.target.value = "";
    },
    [onClipReady],
  );

  const onRemoveUpload = useCallback(() => {
    setUploadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setUploadFile(null);
  }, []);

  const uploadAccept =
    "audio/*,video/*,.webm,.m4a,.mp3,.wav,.ogg,.opus,.flac,.aac,.aiff,.mp4,.mov,.mkv,.mpeg,.mpga";

  return (
    <div className="listen">
      <p className="listen-lead muted">
        Tab or screen capture (enable tab audio), mic only, or file upload. A new capture queues the previous clip
        automatically.
      </p>

      {queueNotice && (
        <div className="banner-info" role="status">
          {queueNotice}
        </div>
      )}

      {error && (
        <div className="banner-err" role="alert">
          {error}
        </div>
      )}

      <div className="listen-actions">
        <button type="button" className="btn btn-primary" onClick={onCaptureTab} disabled={phase === "recording"}>
          Capture tab / screen
        </button>
        <button type="button" className="btn" onClick={onMicOnly} disabled={phase === "recording"}>
          Microphone only
        </button>
        {phase === "recording" && (
          <button type="button" className="btn btn-danger" onClick={onStop}>
            Stop recording
          </button>
        )}
      </div>

      <div className="listen-options">
        <label className="listen-mix-label">
          <input
            type="checkbox"
            checked={mixMicWithTab}
            onChange={(e) => setMixMicWithTab(e.target.checked)}
            disabled={phase === "recording"}
          />
          <span>
            Also mix in microphone with tab/screen capture <span className="muted">(records meeting + your voice)</span>
          </span>
        </label>
      </div>

      {phase === "recording" && (
        <div className="rec-status" aria-live="polite">
          <div className="rec-row">
            <span className="rec-dot" aria-hidden />
            <span className="rec-time">{formatHms(elapsedSec)}</span>
            <span className="muted">Recording…</span>
          </div>
          <div className="level-wrap" aria-hidden>
            <div className="level-bar" style={{ transform: `scaleX(${0.08 + level * 0.92})` }} />
          </div>
        </div>
      )}

      {phase === "stopped" && recordingUrl && (
        <div className="rec-result card-inner">
          <div className="rec-result-head">
            <strong>Clip ready</strong>
            <span className="muted">{recordingLabel}</span>
            {recordingKind && (
              <span
                className={`clip-kind-badge clip-kind-${recordingKind}`}
                title={captureKindMeta(recordingKind).hint}
              >
                {captureKindMeta(recordingKind).tag}
              </span>
            )}
          </div>
          <audio className="audio-preview" controls src={recordingUrl} />
          <div className="rec-result-actions">
            {onClipReady && recordingBlob && recordingKind && (
              <button type="button" className="btn btn-primary" onClick={onAddRecordingToQueue}>
                Add to transcription queue
              </button>
            )}
            <button type="button" className="btn" onClick={onDownload}>
              Download
            </button>
            <button type="button" className="btn" onClick={onDiscardRecording}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="upload-block">
        <h3 className="listen-subh">Upload a recording</h3>
        <p className="muted upload-hint">Multi-select supported.</p>
        <label className="file-label">
          <input type="file" accept={uploadAccept} multiple onChange={onUploadPick} className="file-input" />
          <span className="btn btn-ghost">Choose audio or video file(s)</span>
        </label>
        {uploadFile && uploadUrl && (
          <div className="upload-preview">
            <div className="upload-preview-head">
              <div className="muted upload-file-meta">
                <strong>{uploadFile.name}</strong> · {(uploadFile.size / (1024 * 1024)).toFixed(2)} MB
              </div>
              <div className="upload-preview-actions">
                {onClipReady && (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() =>
                      onClipReady(uploadFile, uploadFile.name, { captureKind: "upload", focusTranscribe: true })
                    }
                  >
                    Add to transcription queue
                  </button>
                )}
                <button type="button" className="btn btn-danger btn-small" onClick={onRemoveUpload}>
                  Remove file
                </button>
              </div>
            </div>
            <audio className="audio-preview" controls src={uploadUrl} />
          </div>
        )}
      </div>
    </div>
  );
}
