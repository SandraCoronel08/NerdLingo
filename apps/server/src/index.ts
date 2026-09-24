import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { GoogleGenAI, Modality, ThinkingLevel, type Session } from "@google/genai";
import { WebSocket, WebSocketServer } from "ws";
import { PublicSessionState } from "./public-session-state.js";

for (const envPath of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", "..", ".env")]) {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    break;
  }
}

const port = Number(process.env.PORT ?? 3001);
const pcmBytesPerSecond = 16_000 * 2;
const geminiModel = "gemini-3.5-transcribe-live";
// Allow Gemini Live to flush the final input transcription before closing.
const geminiCloseDelayMs = 3_000;
const pendingAudioLimit = 5;
const translationModel = "gemini-3.5-flash-lite";
const interimTranslationIntervalMs = 1_000;
const finalTranslationRetryDelayMs = 750;
const interimTranslationTimeoutMs = 2_500;
const finalTranslationTimeoutMs = 7_500;
const liveTranslateModel = "gemini-3.5-live-translate-preview";
const liveTranslateChunkBytes = 3_840;
const allowedSessionIds = ["stage-1", "stage-2"];
const allowedSessionIdSet = new Set(allowedSessionIds);
const activeProducers = new Map<string, string>();
const publicSessions = new PublicSessionState(allowedSessionIds);
let shuttingDown = false;

type OperatorMessage =
  | { type: "gemini.connecting" }
  | { type: "gemini.connected"; connectLatencyMs: number | null }
  | { type: "gemini.error"; message: string }
  | { type: "transcript.interim"; text: string; firstChunkLatencyMs: number | null }
  | { type: "transcript.final"; text: string; firstChunkLatencyMs: number | null }
  | { type: "translation.interim"; text: string; translationLatencyMs: number; firstChunkToTranslationMs: number | null }
  | { type: "translation.final"; text: string; translationLatencyMs: number }
  | { type: "translation.error"; message: string }
  | { type: "liveTranslate.connecting" }
  | { type: "liveTranslate.connected"; connectLatencyMs: number | null }
  | { type: "liveTranslate.error"; message: string }
  | { type: "session.error"; code: "SESSION_BUSY"; message: string }
  | { type: "liveTranslate.input"; text: string; finished: boolean; firstAudioLatencyMs: number | null }
  | { type: "liveTranslate.output"; text: string; finished: boolean; firstAudioLatencyMs: number | null };

type GeminiServerContent = {
  inputTranscription?: { text?: string };
  interimInputTranscription?: { text?: string };
};

type LiveTranslateServerContent = {
  inputTranscription?: { text?: string; finished?: boolean };
  interimInputTranscription?: { text?: string; finished?: boolean };
  outputTranscription?: { text?: string; finished?: boolean };
  turnComplete?: boolean;
  generationComplete?: boolean;
  interrupted?: boolean;
};

type TranslationKind = "interim" | "final";
type AudioMode = "legacy" | "live-translate";

type PendingInterimTranslation = {
  text: string;
  version: number;
};

type TranslationErrorDetails = {
  name: string;
  status: number | null;
  code: string | null;
  message: string;
};

class TranslationTimeoutError extends Error {
  constructor(kind: TranslationKind, timeoutMs: number) {
    super(`${kind} translation exceeded ${timeoutMs} ms.`);
    this.name = "TranslationTimeoutError";
  }
}

function describeTranslationError(error: unknown): TranslationErrorDetails {
  const candidate = error instanceof Error ? error : new Error(String(error));
  const apiError = error as { status?: unknown; code?: unknown } | null;
  let status = typeof apiError?.status === "number" ? apiError.status : null;
  let code = typeof apiError?.code === "string" ? apiError.code : null;
  let message = candidate.message;

  try {
    const parsed = JSON.parse(candidate.message) as { error?: { code?: unknown; status?: unknown; message?: unknown } };
    const payload = parsed.error;
    if (typeof payload?.code === "number") status ??= payload.code;
    if (typeof payload?.status === "string") code ??= payload.status;
    if (typeof payload?.message === "string") message = payload.message;
  } catch {
    // Non-JSON SDK and network errors already have a useful Error.message.
  }

  return {
    name: candidate.name || "UnknownError",
    status,
    code,
    message: message.replace(/[\r\n]+/g, " ").slice(0, 240),
  };
}

function isTransientTranslationError(details: TranslationErrorDetails) {
  return details.status === 408 || details.status === 429 || (details.status !== null && details.status >= 500);
}

function appendTranscriptDelta(current: string, delta: string) {
  if (!current) return delta;
  if (!delta) return current;
  if (/^\s/.test(delta) || /\s$/.test(current) || /^[,.;:!?\)\]\}]/.test(delta)) return current + delta;
  return `${current} ${delta}`;
}

function sessionIdFromUrl(url: string | undefined) {
  const sessionId = new URL(url ?? "/", "http://localhost").searchParams.get("session");
  return sessionId && allowedSessionIdSet.has(sessionId) ? sessionId : undefined;
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "nerdlingo-server" }));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

const audioServer = new WebSocketServer({ noServer: true });
const viewerServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const target = pathname === "/audio" ? audioServer : pathname === "/view" ? viewerServer : undefined;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (websocket) => {
    target.emit("connection", websocket, request);
  });
});

viewerServer.on("connection", (socket, request) => {
  const sessionId = sessionIdFromUrl(request.url);
  if (!sessionId) {
    socket.close(1008, "Invalid session");
    return;
  }

  publicSessions.subscribe(sessionId, socket);
  socket.on("close", () => publicSessions.unsubscribe(sessionId, socket));
  socket.on("error", () => publicSessions.unsubscribe(sessionId, socket));
});

audioServer.on("connection", (socket, request) => {
  const candidateSessionId = sessionIdFromUrl(request.url);
  if (!candidateSessionId) {
    socket.close(1008, "Invalid session");
    return;
  }

  const sessionId = candidateSessionId;
  const connectionId = randomUUID();
  const id = `[${sessionId}][audio ${connectionId}]`;
  const websocketOpenedAt = Date.now();
  let audioMode: AudioMode = "legacy";
  let audioStartAt: number | undefined;
  let geminiConnectStartedAt: number | undefined;
  let geminiConnectedAt: number | undefined;
  let chunksReceived = 0;
  let bytesReceived = 0;
  let firstChunkReceivedAt: number | undefined;
  let firstChunkSentToGeminiAt: number | undefined;
  let lastChunkReceivedAt: number | undefined;
  let firstInterimReceivedAt: number | undefined;
  let firstFinalReceivedAt: number | undefined;
  let finalTranscriptReceivedAt: number | undefined;
  let translationRequestStartedAt: number | undefined;
  let translationReceivedAt: number | undefined;
  let liveTranslateConnectStartedAt: number | undefined;
  let liveTranslateConnectedAt: number | undefined;
  let firstAudioSentToLiveTranslateAt: number | undefined;
  let firstInputTranscriptAt: number | undefined;
  let firstOutputTranscriptAt: number | undefined;
  let audioStreamEndSentAt: number | undefined;
  let audioInputStopped = false;
  let lateAudioFrameLogged = false;
  let turnCompleteAt: number | undefined;
  let generationCompleteAt: number | undefined;
  let interruptedAt: number | undefined;
  let inputTranscriptEventCount = 0;
  let outputTranscriptEventCount = 0;
  let liveTranslateServerMessageCount = 0;
  let liveTranslateServerContentMessageCount = 0;
  let liveTranslateBatchesSent = 0;
  let liveTranslateBytesSent = 0;
  let liveTranslateInputBuffer = "";
  let liveTranslateOutputBuffer = "";
  let interimTranslationTimer: NodeJS.Timeout | undefined;
  let interimTranslationVersion = 0;
  let lastInterimTranslationStartedAt: number | undefined;
  let lastInterimTextRequested: string | undefined;
  let firstInterimTranslationRequestAt: number | undefined;
  let firstInterimTranslationReceivedAt: number | undefined;
  let pendingInterimTranslation: PendingInterimTranslation | undefined;
  let interimTranslationInFlight = false;
  let connectionClosed = false;
  let translationsInFlight = 0;
  let maxTranslationsInFlight = 0;
  let interimTranscriptCount = 0;
  let finalTranscriptCount = 0;
  let interimTranslationRequestCount = 0;
  let finalTranslationRequestCount = 0;
  let interimTranslationFailureCount = 0;
  let finalTranslationFailureCount = 0;
  let interimTranslationTimeoutCount = 0;
  let finalTranslationTimeoutCount = 0;
  let staleTranslationResultCount = 0;
  const translationFailuresByStatus = new Map<string, number>();
  let geminiSession: Session | undefined;
  let geminiSessionPromise: Promise<Session> | undefined;
  let geminiClosing = false;
  let geminiCloseTimer: NodeJS.Timeout | undefined;
  const pendingAudio: Buffer[] = [];
  let pendingLiveTranslateAudio = Buffer.alloc(0);

  const sendToOperator = (message: OperatorMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    if (message.type === "liveTranslate.input" || message.type === "transcript.interim" || message.type === "transcript.final") {
      publicSessions.setOriginal(sessionId, message.text);
    }
    if (message.type === "liveTranslate.output" || message.type === "translation.interim" || message.type === "translation.final") {
      publicSessions.setSpanish(sessionId, message.text);
    }
  };

  const finalizeLiveTranslateInput = (now = Date.now()) => {
    if (!liveTranslateInputBuffer) return;
    sendToOperator({
      type: "liveTranslate.input",
      text: liveTranslateInputBuffer,
      finished: true,
      firstAudioLatencyMs: firstAudioSentToLiveTranslateAt ? now - firstAudioSentToLiveTranslateAt : null,
    });
    liveTranslateInputBuffer = "";
  };

  const finalizeLiveTranslateOutput = (now = Date.now()) => {
    if (!liveTranslateOutputBuffer) return;
    sendToOperator({
      type: "liveTranslate.output",
      text: liveTranslateOutputBuffer,
      finished: true,
      firstAudioLatencyMs: firstAudioSentToLiveTranslateAt ? now - firstAudioSentToLiveTranslateAt : null,
    });
    liveTranslateOutputBuffer = "";
  };

  const translateText = async (text: string, kind: TranslationKind, interimVersion?: number, attempt = 0) => {
    if (connectionClosed) return;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      if (kind === "final") sendToOperator({ type: "translation.error", message: "Translation is not configured on the server." });
      return;
    }

    const requestStartedAt = Date.now();
    if (kind === "final") translationRequestStartedAt = requestStartedAt;
    if (kind === "interim") interimTranslationRequestCount += 1;
    else finalTranslationRequestCount += 1;
    translationsInFlight += 1;
    maxTranslationsInFlight = Math.max(maxTranslationsInFlight, translationsInFlight);
    const timeoutMs = kind === "interim" ? interimTranslationTimeoutMs : finalTranslationTimeoutMs;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const request = new GoogleGenAI({
        apiKey,
        httpOptions: {
          // The final retry below is the only application-level retry.
          retryOptions: { attempts: 1 },
        },
      }).models.generateContent({
        model: translationModel,
        contents: `Translate from English to Spanish. Preserve technical terms and proper names. Do not explain or summarize. Return only the translation.\n\n${text}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          temperature: 0,
          maxOutputTokens: 256,
        },
      });
      void request.then(
        () => {
          if (timedOut) {
            staleTranslationResultCount += 1;
            console.log(`[audio ${id}] expired ${kind} translation result ignored`);
          }
        },
        () => undefined,
      );
      // The SDK rejects deadlines under 10 seconds. This logical timeout keeps
      // realtime work bounded without sending an incompatible HTTP deadline.
      const response = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new TranslationTimeoutError(kind, timeoutMs));
          }, timeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      const translation = response.text?.trim();
      if (!translation) throw new Error("Gemini returned an empty translation.");
      if (kind === "interim" && interimVersion !== interimTranslationVersion) {
        staleTranslationResultCount += 1;
        console.log(`[audio ${id}] stale interim translation ignored`);
        return;
      }

      const receivedAt = Date.now();
      const translationLatencyMs = receivedAt - requestStartedAt;
      if (kind === "final") translationReceivedAt = receivedAt;
      console.log(`[audio ${id}] translation ${kind} received`);
      if (kind === "interim") {
        firstInterimTranslationReceivedAt ??= receivedAt;
        sendToOperator({
          type: "translation.interim",
          text: translation,
          translationLatencyMs,
          firstChunkToTranslationMs: firstChunkSentToGeminiAt ? receivedAt - firstChunkSentToGeminiAt : null,
        });
      } else {
        sendToOperator({ type: "translation.final", text: translation, translationLatencyMs });
      }
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      const details = describeTranslationError(error);
      const isTimeout = timedOut || details.name === "TranslationTimeoutError";
      const statusKey = `${details.status ?? "network"}:${details.code ?? details.name}`;
      translationFailuresByStatus.set(statusKey, (translationFailuresByStatus.get(statusKey) ?? 0) + 1);
      if (kind === "interim") interimTranslationFailureCount += 1;
      else finalTranslationFailureCount += 1;
      if (isTimeout && kind === "interim") interimTranslationTimeoutCount += 1;
      if (isTimeout && kind === "final") finalTranslationTimeoutCount += 1;
      console.warn(`[audio ${id}] translation ${kind} failed`, {
        ...details,
        durationMs: Date.now() - requestStartedAt,
        attempt,
        translationsInFlight,
      });

      if (kind === "final" && attempt === 0 && (isTimeout || isTransientTranslationError(details))) {
        console.log(`[audio ${id}] translation final retry scheduled`, { delayMs: finalTranslationRetryDelayMs, status: details.status, code: details.code });
        setTimeout(() => void translateText(text, "final", undefined, 1), finalTranslationRetryDelayMs);
      } else if (kind === "final") {
        sendToOperator({ type: "translation.error", message: "Final translation is temporarily unavailable; transcription continues." });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      translationsInFlight -= 1;
    }
  };

  const armInterimTranslation = () => {
    if (!pendingInterimTranslation || interimTranslationInFlight || interimTranslationTimer) return;
    const delay = lastInterimTranslationStartedAt
      ? Math.max(0, interimTranslationIntervalMs - (Date.now() - lastInterimTranslationStartedAt))
      : 0;
    interimTranslationTimer = setTimeout(() => {
      interimTranslationTimer = undefined;
      const next = pendingInterimTranslation;
      if (!next || interimTranslationInFlight) return;
      pendingInterimTranslation = undefined;
      interimTranslationInFlight = true;
      lastInterimTranslationStartedAt = Date.now();
      firstInterimTranslationRequestAt ??= lastInterimTranslationStartedAt;
      lastInterimTextRequested = next.text;
      void translateText(next.text, "interim", next.version).finally(() => {
        interimTranslationInFlight = false;
        armInterimTranslation();
      });
    }, delay);
  };

  const scheduleInterimTranslation = (text: string) => {
    if (!text.trim() || text === lastInterimTextRequested || text === pendingInterimTranslation?.text) return;
    interimTranslationVersion += 1;
    pendingInterimTranslation = { text, version: interimTranslationVersion };
    armInterimTranslation();
  };

  const closeGeminiSession = () => {
    if (geminiCloseTimer) clearTimeout(geminiCloseTimer);
    geminiCloseTimer = undefined;
    geminiClosing = true;
    if (audioMode === "live-translate") {
      finalizeLiveTranslateInput();
      finalizeLiveTranslateOutput();
    }
    if (geminiSession) {
      geminiSession.close();
      geminiSession = undefined;
      console.log(`[audio ${id}] Gemini session closed`);
    }
  };

  const openLiveTranslateSession = async () => {
    if (geminiSessionPromise) return geminiSessionPromise;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const message = "Gemini is not configured on the server.";
      console.warn(`[audio ${id}] ${message}`);
      sendToOperator({ type: "liveTranslate.error", message });
      throw new Error(message);
    }

    liveTranslateConnectStartedAt = Date.now();
    sendToOperator({ type: "liveTranslate.connecting" });
    geminiSessionPromise = new GoogleGenAI({ apiKey }).live.connect({
      model: liveTranslateModel,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: "es", echoTargetLanguage: false },
      },
      callbacks: {
        onmessage: (message) => {
          const now = Date.now();
          const content = message.serverContent as LiveTranslateServerContent | undefined;
          liveTranslateServerMessageCount += 1;
          if (!content) return;
          liveTranslateServerContentMessageCount += 1;
          if (content.turnComplete) turnCompleteAt ??= now;
          if (content.generationComplete) generationCompleteAt ??= now;
          if (content.interrupted) interruptedAt ??= now;
          const inputInterim = content?.interimInputTranscription;
          const inputFinal = content?.inputTranscription;
          const output = content?.outputTranscription;

          if (inputInterim?.text) {
            firstInputTranscriptAt ??= now;
            inputTranscriptEventCount += 1;
            console.log(`[audio ${id}] Live Translate input interim`, { text: JSON.stringify(inputInterim.text), turnComplete: content.turnComplete ?? false, generationComplete: content.generationComplete ?? false, interrupted: content.interrupted ?? false });
            sendToOperator({ type: "liveTranslate.input", text: inputInterim.text, finished: false, firstAudioLatencyMs: firstAudioSentToLiveTranslateAt ? now - firstAudioSentToLiveTranslateAt : null });
          }
          if (inputFinal?.text) {
            firstInputTranscriptAt ??= now;
            inputTranscriptEventCount += 1;
            console.log(`[audio ${id}] Live Translate input final`, { text: JSON.stringify(inputFinal.text), finished: inputFinal.finished ?? true, turnComplete: content.turnComplete ?? false, generationComplete: content.generationComplete ?? false, interrupted: content.interrupted ?? false });
            liveTranslateInputBuffer = appendTranscriptDelta(liveTranslateInputBuffer, inputFinal.text);
            sendToOperator({ type: "liveTranslate.input", text: liveTranslateInputBuffer, finished: false, firstAudioLatencyMs: firstAudioSentToLiveTranslateAt ? now - firstAudioSentToLiveTranslateAt : null });
          }
          if (output?.text) {
            firstOutputTranscriptAt ??= now;
            outputTranscriptEventCount += 1;
            console.log(`[audio ${id}] Live Translate output`, { text: JSON.stringify(output.text), finished: output.finished ?? false, turnComplete: content.turnComplete ?? false, generationComplete: content.generationComplete ?? false, interrupted: content.interrupted ?? false });
            liveTranslateOutputBuffer = appendTranscriptDelta(liveTranslateOutputBuffer, output.text);
            sendToOperator({ type: "liveTranslate.output", text: liveTranslateOutputBuffer, finished: false, firstAudioLatencyMs: firstAudioSentToLiveTranslateAt ? now - firstAudioSentToLiveTranslateAt : null });
            if (output.finished) finalizeLiveTranslateOutput(now);
          }
          if (content.turnComplete || content.generationComplete || content.interrupted) {
            console.log(`[audio ${id}] Live Translate turn signal`, {
              at: new Date(now).toISOString(),
              turnComplete: content.turnComplete ?? false,
              generationComplete: content.generationComplete ?? false,
              interrupted: content.interrupted ?? false,
            });
            finalizeLiveTranslateInput(now);
          }
          if (content.turnComplete || content.interrupted) finalizeLiveTranslateOutput(now);
          // Translated audio (modelTurn.inlineData) is intentionally discarded.
        },
        onerror: (error) => {
          const message = "Gemini Live Translate encountered a connection error.";
          console.warn(`[audio ${id}] ${message}`, { error: error.message });
          sendToOperator({ type: "liveTranslate.error", message });
        },
        onclose: (event) => {
          console.log(`[audio ${id}] Gemini Live Translate closed`, { code: event.code, reason: event.reason });
          if (!geminiClosing) {
            const message = "Gemini Live Translate closed unexpectedly.";
            console.warn(`[audio ${id}] ${message}`);
            sendToOperator({ type: "liveTranslate.error", message });
          }
        },
      },
    });
    const connectedSession = await geminiSessionPromise;
    if (geminiClosing) {
      connectedSession.close();
      throw new Error("Gemini Live Translate session was closed before it became ready.");
    }
    geminiSession = connectedSession;
    liveTranslateConnectedAt = Date.now();
    console.log(`[audio ${id}] Gemini Live Translate session opened`);
    sendToOperator({ type: "liveTranslate.connected", connectLatencyMs: liveTranslateConnectStartedAt ? liveTranslateConnectedAt - liveTranslateConnectStartedAt : null });
    while (pendingAudio.length > 0) sendAudioToGemini(pendingAudio.shift()!);
    return connectedSession;
  };

  const openGeminiSession = async () => {
    if (geminiSessionPromise) return geminiSessionPromise;
    if (audioMode === "live-translate") return openLiveTranslateSession();

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const message = "Gemini is not configured on the server.";
      console.warn(`[audio ${id}] ${message}`);
      sendToOperator({ type: "gemini.error", message });
      throw new Error(message);
    }

    geminiConnectStartedAt = Date.now();
    sendToOperator({ type: "gemini.connecting" });
    const ai = new GoogleGenAI({ apiKey });
    geminiSessionPromise = ai.live.connect({
      model: geminiModel,
      config: {
        responseModalities: [Modality.TEXT],
        inputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (message) => {
          const content = message.serverContent as GeminiServerContent | undefined;
          const interim = content?.interimInputTranscription?.text;
          const final = content?.inputTranscription?.text;
          const now = Date.now();

          if (interim) {
            firstInterimReceivedAt ??= now;
            interimTranscriptCount += 1;
            console.log(`[audio ${id}] Gemini interim received`);
            sendToOperator({ type: "transcript.interim", text: interim, firstChunkLatencyMs: firstChunkReceivedAt ? now - firstChunkReceivedAt : null });
            scheduleInterimTranslation(interim);
          }
          if (final) {
            firstFinalReceivedAt ??= now;
            finalTranscriptReceivedAt = now;
            finalTranscriptCount += 1;
            interimTranslationVersion += 1;
            pendingInterimTranslation = undefined;
            lastInterimTextRequested = undefined;
            if (interimTranslationTimer) clearTimeout(interimTranslationTimer);
            interimTranslationTimer = undefined;
            console.log(`[audio ${id}] Gemini final received`);
            sendToOperator({ type: "transcript.final", text: final, firstChunkLatencyMs: firstChunkReceivedAt ? now - firstChunkReceivedAt : null });
            void translateText(final, "final");
          }
        },
        onerror: () => {
          const message = "Gemini Live encountered a connection error.";
          console.warn(`[audio ${id}] ${message}`);
          sendToOperator({ type: "gemini.error", message });
        },
        onclose: () => {
          if (!geminiClosing) {
            const message = "Gemini Live closed unexpectedly.";
            console.warn(`[audio ${id}] ${message}`);
            sendToOperator({ type: "gemini.error", message });
          }
        },
      },
    });
    const connectedSession = await geminiSessionPromise;
    if (geminiClosing) {
      connectedSession.close();
      throw new Error("Gemini session was closed before it became ready.");
    }
    geminiSession = connectedSession;
    geminiConnectedAt = Date.now();
    console.log(`[audio ${id}] Gemini session opened`);
    sendToOperator({ type: "gemini.connected", connectLatencyMs: geminiConnectStartedAt ? geminiConnectedAt - geminiConnectStartedAt : null });
    while (pendingAudio.length > 0) sendPcmToGemini(connectedSession, pendingAudio.shift()!);
    return connectedSession;
  };

  const endGeminiAudio = async () => {
    if (!geminiSessionPromise) return;
    try {
      const session = await geminiSessionPromise;
      if (audioMode === "live-translate") flushLiveTranslateAudio(session);
      session.sendRealtimeInput({ audioStreamEnd: true });
      audioStreamEndSentAt = Date.now();
      if (audioMode === "live-translate") {
        console.log(`[audio ${id}] Live Translate audioStreamEnd sent`, {
          at: new Date(audioStreamEndSentAt).toISOString(),
          elapsedSinceFirstAudioMs: firstAudioSentToLiveTranslateAt ? audioStreamEndSentAt - firstAudioSentToLiveTranslateAt : null,
          liveTranslateBatchesSent,
          liveTranslateBytesSent,
          drainWindowMs: geminiCloseDelayMs,
        });
      }
      geminiCloseTimer = setTimeout(closeGeminiSession, geminiCloseDelayMs);
    } catch {
      closeGeminiSession();
    }
  };

  const sendPcmToGemini = (session: Session, data: Buffer) => {
    try {
      firstChunkSentToGeminiAt ??= Date.now();
      session.sendRealtimeInput({
        audio: {
          data: data.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    } catch (error) {
      if (geminiClosing) return;
      const message = error instanceof Error ? error.message : "Unable to send audio to Gemini Live.";
      console.warn(`[audio ${id}] Gemini audio send failed: ${message}`);
      sendToOperator({ type: "gemini.error", message: "Unable to send audio to Gemini Live." });
    }
  };

  const sendPcmToLiveTranslate = (session: Session, data: Buffer) => {
    pendingLiveTranslateAudio = Buffer.concat([pendingLiveTranslateAudio, data]);
    while (pendingLiveTranslateAudio.length >= liveTranslateChunkBytes) {
      const chunk = pendingLiveTranslateAudio.subarray(0, liveTranslateChunkBytes);
      pendingLiveTranslateAudio = pendingLiveTranslateAudio.subarray(liveTranslateChunkBytes);
      try {
        const sentAt = Date.now();
        const firstBatch = !firstAudioSentToLiveTranslateAt;
        firstAudioSentToLiveTranslateAt ??= sentAt;
        session.sendRealtimeInput({
          audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
        });
        liveTranslateBatchesSent += 1;
        liveTranslateBytesSent += chunk.length;
        if (firstBatch) {
          console.log(`[audio ${id}] Live Translate first audio batch sent`, {
            at: new Date(sentAt).toISOString(),
            bytes: chunk.length,
            mimeType: "audio/pcm;rate=16000",
          });
        }
      } catch (error) {
        if (geminiClosing) return;
        const message = error instanceof Error ? error.message : "Unable to send audio to Gemini Live Translate.";
        console.warn(`[audio ${id}] Gemini Live Translate audio send failed: ${message}`);
        sendToOperator({ type: "liveTranslate.error", message: "Unable to send audio to Gemini Live Translate." });
      }
    }
  };

  const flushLiveTranslateAudio = (session: Session) => {
    if (pendingLiveTranslateAudio.length === 0) return;
    const chunk = pendingLiveTranslateAudio;
    pendingLiveTranslateAudio = Buffer.alloc(0);
    try {
      firstAudioSentToLiveTranslateAt ??= Date.now();
      session.sendRealtimeInput({
        audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" },
      });
      liveTranslateBatchesSent += 1;
      liveTranslateBytesSent += chunk.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to flush audio to Gemini Live Translate.";
      console.warn(`[audio ${id}] Gemini Live Translate audio flush failed: ${message}`);
      sendToOperator({ type: "liveTranslate.error", message: "Unable to send audio to Gemini Live Translate." });
    }
  };

  const sendAudioToGemini = (data: Buffer | ArrayBuffer) => {
    if (audioInputStopped) return;
    const pcm = Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
    if (geminiSession) {
      if (audioMode === "live-translate") sendPcmToLiveTranslate(geminiSession, pcm);
      else sendPcmToGemini(geminiSession, pcm);
      return;
    }
    if (!geminiClosing) {
      if (pendingAudio.length === pendingAudioLimit) pendingAudio.shift();
      pendingAudio.push(pcm);
    }
  };

  console.log(`[audio ${id}] connection opened`);

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const control = JSON.parse(data.toString()) as { type?: string; mode?: AudioMode };
        if (control.type === "audio.start") {
          if (audioStartAt || audioInputStopped) return;
          const activeProducer = activeProducers.get(sessionId);
          if (activeProducer && activeProducer !== connectionId) {
            const message = `Session ${sessionId} already has an active audio producer.`;
            console.warn(`[audio ${id}] ${message}`);
            sendToOperator({ type: "session.error", code: "SESSION_BUSY", message });
            socket.close(4009, "Session busy");
            return;
          }
          activeProducers.set(sessionId, connectionId);
          publicSessions.setStatus(sessionId, "live");
          audioStartAt ??= Date.now();
          audioMode = control.mode === "live-translate" ? "live-translate" : "legacy";
          console.log(`[audio ${id}] control: audio.start`);
          void openGeminiSession().catch(() => undefined);
        }
        if (control.type === "audio.stop") {
          if (audioInputStopped) return;
          audioInputStopped = true;
          console.log(`[audio ${id}] control: audio.stop`);
          void endGeminiAudio();
        }
      } catch {
        console.warn(`[audio ${id}] ignored invalid control message`);
      }
      return;
    }

    if (audioInputStopped) {
      if (!lateAudioFrameLogged) {
        lateAudioFrameLogged = true;
        console.log(`[audio ${id}] late audio frame ignored after stream end`);
      }
      return;
    }

    const now = Date.now();
    firstChunkReceivedAt ??= now;
    lastChunkReceivedAt = now;
    chunksReceived += 1;
    const chunkBytes = Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.length, 0)
      : data.byteLength;
    bytesReceived += chunkBytes;

    if (Array.isArray(data)) {
      sendAudioToGemini(Buffer.concat(data));
    } else {
      sendAudioToGemini(data);
    }
  });

  socket.on("error", (error) => {
    console.warn(`[audio ${id}] socket error: ${error.message}`);
  });

  socket.on("close", () => {
    if (activeProducers.get(sessionId) === connectionId) {
      activeProducers.delete(sessionId);
      publicSessions.setStatus(sessionId, "offline");
    }
    connectionClosed = true;
    interimTranslationVersion += 1;
    pendingInterimTranslation = undefined;
    if (interimTranslationTimer) clearTimeout(interimTranslationTimer);
    closeGeminiSession();
    console.log(`[audio ${id}] connection closed`, {
      sessionId,
      audioMode,
      websocketOpenedAt: new Date(websocketOpenedAt).toISOString(),
      audioStartAt: audioStartAt ? new Date(audioStartAt).toISOString() : null,
      geminiConnectStartedAt: geminiConnectStartedAt ? new Date(geminiConnectStartedAt).toISOString() : null,
      geminiConnectedAt: geminiConnectedAt ? new Date(geminiConnectedAt).toISOString() : null,
      firstChunkReceivedAt: firstChunkReceivedAt ? new Date(firstChunkReceivedAt).toISOString() : null,
      firstChunkSentToGeminiAt: firstChunkSentToGeminiAt ? new Date(firstChunkSentToGeminiAt).toISOString() : null,
      firstInterimAt: firstInterimReceivedAt ? new Date(firstInterimReceivedAt).toISOString() : null,
      firstFinalAt: firstFinalReceivedAt ? new Date(firstFinalReceivedAt).toISOString() : null,
      finalTranscriptReceivedAt: finalTranscriptReceivedAt ? new Date(finalTranscriptReceivedAt).toISOString() : null,
      translationRequestStartedAt: translationRequestStartedAt ? new Date(translationRequestStartedAt).toISOString() : null,
      translationReceivedAt: translationReceivedAt ? new Date(translationReceivedAt).toISOString() : null,
      liveTranslateConnectStartedAt: liveTranslateConnectStartedAt ? new Date(liveTranslateConnectStartedAt).toISOString() : null,
      liveTranslateConnectedAt: liveTranslateConnectedAt ? new Date(liveTranslateConnectedAt).toISOString() : null,
      firstAudioSentToLiveTranslateAt: firstAudioSentToLiveTranslateAt ? new Date(firstAudioSentToLiveTranslateAt).toISOString() : null,
      firstInputTranscriptAt: firstInputTranscriptAt ? new Date(firstInputTranscriptAt).toISOString() : null,
      firstOutputTranscriptAt: firstOutputTranscriptAt ? new Date(firstOutputTranscriptAt).toISOString() : null,
      audioStreamEndSentAt: audioStreamEndSentAt ? new Date(audioStreamEndSentAt).toISOString() : null,
      turnCompleteAt: turnCompleteAt ? new Date(turnCompleteAt).toISOString() : null,
      generationCompleteAt: generationCompleteAt ? new Date(generationCompleteAt).toISOString() : null,
      interruptedAt: interruptedAt ? new Date(interruptedAt).toISOString() : null,
      firstInterimTranslationRequestAt: firstInterimTranslationRequestAt ? new Date(firstInterimTranslationRequestAt).toISOString() : null,
      firstInterimTranslationReceivedAt: firstInterimTranslationReceivedAt ? new Date(firstInterimTranslationReceivedAt).toISOString() : null,
      lastChunkReceivedAt: lastChunkReceivedAt ? new Date(lastChunkReceivedAt).toISOString() : null,
      chunksReceived,
      bytesReceived,
      approximateAudioDurationSeconds: Number((bytesReceived / pcmBytesPerSecond).toFixed(3)),
      geminiConnectLatencyMs: geminiConnectStartedAt && geminiConnectedAt ? geminiConnectedAt - geminiConnectStartedAt : null,
      audioStartToFirstChunkMs: audioStartAt && firstChunkReceivedAt ? firstChunkReceivedAt - audioStartAt : null,
      timeToFirstInterimMs: firstChunkReceivedAt && firstInterimReceivedAt ? firstInterimReceivedAt - firstChunkReceivedAt : null,
      timeToFirstFinalMs: firstChunkReceivedAt && firstFinalReceivedAt ? firstFinalReceivedAt - firstChunkReceivedAt : null,
      translationLatencyMs: translationRequestStartedAt && translationReceivedAt ? translationReceivedAt - translationRequestStartedAt : null,
      timeToFirstInterimTranslationMs: firstChunkSentToGeminiAt && firstInterimTranslationReceivedAt ? firstInterimTranslationReceivedAt - firstChunkSentToGeminiAt : null,
      liveTranslateConnectLatencyMs: liveTranslateConnectStartedAt && liveTranslateConnectedAt ? liveTranslateConnectedAt - liveTranslateConnectStartedAt : null,
      timeToFirstInputTranscriptMs: firstAudioSentToLiveTranslateAt && firstInputTranscriptAt ? firstInputTranscriptAt - firstAudioSentToLiveTranslateAt : null,
      timeToFirstTranslatedTranscriptMs: firstAudioSentToLiveTranslateAt && firstOutputTranscriptAt ? firstOutputTranscriptAt - firstAudioSentToLiveTranslateAt : null,
      inputTranscriptEventCount,
      outputTranscriptEventCount,
      liveTranslateServerMessageCount,
      liveTranslateServerContentMessageCount,
      liveTranslateBatchesSent,
      liveTranslateBytesSent,
      interimTranscriptCount,
      finalTranscriptCount,
      interimTranslationRequestCount,
      finalTranslationRequestCount,
      interimTranslationFailureCount,
      finalTranslationFailureCount,
      interimTranslationTimeoutCount,
      finalTranslationTimeoutCount,
      staleTranslationResultCount,
      maxTranslationsInFlight,
      translationFailuresByStatus: Object.fromEntries(translationFailuresByStatus),
    });
  });
});

function closeForShutdown(signal: "SIGINT" | "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing NerdLingo connections.`);

  for (const client of audioServer.clients) client.close(1001, "Server shutting down");
  for (const client of viewerServer.clients) client.close(1001, "Server shutting down");

  server.close(() => process.exit(0));
  const forceExitTimer = setTimeout(() => process.exit(0), 8_000);
  forceExitTimer.unref();
}

process.once("SIGINT", () => closeForShutdown("SIGINT"));
process.once("SIGTERM", () => closeForShutdown("SIGTERM"));

server.listen(port, "0.0.0.0", () => {
  console.log(`NerdLingo server listening on http://0.0.0.0:${port}`);
});
