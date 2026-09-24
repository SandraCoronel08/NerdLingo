"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { backendWebSocketUrl } from "../lib/backend-url";

type StreamStatus = "Idle" | "Requesting permission" | "Connecting" | "Streaming" | "Stopped" | "Error";
type GeminiStatus = "Not connected" | "Connecting" | "Connected" | "Error";
type AudioMode = "legacy" | "live-translate";
type CapturePhase = "idle" | "connecting" | "capturing" | "stopping";
type SessionId = "stage-1" | "stage-2";

type CaptureRun = {
  id: number;
  cancelled: boolean;
  socket?: WebSocket;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  silent?: GainNode;
  closeTimer?: number;
};

type StreamStats = {
  chunksSent: number;
  bytesSent: number;
  captureStartedAt: string | null;
  firstChunkSentAt: string | null;
  lastChunkSentAt: string | null;
  geminiConnectLatencyMs: number | null;
  firstInterimLatencyMs: number | null;
  firstFinalLatencyMs: number | null;
  translationLatencyMs: number | null;
  interimTranslationLatencyMs: number | null;
  firstInterimTranslationLatencyMs: number | null;
  liveTranslateConnectLatencyMs: number | null;
  firstLiveTranslateInputLatencyMs: number | null;
  firstLiveTranslateOutputLatencyMs: number | null;
  liveTranslateInputEvents: number;
  liveTranslateOutputEvents: number;
};

const initialStats: StreamStats = {
  chunksSent: 0,
  bytesSent: 0,
  captureStartedAt: null,
  firstChunkSentAt: null,
  lastChunkSentAt: null,
  geminiConnectLatencyMs: null,
  firstInterimLatencyMs: null,
  firstFinalLatencyMs: null,
  translationLatencyMs: null,
  interimTranslationLatencyMs: null,
  firstInterimTranslationLatencyMs: null,
  liveTranslateConnectLatencyMs: null,
  firstLiveTranslateInputLatencyMs: null,
  firstLiveTranslateOutputLatencyMs: null,
  liveTranslateInputEvents: 0,
  liveTranslateOutputEvents: 0,
};

const translationFinalizationWindowMs = 12_000;

function audioWebSocketUrl(sessionId: SessionId) {
  return backendWebSocketUrl("/audio", sessionId);
}

function OperatorSession({ sessionId }: { sessionId: SessionId }) {
  const [status, setStatus] = useState<StreamStatus>("Idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [stats, setStats] = useState<StreamStats>(initialStats);
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus>("Not connected");
  const [audioMode, setAudioMode] = useState<AudioMode>("legacy");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscripts, setFinalTranscripts] = useState<string[]>([]);
  const [interimTranslation, setInterimTranslation] = useState("");
  const [finalTranslations, setFinalTranslations] = useState<string[]>([]);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>("idle");
  const activeRunRef = useRef<CaptureRun | null>(null);
  const nextRunIdRef = useRef(0);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("Audio device enumeration is not supported by this browser.");
      return;
    }

    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput",
    );
    setDevices(inputs);
    setSelectedDeviceId((current) => inputs.some((device) => device.deviceId === current) ? current : "");
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshDevices(), 0);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return () => window.clearTimeout(initialRefresh);
    const onDeviceChange = () => void refreshDevices();
    mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => {
      window.clearTimeout(initialRefresh);
      mediaDevices.removeEventListener("devicechange", onDeviceChange);
    };
  }, [refreshDevices]);

  const enableMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support microphone access.");
      return;
    }
    setError(null);
    let temporaryStream: MediaStream | undefined;
    try {
      temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      temporaryStream.getTracks().forEach((track) => track.stop());
      await refreshDevices();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        setError("Microphone permission was denied.");
      } else if (cause instanceof DOMException && cause.name === "NotFoundError") {
        setError("No microphone was found.");
      } else {
        setError(cause instanceof Error ? cause.message : "Unable to enable microphone access.");
      }
    } finally {
      temporaryStream?.getTracks().forEach((track) => track.stop());
    }
  };

  const isActiveRun = (run: CaptureRun) => activeRunRef.current === run && !run.cancelled;

  const releaseRun = (run: CaptureRun, finalizationWindowMs = 0) => {
    run.cancelled = true;
    run.worklet?.disconnect();
    run.source?.disconnect();
    run.silent?.disconnect();
    run.stream?.getTracks().forEach((track) => track.stop());
    if (run.context && run.context.state !== "closed") void run.context.close();

    const socket = run.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.stop" }));
      if (finalizationWindowMs > 0) {
        // Keep this detached socket alive only long enough to receive its final turn.
        run.closeTimer = window.setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Audio session finalized");
        }, finalizationWindowMs);
      } else {
        socket.close(1000, "Operator stopped audio");
      }
    } else if (socket?.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Operator stopped before connection");
    }
  };

  const stopAudio = (finalizationWindowMs = 0) => {
    const run = activeRunRef.current;
    if (!run) return;
    setCapturePhase("stopping");
    activeRunRef.current = null;
    releaseRun(run, finalizationWindowMs);
    setGeminiStatus("Not connected");
    setStatus("Idle");
    setCapturePhase("idle");
  };

  const failRun = (run: CaptureRun, message: string) => {
    if (!isActiveRun(run)) return;
    stopAudio();
    setError(message);
    setGeminiStatus("Error");
    setStatus("Error");
  };

  const startAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setError("This browser does not support microphone capture with the Web Audio API.");
      setStatus("Error");
      return;
    }
    if (activeRunRef.current) return;

    const run: CaptureRun = { id: nextRunIdRef.current + 1, cancelled: false };
    nextRunIdRef.current = run.id;
    activeRunRef.current = run;
    const selectedDeviceForRun = selectedDeviceId;
    setError(null);
    setStats(initialStats);
    setGeminiStatus("Not connected");
    setInterimTranscript("");
    setFinalTranscripts([]);
    setInterimTranslation("");
    setFinalTranslations([]);
    setTranslationError(null);
    setStatus("Requesting permission");
    setCapturePhase("connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(selectedDeviceForRun ? { deviceId: { exact: selectedDeviceForRun } } : {}),
          channelCount: { ideal: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!isActiveRun(run)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      run.stream = stream;
      const activeTrack = stream.getAudioTracks()[0];
      console.info("NerdLingo audio input opened", {
        selectedDeviceId: selectedDeviceForRun || null,
        activeTrackLabel: activeTrack?.label ?? null,
        activeTrackDeviceId: activeTrack?.getSettings().deviceId ?? null,
      });
      activeTrack?.addEventListener("ended", () => {
        failRun(run, "The selected audio device was disconnected or stopped.");
      });
      await refreshDevices();
      if (!isActiveRun(run)) return;

      setStatus("Connecting");
      const socket = new WebSocket(audioWebSocketUrl(sessionId));
      socket.binaryType = "arraybuffer";
      run.socket = socket;
      let pipelineStarted = false;

      const startAudioPipeline = async () => {
        if (pipelineStarted || !isActiveRun(run)) return;
        pipelineStarted = true;
        try {
          const context = new AudioContext();
          run.context = context;
          await context.audioWorklet.addModule("/pcm-processor.js");
          if (!isActiveRun(run)) {
            void context.close();
            return;
          }
          const source = context.createMediaStreamSource(stream);
          const worklet = new AudioWorkletNode(context, "pcm-processor", {
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { targetSampleRate: 16_000, chunkDurationMs: 40 },
          });
          const silent = context.createGain();
          silent.gain.value = 0;
          run.source = source;
          run.worklet = worklet;
          run.silent = silent;

          worklet.port.onmessage = (message: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
            if (!isActiveRun(run) || message.data.type !== "pcm" || socket.readyState !== WebSocket.OPEN) return;
            const now = new Date().toISOString();
            socket.send(message.data.buffer);
            setStats((current) => ({
              ...current,
              chunksSent: current.chunksSent + 1,
              bytesSent: current.bytesSent + message.data.buffer.byteLength,
              captureStartedAt: current.captureStartedAt ?? now,
              firstChunkSentAt: current.firstChunkSentAt ?? now,
              lastChunkSentAt: now,
            }));
          };

          source.connect(worklet);
          worklet.connect(silent).connect(context.destination);
          await context.resume();
          if (!isActiveRun(run)) return;
          setStats((current) => ({ ...current, captureStartedAt: new Date().toISOString() }));
          setStatus("Streaming");
          setCapturePhase("capturing");
        } catch (cause) {
          failRun(run, cause instanceof Error ? cause.message : "Unable to start the audio pipeline.");
        }
      };

      socket.onerror = () => failRun(run, "The WebSocket connection to the audio backend failed.");
      socket.onmessage = (event) => {
        if (!isActiveRun(run)) return;
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; text?: string; message?: string; finished?: boolean; connectLatencyMs?: number | null; firstChunkLatencyMs?: number | null; translationLatencyMs?: number; firstChunkToTranslationMs?: number | null; firstAudioLatencyMs?: number | null };
          if (message.type === "gemini.connecting") setGeminiStatus("Connecting");
          if (message.type === "gemini.connected") {
            setGeminiStatus("Connected");
            setStats((current) => ({ ...current, geminiConnectLatencyMs: message.connectLatencyMs ?? null }));
            void startAudioPipeline();
          }
          if (message.type === "gemini.error") {
            setGeminiStatus("Error");
            setError(message.message ?? "Gemini Live failed.");
          }
          if (message.type === "liveTranslate.connecting") setGeminiStatus("Connecting");
          if (message.type === "liveTranslate.connected") {
            setGeminiStatus("Connected");
            setStats((current) => ({ ...current, liveTranslateConnectLatencyMs: message.connectLatencyMs ?? null }));
            void startAudioPipeline();
          }
          if (message.type === "liveTranslate.error") {
            setGeminiStatus("Error");
            setError(message.message ?? "Gemini Live Translate failed.");
          }
          if (message.type === "session.error") {
            failRun(run, message.message ?? "This stage already has an active audio producer.");
          }
          if (message.type === "liveTranslate.input") {
            if (message.finished) {
              if (message.text) setFinalTranscripts((current) => [...current, message.text!]);
              setInterimTranscript("");
            } else {
              setInterimTranscript(message.text ?? "");
            }
            setStats((current) => ({
              ...current,
              liveTranslateInputEvents: current.liveTranslateInputEvents + 1,
              firstLiveTranslateInputLatencyMs: current.firstLiveTranslateInputLatencyMs ?? message.firstAudioLatencyMs ?? null,
            }));
          }
          if (message.type === "liveTranslate.output") {
            if (message.finished) {
              if (message.text) setFinalTranslations((current) => [...current, message.text!]);
              setInterimTranslation("");
            } else {
              setInterimTranslation(message.text ?? "");
            }
            setStats((current) => ({
              ...current,
              liveTranslateOutputEvents: current.liveTranslateOutputEvents + 1,
              firstLiveTranslateOutputLatencyMs: current.firstLiveTranslateOutputLatencyMs ?? message.firstAudioLatencyMs ?? null,
            }));
          }
          if (message.type === "transcript.interim") {
            setInterimTranscript(message.text ?? "");
            setStats((current) => ({ ...current, firstInterimLatencyMs: current.firstInterimLatencyMs ?? message.firstChunkLatencyMs ?? null }));
          }
          const transcript = message.text;
          if (message.type === "transcript.final" && transcript) {
            setFinalTranscripts((current) => [...current, transcript]);
            setInterimTranscript("");
            setStats((current) => ({ ...current, firstFinalLatencyMs: current.firstFinalLatencyMs ?? message.firstChunkLatencyMs ?? null }));
          }
          if (message.type === "translation.interim") {
            setInterimTranslation(message.text ?? "");
            setStats((current) => ({
              ...current,
              interimTranslationLatencyMs: message.translationLatencyMs ?? null,
              firstInterimTranslationLatencyMs: current.firstInterimTranslationLatencyMs ?? message.firstChunkToTranslationMs ?? null,
            }));
          }
          if (message.type === "translation.final" && transcript) {
            setFinalTranslations((current) => [...current, transcript]);
            setInterimTranslation("");
            setTranslationError(null);
            setStats((current) => ({ ...current, translationLatencyMs: message.translationLatencyMs ?? null }));
          }
          if (message.type === "translation.error") setTranslationError(message.message ?? "Translation is temporarily unavailable.");
        } catch {
          failRun(run, "The backend sent an invalid control message.");
        }
      };
      socket.onclose = (event) => {
        if (event.code !== 1000) failRun(run, "The WebSocket connection was closed unexpectedly.");
      };

      socket.onopen = () => {
        if (!isActiveRun(run)) {
          socket.close(1000, "Audio session cancelled");
          return;
        }
        socket.send(JSON.stringify({ type: "audio.start", mode: audioMode }));
      };
    } catch (cause) {
      if (!isActiveRun(run)) return;
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        failRun(run, "Microphone permission was denied. Allow access and try again.");
      } else if (cause instanceof DOMException && cause.name === "NotFoundError") {
        failRun(run, "No usable audio input device was found.");
      } else {
        failRun(run, cause instanceof Error ? cause.message : "Unable to access the selected audio device.");
      }
    }
  };

  const audioSeconds = stats.bytesSent / (16_000 * 2);
  const needsMicrophoneDiscovery = devices.length === 0 || devices.every((device) => !device.label || device.label.toLowerCase() === "default");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight text-slate-950">NerdLingo</h1>
      <p className="mt-4 text-lg text-slate-700">Open-source real-time captions for conferences.</p>
      <p className="text-sm font-semibold text-slate-700">Operator session: {sessionId}</p>
      <section className="space-y-4 rounded border border-slate-200 p-5">
        <div>
          <p className="text-sm font-medium text-slate-600">Status</p>
          <p className="text-lg font-semibold">{status}</p>
        </div>
        <label className="block text-sm text-slate-700">
          Audio input
          <select
            className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.target.value)}
            disabled={capturePhase !== "idle"}
          >
            <option value="">Default input</option>
            {devices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Audio input ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        {needsMicrophoneDiscovery ? <button className="text-left text-sm text-slate-700 underline" onClick={() => void enableMicrophone()} disabled={capturePhase !== "idle"}>
          Enable microphone
        </button> : null}
        <label className="block text-sm text-slate-700">
          Processing mode
          <select
            className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"
            value={audioMode}
            onChange={(event) => setAudioMode(event.target.value as AudioMode)}
            disabled={capturePhase !== "idle"}
          >
            <option value="legacy">Legacy: Live transcription + text translation</option>
            <option value="live-translate">Experimental: Gemini Live Translate</option>
          </select>
        </label>
        <button className="text-left text-sm text-slate-700 underline" onClick={() => void refreshDevices()} disabled={capturePhase !== "idle"}>
          Refresh audio inputs
        </button>
        <div className="flex gap-3">
          <button className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50" onClick={() => void startAudio()} disabled={capturePhase !== "idle"}>
            Start audio
          </button>
          <button className="rounded border border-slate-300 px-4 py-2 disabled:opacity-50" onClick={() => stopAudio(translationFinalizationWindowMs)} disabled={capturePhase === "idle" || capturePhase === "stopping"}>
            Stop audio
          </button>
        </div>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <div className="text-sm text-slate-600">
          <p>Format: mono PCM, signed 16-bit little-endian, 16 kHz.</p>
          <p>Target chunk: 40 ms (640 samples / 1,280 bytes).</p>
          <p>Chunks sent: {stats.chunksSent}</p>
          <p>Bytes sent: {stats.bytesSent}</p>
          <p>Approximate audio sent: {audioSeconds.toFixed(1)} s</p>
          <p>Capture started: {stats.captureStartedAt ?? "—"}</p>
          <p>First chunk sent: {stats.firstChunkSentAt ?? "—"}</p>
          <p>Last chunk sent: {stats.lastChunkSentAt ?? "—"}</p>
          <p>Gemini connect: {stats.geminiConnectLatencyMs === null ? "—" : `${stats.geminiConnectLatencyMs} ms`}</p>
          <p>First chunk → interim: {stats.firstInterimLatencyMs === null ? "—" : `${stats.firstInterimLatencyMs} ms`}</p>
          <p>First chunk → final: {stats.firstFinalLatencyMs === null ? "—" : `${stats.firstFinalLatencyMs} ms`}</p>
          <p>Final translation: {stats.translationLatencyMs === null ? "—" : `${stats.translationLatencyMs} ms`}</p>
          <p>Interim translation: {stats.interimTranslationLatencyMs === null ? "—" : `${stats.interimTranslationLatencyMs} ms`}</p>
          <p>First chunk → interim translation: {stats.firstInterimTranslationLatencyMs === null ? "—" : `${stats.firstInterimTranslationLatencyMs} ms`}</p>
          {audioMode === "live-translate" ? <>
            <p>Live Translate connect: {stats.liveTranslateConnectLatencyMs === null ? "—" : `${stats.liveTranslateConnectLatencyMs} ms`}</p>
            <p>First audio → original: {stats.firstLiveTranslateInputLatencyMs === null ? "—" : `${stats.firstLiveTranslateInputLatencyMs} ms`}</p>
            <p>First audio → español: {stats.firstLiveTranslateOutputLatencyMs === null ? "—" : `${stats.firstLiveTranslateOutputLatencyMs} ms`}</p>
            <p>Live Translate input events: {stats.liveTranslateInputEvents}</p>
            <p>Live Translate output events: {stats.liveTranslateOutputEvents}</p>
          </> : null}
        </div>
      </section>
      <section className="space-y-4 rounded border border-slate-200 p-5">
        <div>
          <p className="text-sm font-medium text-slate-600">Gemini Live</p>
          <p className="text-lg font-semibold">{geminiStatus}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <p className="text-sm font-medium text-slate-600">Original</p>
            <p className="min-h-6 italic text-slate-600">{interimTranscript || "Waiting for speech..."}</p>
            {finalTranscripts.length === 0 ? <p className="mt-2 text-slate-600">No final transcripts yet.</p> : null}
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {finalTranscripts.map((transcript, index) => <li key={`${index}-${transcript}`}>{transcript}</li>)}
            </ol>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-600">Español</p>
            <p className="min-h-6 italic text-slate-600">{interimTranslation || "Waiting for translation..."}</p>
            {translationError ? <p className="mt-2 text-sm text-red-700">{translationError}</p> : null}
            {finalTranslations.length === 0 ? <p className="mt-2 text-slate-600">No final translations yet.</p> : null}
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {finalTranslations.map((translation, index) => <li key={`${index}-${translation}`}>{translation}</li>)}
            </ol>
          </div>
        </div>
      </section>
    </main>
  );
}

function SessionPage() {
  const searchParams = useSearchParams();
  const sessionId: SessionId = searchParams.get("session") === "stage-2" ? "stage-2" : "stage-1";
  return <OperatorSession sessionId={sessionId} />;
}

export default function Home() {
  return <Suspense fallback={<OperatorSession sessionId="stage-1" />}><SessionPage /></Suspense>;
}
