import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

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

export function ListenPanel() {
  const [phase, setPhase] = useState<RecordPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingLabel, setRecordingLabel] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
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
    streamRef.current?.getTracks().forEach((t) => t.stop());
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
    (stream: MediaStream, label: string) => {
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

  const onCaptureTab = useCallback(async () => {
    setError(null);
    revokeRecordingObjectUrl();
    setRecordingBlob(null);
    setRecordingLabel(null);
    setPhase("idle");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      } as DisplayMediaStreamConstraints);
      streamRef.current = stream;
      if (stream.getAudioTracks().length === 0) {
        setError(
          "No audio track on this share. In Chromium, pick a tab and enable “Share tab audio”, or try microphone capture.",
        );
      }
      startMeter(stream);
      const vt = stream.getVideoTracks()[0];
      vt?.addEventListener("ended", () => {
        if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
      });
      beginRecorder(stream, "Tab or window capture");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Display capture was cancelled or failed.";
      setError(msg);
      teardownRecording();
      setPhase("idle");
    }
  }, [beginRecorder, revokeRecordingObjectUrl, startMeter, teardownRecording]);

  const onMicOnly = useCallback(async () => {
    setError(null);
    revokeRecordingObjectUrl();
    setRecordingBlob(null);
    setRecordingLabel(null);
    setPhase("idle");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      startMeter(stream);
      beginRecorder(stream, "Microphone");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Microphone access was denied or unavailable.";
      setError(msg);
      teardownRecording();
      setPhase("idle");
    }
  }, [beginRecorder, revokeRecordingObjectUrl, startMeter, teardownRecording]);

  const onStop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") recorderRef.current.stop();
  }, []);

  const onDiscardRecording = useCallback(() => {
    revokeRecordingObjectUrl();
    setRecordingBlob(null);
    setRecordingLabel(null);
    setPhase("idle");
    setElapsedSec(0);
  }, [revokeRecordingObjectUrl]);

  const onDownload = useCallback(() => {
    if (!recordingBlob || !recordingUrl) return;
    const ext = recordingBlob.type.includes("webm") ? "webm" : recordingBlob.type.includes("mp4") ? "mp4" : "bin";
    const a = document.createElement("a");
    a.href = recordingUrl;
    a.download = `inkecho-capture-${Date.now()}.${ext}`;
    a.click();
  }, [recordingBlob, recordingUrl]);

  const onUploadPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setUploadFile(f ?? null);
    setUploadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return f ? URL.createObjectURL(f) : null;
    });
    e.target.value = "";
  }, []);

  const onRemoveUpload = useCallback(() => {
    setUploadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setUploadFile(null);
  }, []);

  const uploadAccept = "audio/*,video/*,.webm,.m4a,.mp3,.wav,.ogg,.mp4,.mov";

  return (
    <div className="listen">
      <p className="listen-lead muted">
        Browsers cannot tap system audio directly. Share a <strong>tab</strong> or <strong>window</strong> that plays the
        meeting audio (enable “share audio” when prompted), use the <strong>microphone</strong>, or{" "}
        <strong>upload</strong> a file from OBS / QuickTime. Transcription will plug into the backend in the next
        milestone.
      </p>

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
          </div>
          <audio className="audio-preview" controls src={recordingUrl} />
          <div className="rec-result-actions">
            <button type="button" className="btn btn-primary" onClick={onDownload}>
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
        <label className="file-label">
          <input type="file" accept={uploadAccept} onChange={onUploadPick} className="file-input" />
          <span className="btn btn-ghost">Choose audio or video file</span>
        </label>
        {uploadFile && uploadUrl && (
          <div className="upload-preview">
            <div className="upload-preview-head">
              <div className="muted upload-file-meta">
                <strong>{uploadFile.name}</strong> · {(uploadFile.size / (1024 * 1024)).toFixed(2)} MB
              </div>
              <button type="button" className="btn btn-danger btn-small" onClick={onRemoveUpload}>
                Remove file
              </button>
            </div>
            <audio className="audio-preview" controls src={uploadUrl} />
          </div>
        )}
      </div>
    </div>
  );
}
