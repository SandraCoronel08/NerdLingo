"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DownloadTranscriptButton, Metric, StatusBadge, StorageBadge } from "../components/monitoring-ui";
import { BrandHero, BrandMark } from "../components/brand-mark";
import { backendHttpUrl, backendWebSocketUrl } from "../lib/backend-url";
import { emptyStageMonitoring, firstCaptionLatency, type MonitorResponse, type StageMonitoring, timestamp } from "../lib/monitoring";
import { languageLabel, type LiveLanguage } from "../lib/target-language";

type StreamStatus = "Idle" | "Requesting permission" | "Connecting" | "Streaming" | "Finishing transcription…" | "Stopped" | "Error";
type GeminiStatus = "Not connected" | "Connecting" | "Connected" | "Error";
type AudioMode = "legacy" | "live-translate";
type CapturePhase = "idle" | "connecting" | "capturing" | "stopping";
type SessionId = "stage-1" | "stage-2";

type CaptureRun = {
  id: number;
  startedAtPerformanceMs: number;
  cancelled: boolean;
  draining: boolean;
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

const liveTranslateDrainTimeoutMs = 10_000;

function audioWebSocketUrl(sessionId: SessionId, debugCapture: boolean) {
  const url = new URL(backendWebSocketUrl("/audio", sessionId));
  if (debugCapture) url.searchParams.set("debugCapture", "1");
  return url.toString();
}

function OperatorSession({ sessionId, debugCapture = false }: { sessionId: SessionId; debugCapture?: boolean }) {
  const [status, setStatus] = useState<StreamStatus>("Idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [stats, setStats] = useState<StreamStats>(initialStats);
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus>("Not connected");
  const [audioMode, setAudioMode] = useState<AudioMode>("live-translate");
  const [sourceLanguage, setSourceLanguage] = useState<LiveLanguage>("en");
  const [targetLanguage, setTargetLanguage] = useState<LiveLanguage>("es");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscripts, setFinalTranscripts] = useState<string[]>([]);
  const [interimTranslation, setInterimTranslation] = useState("");
  const [finalTranslations, setFinalTranslations] = useState<string[]>([]);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>("idle");
  const [stageHealth, setStageHealth] = useState<StageMonitoring>(() => emptyStageMonitoring(sessionId));
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

  useEffect(() => {
    let disposed = false;
    const refreshHealth = async () => {
      try {
        const response = await fetch(backendHttpUrl("/monitor"), { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as MonitorResponse;
        const stage = payload.stages?.find((candidate) => candidate.sessionId === sessionId);
        if (!disposed && stage) setStageHealth(stage);
      } catch {
        // The operator console remains usable while monitoring is temporarily unavailable.
      }
    };
    void refreshHealth();
    const interval = window.setInterval(() => void refreshHealth(), 3_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [sessionId]);

  const enableMicrophone = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support audio input access.");
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
        setError("Audio input permission was denied.");
      } else if (cause instanceof DOMException && cause.name === "NotFoundError") {
        setError("No audio input was found.");
      } else {
        setError(cause instanceof Error ? cause.message : "Unable to enable audio inputs.");
      }
    } finally {
      temporaryStream?.getTracks().forEach((track) => track.stop());
    }
  };

  const isCurrentRun = (run: CaptureRun) => activeRunRef.current === run && !run.cancelled;
  const isCapturingRun = (run: CaptureRun) => isCurrentRun(run) && !run.draining;

  const finishRun = (run: CaptureRun, closeSocket = false) => {
    if (!isCurrentRun(run)) return;
    if (run.closeTimer) window.clearTimeout(run.closeTimer);
    run.cancelled = true;
    activeRunRef.current = null;
    if (closeSocket && run.socket?.readyState === WebSocket.OPEN) {
      run.socket.close(1000, "Audio session finalized");
    }
    setGeminiStatus("Not connected");
    setStatus("Idle");
    setCapturePhase("idle");
  };

  const stopCapture = (run: CaptureRun, finalizationWindowMs = 0) => {
    run.worklet?.disconnect();
    run.source?.disconnect();
    run.silent?.disconnect();
    run.stream?.getTracks().forEach((track) => track.stop());
    if (run.context && run.context.state !== "closed") void run.context.close();

    const socket = run.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio.stop" }));
      if (finalizationWindowMs > 0) {
        // Keep this run eligible for final Live Translate messages during the drain.
        run.closeTimer = window.setTimeout(() => {
          finishRun(run, true);
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
    if (finalizationWindowMs > 0) {
      run.draining = true;
      setStatus("Finishing transcription…");
      setCapturePhase("stopping");
      stopCapture(run, finalizationWindowMs);
      return;
    }
    stopCapture(run);
    finishRun(run);
  };

  const failRun = (run: CaptureRun, message: string) => {
    if (!isCurrentRun(run)) return;
    stopAudio();
    setError(message);
    setGeminiStatus("Error");
    setStatus("Error");
  };

  const startAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setError("This browser does not support audio input capture with the Web Audio API.");
      setStatus("Error");
      return;
    }
    if (activeRunRef.current) return;

    const run: CaptureRun = { id: nextRunIdRef.current + 1, startedAtPerformanceMs: performance.now(), cancelled: false, draining: false };
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
      if (!isCurrentRun(run)) {
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
      if (!isCurrentRun(run)) return;

      setStatus("Connecting");
      const socket = new WebSocket(audioWebSocketUrl(sessionId, debugCapture));
      socket.binaryType = "arraybuffer";
      run.socket = socket;
      let pipelineStarted = false;
      let firstPcmDebugSent = false;

      const startAudioPipeline = async () => {
        if (pipelineStarted || !isCapturingRun(run)) return;
        pipelineStarted = true;
        try {
          const context = new AudioContext();
          run.context = context;
          await context.audioWorklet.addModule("/pcm-processor.js");
          if (!isCapturingRun(run)) {
            void context.close();
            return;
          }
          const source = context.createMediaStreamSource(stream);
          const worklet = new AudioWorkletNode(context, "pcm-processor", {
            channelCount: 1,
            channelCountMode: "explicit",
            processorOptions: { targetSampleRate: 16_000, chunkDurationMs: 40, debugCapture },
          });
          const silent = context.createGain();
          silent.gain.value = 0;
          run.source = source;
          run.worklet = worklet;
          run.silent = silent;

          worklet.port.onmessage = (message: MessageEvent<{ type: string; buffer?: ArrayBuffer; inputSampleRate?: number; inputFrames?: number }>) => {
            if (!isCapturingRun(run) || socket.readyState !== WebSocket.OPEN) return;
            if (message.data.type === "capture.first-input") {
              if (debugCapture) {
                const payload = {
                  type: "audio.capture.debug",
                  event: "worklet-first-input",
                  clientCapturedAt: Date.now(),
                  clientElapsedMs: performance.now() - run.startedAtPerformanceMs,
                  audioContextSampleRate: context.sampleRate,
                  workletInputSampleRate: message.data.inputSampleRate,
                  workletInputFrames: message.data.inputFrames,
                  trackSettings: {
                    sampleRate: activeTrack?.getSettings().sampleRate,
                    channelCount: activeTrack?.getSettings().channelCount,
                    sampleSize: activeTrack?.getSettings().sampleSize,
                    echoCancellation: activeTrack?.getSettings().echoCancellation,
                    noiseSuppression: activeTrack?.getSettings().noiseSuppression,
                    autoGainControl: activeTrack?.getSettings().autoGainControl,
                  },
                };
                console.info("[CAPTURE_DEBUG]", payload);
                socket.send(JSON.stringify(payload));
              }
              return;
            }
            const pcmBuffer = message.data.buffer;
            if (message.data.type !== "pcm" || !pcmBuffer) return;
            const now = new Date().toISOString();
            if (debugCapture && !firstPcmDebugSent) {
              firstPcmDebugSent = true;
              const payload = {
                type: "audio.capture.debug",
                event: "pcm-sent",
                clientCapturedAt: Date.now(),
                clientElapsedMs: performance.now() - run.startedAtPerformanceMs,
                pcmBytes: pcmBuffer.byteLength,
              };
              console.info("[CAPTURE_DEBUG]", payload);
              socket.send(JSON.stringify(payload));
            }
            socket.send(pcmBuffer);
            setStats((current) => ({
              ...current,
              chunksSent: current.chunksSent + 1,
              bytesSent: current.bytesSent + pcmBuffer.byteLength,
              captureStartedAt: current.captureStartedAt ?? now,
              firstChunkSentAt: current.firstChunkSentAt ?? now,
              lastChunkSentAt: now,
            }));
          };

          source.connect(worklet);
          worklet.connect(silent).connect(context.destination);
          await context.resume();
          if (!isCapturingRun(run)) return;
          setStats((current) => ({ ...current, captureStartedAt: new Date().toISOString() }));
          setStatus("Streaming");
          setCapturePhase("capturing");
        } catch (cause) {
          failRun(run, cause instanceof Error ? cause.message : "Unable to start the audio pipeline.");
        }
      };

      socket.onerror = () => failRun(run, "Connection lost. Press Start to resume.");
      socket.onmessage = (event) => {
        if (!isCurrentRun(run)) return;
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; text?: string; message?: string; finished?: boolean; connectLatencyMs?: number | null; firstChunkLatencyMs?: number | null; translationLatencyMs?: number; firstChunkToTranslationMs?: number | null; firstAudioLatencyMs?: number | null; sourceLanguage?: LiveLanguage; targetLanguage?: LiveLanguage };
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
          if (message.type === "liveTranslate.connecting") {
            setGeminiStatus("Connecting");
            if (message.sourceLanguage && message.targetLanguage) setStageHealth((current) => ({ ...current, sourceLanguage: message.sourceLanguage!, targetLanguage: message.targetLanguage! }));
          }
          if (message.type === "liveTranslate.connected") {
            setGeminiStatus("Connected");
            if (message.sourceLanguage && message.targetLanguage) setStageHealth((current) => ({ ...current, sourceLanguage: message.sourceLanguage!, targetLanguage: message.targetLanguage! }));
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
          if (message.type === "liveTranslate.drain.complete" && run.draining) finishRun(run, true);
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
        if (!isCurrentRun(run)) return;
        if (event.code !== 1000) {
          failRun(run, "Connection lost. Press Start to resume.");
          return;
        }
        finishRun(run);
      };

      socket.onopen = () => {
        if (!isCapturingRun(run)) {
          socket.close(1000, "Audio session cancelled");
          return;
        }
        socket.send(JSON.stringify({
          type: "audio.start",
          mode: audioMode,
          sourceLanguage,
          targetLanguage,
          ...(debugCapture ? { captureDebug: { clientStartedAt: Date.now(), clientElapsedMs: performance.now() - run.startedAtPerformanceMs } } : {}),
        }));
      };
    } catch (cause) {
      if (!isCurrentRun(run)) return;
      if (cause instanceof DOMException && cause.name === "NotAllowedError") {
        failRun(run, "Audio input permission was denied. Allow access and try again.");
      } else if (cause instanceof DOMException && cause.name === "NotFoundError") {
        failRun(run, "No usable audio input device was found.");
      } else {
        failRun(run, cause instanceof Error ? cause.message : "Unable to access the selected audio device.");
      }
    }
  };

  const audioSeconds = stats.bytesSent / (16_000 * 2);
  const needsMicrophoneDiscovery = devices.length === 0 || devices.every((device) => !device.label || device.label.toLowerCase() === "default");
  const stageLabel = sessionId === "stage-1" ? "Stage 1" : "Stage 2";
  const originalLabel = `Original · ${languageLabel(sourceLanguage)}`;
  const translatedLabel = `Translated · ${languageLabel(targetLanguage)}`;
  const operationalStatus = status === "Idle"
    ? "Ready"
    : status === "Streaming"
      ? "Live"
      : status === "Connecting"
        ? "Connecting…"
        : status === "Error"
          ? (error?.startsWith("Connection lost") ? "Connection lost" : "Offline")
          : status;
  const consoleStatus = status === "Streaming" ? "live"
    : status === "Connecting" || status === "Requesting permission" ? "connecting"
      : status === "Finishing transcription…" ? "finishing"
        : status === "Error" ? "error" : "ready";

  return (
    <main className="nerdlingo-shell mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-12 text-white">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BrandHero />
          <div className="mt-5 flex items-center gap-3"><BrandMark dark compact /><span className="h-5 w-px bg-[#00ACA8]" /><span className="text-sm font-semibold uppercase tracking-[0.16em] text-[#D8E3E6]">{stageLabel}</span></div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">Production Console</h1>
          <p className="mt-2 text-[#D8E3E6]">Realtime captions and translation control.</p>
        </div>
        <StatusBadge status={consoleStatus} />
      </header>
      <section className="nerdlingo-panel space-y-4 rounded-xl p-5">
        <div>
          <p className="text-sm font-medium text-slate-600">Session control</p>
          <p className="text-lg font-semibold">{operationalStatus}</p>
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
          Enable audio inputs
        </button> : null}
        <p className="text-sm text-slate-600">Select the input connected to your microphone, audio interface, Line In, USB Audio, or mixing console.</p>
        <label className="block text-sm text-slate-700">
          Processing mode
          <select
            className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"
            value={audioMode}
            onChange={(event) => setAudioMode(event.target.value as AudioMode)}
            disabled={capturePhase !== "idle"}
          >
            <option value="live-translate">Live Translate (recommended)</option>
            <option value="legacy">Legacy (debug): transcription + text translation</option>
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-slate-700">
            Source language
            <select
              className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"
              value={sourceLanguage}
              onChange={(event) => {
                const nextSource = event.target.value as LiveLanguage;
                setSourceLanguage(nextSource);
                setTargetLanguage(nextSource === "en" ? "es" : "en");
              }}
              disabled={capturePhase !== "idle"}
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
          </label>
          <label className="block text-sm text-slate-700">
            Translation language
            <select
              className="mt-1 block w-full rounded border border-slate-300 bg-white p-2"
              value={targetLanguage}
              onChange={(event) => {
                const nextTarget = event.target.value as LiveLanguage;
                setTargetLanguage(nextTarget);
                setSourceLanguage(nextTarget === "en" ? "es" : "en");
              }}
              disabled={capturePhase !== "idle"}
            >
              <option value="es">Spanish</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <button className="text-left text-sm text-slate-700 underline" onClick={() => void refreshDevices()} disabled={capturePhase !== "idle"}>
          Refresh audio inputs
        </button>
        <div className="flex gap-3">
          <button className="rounded-lg bg-[#FFBA00] px-4 py-2 font-semibold text-[#1A1A1A] shadow-[0_0_24px_rgb(255_186_0_/_18%)] transition hover:brightness-110 disabled:opacity-50" onClick={() => void startAudio()} disabled={capturePhase !== "idle"}>
            Start audio
          </button>
          <button className="rounded border border-[#FF323C] px-4 py-2 text-[#B61F29] disabled:opacity-50" onClick={() => stopAudio(liveTranslateDrainTimeoutMs)} disabled={capturePhase === "idle" || capturePhase === "stopping"}>
            Stop audio
          </button>
        </div>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <details className="text-sm text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-800">Technical details</summary>
          <div className="mt-3">
          <p>Format: mono PCM, signed 16-bit little-endian, 16 kHz.</p>
          <p>Target chunk: 40 ms (640 samples / 1,280 bytes).</p>
          <p>Chunks sent: {stats.chunksSent}</p>
          <p>Bytes sent: {stats.bytesSent}</p>
          <p>Approximate audio sent: {audioSeconds.toFixed(1)} s</p>
          <p>Capture started: {stats.captureStartedAt ?? "—"}</p>
          <p>First chunk sent: {stats.firstChunkSentAt ?? "—"}</p>
          <p>Last chunk sent: {stats.lastChunkSentAt ?? "—"}</p>
          {audioMode === "live-translate" ? <>
            <p className="font-medium text-slate-800">Live Translate metrics</p>
            <p>Live Translate connect: {stats.liveTranslateConnectLatencyMs === null ? "—" : `${stats.liveTranslateConnectLatencyMs} ms`}</p>
            <p>First audio → original: {stats.firstLiveTranslateInputLatencyMs === null ? "—" : `${stats.firstLiveTranslateInputLatencyMs} ms`}</p>
            <p>First audio → {languageLabel(targetLanguage)}: {stats.firstLiveTranslateOutputLatencyMs === null ? "—" : `${stats.firstLiveTranslateOutputLatencyMs} ms`}</p>
            <p>Live Translate input events: {stats.liveTranslateInputEvents}</p>
            <p>Live Translate output events: {stats.liveTranslateOutputEvents}</p>
          </> : <>
            <p className="font-medium text-slate-800">Legacy metrics</p>
            <p>Gemini connect: {stats.geminiConnectLatencyMs === null ? "—" : `${stats.geminiConnectLatencyMs} ms`}</p>
            <p>First chunk → interim: {stats.firstInterimLatencyMs === null ? "—" : `${stats.firstInterimLatencyMs} ms`}</p>
            <p>First chunk → final: {stats.firstFinalLatencyMs === null ? "—" : `${stats.firstFinalLatencyMs} ms`}</p>
            <p>Final translation: {stats.translationLatencyMs === null ? "—" : `${stats.translationLatencyMs} ms`}</p>
            <p>Interim translation: {stats.interimTranslationLatencyMs === null ? "—" : `${stats.interimTranslationLatencyMs} ms`}</p>
            <p>First chunk → interim translation: {stats.firstInterimTranslationLatencyMs === null ? "—" : `${stats.firstInterimTranslationLatencyMs} ms`}</p>
          </>}
          </div>
        </details>
      </section>
      <section className="nerdlingo-panel rounded-xl border-l-4 border-l-[#00ACA8] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-sm font-medium text-slate-600">Stage health</p><p className="text-lg font-semibold">{stageLabel}</p></div>
          <StatusBadge status={stageHealth.lastError ? "error" : stageHealth.status} />
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Viewers" value={String(stageHealth.viewerCount)} featured />
          <Metric label="First Original caption" value={firstCaptionLatency(stageHealth.firstOriginalLatencyMs)} featured />
          <Metric label="First translated caption" value={firstCaptionLatency(stageHealth.firstTranslatedLatencyMs)} featured />
          <Metric label="Transcript storage" value={<StorageBadge status={stageHealth.transcript?.storageStatus ?? null} />} featured />
        </dl>
        <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Producer" value={stageHealth.producerConnected ? "Connected" : "Not connected"} />
          <Metric label="Last Original update" value={timestamp(stageHealth.lastOriginalAt)} />
          <Metric label={`Last translated update (${languageLabel(stageHealth.targetLanguage)})`} value={timestamp(stageHealth.lastTranslatedAt)} />
          <Metric label="Recent error" value={stageHealth.lastError ? <span className="text-red-700">{stageHealth.lastError.message}</span> : <span className="text-slate-500">✓ No recent errors</span>} />
        </dl>
        <div className="mt-4"><DownloadTranscriptButton stage={stageHealth} /></div>
      </section>
      <section className="nerdlingo-panel space-y-4 rounded-xl p-5">
        <div>
          <p className="text-sm font-medium text-slate-600">Live captions</p>
          <p className="text-lg font-semibold">{audioMode === "live-translate" ? "Gemini Live Translate" : "Legacy Transcription + Translation"} · {geminiStatus}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="rounded-lg border border-[#00ACA8]/45 bg-black/25 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_5%)]">
            <p className="text-sm font-medium text-slate-600">{originalLabel}</p>
            <p className="min-h-6 italic text-slate-600">{interimTranscript || "Waiting for speech..."}</p>
            {audioMode === "legacy" && finalTranscripts.length === 0 ? <p className="mt-2 text-slate-600">No final transcripts yet.</p> : null}
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {finalTranscripts.map((transcript, index) => <li key={`${index}-${transcript}`}>{transcript}</li>)}
            </ol>
          </div>
          <div className="rounded-lg border border-[#FFBA00]/45 bg-black/25 p-5 shadow-[inset_0_1px_0_rgb(255_255_255_/_5%)]">
            <p className="text-sm font-medium text-slate-600">{translatedLabel}</p>
            <p className="min-h-6 italic text-slate-600">{interimTranslation || "Waiting for translation..."}</p>
            {translationError ? <p className="mt-2 text-sm text-red-700">{translationError}</p> : null}
            {audioMode === "legacy" && finalTranslations.length === 0 ? <p className="mt-2 text-slate-600">No final translations yet.</p> : null}
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
  return <OperatorSession sessionId={sessionId} debugCapture={searchParams.get("debugCapture") === "1"} />;
}

export default function Home() {
  return <Suspense fallback={<OperatorSession sessionId="stage-1" />}><SessionPage /></Suspense>;
}
