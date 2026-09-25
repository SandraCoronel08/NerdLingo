import type { LiveLanguage } from "./target-language.js";

export type PublicSessionStatus = "offline" | "live";

export type PublicSessionMessage = {
  type: "session.snapshot" | "session.update";
  sessionId: string;
  status: PublicSessionStatus;
  original: string;
  translated: string;
  sourceLanguage: LiveLanguage;
  targetLanguage: LiveLanguage;
};

export type PublicSessionMonitoring = {
  sessionId: string;
  status: PublicSessionStatus;
  sourceLanguage: LiveLanguage;
  targetLanguage: LiveLanguage;
  viewerCount: number;
  lastUpdatedAt: number | null;
  lastOriginalAt: number | null;
  lastTranslatedAt: number | null;
  firstOriginalLatencyMs: number | null;
  firstTranslatedLatencyMs: number | null;
  lastError: { message: string; at: number } | null;
};

type ViewerSocket = {
  readyState: number;
  send(data: string): void;
};

type PublicSession = {
  status: PublicSessionStatus;
  original: string;
  translated: string;
  sourceLanguage: LiveLanguage;
  targetLanguage: LiveLanguage;
  viewers: Set<ViewerSocket>;
  lastUpdatedAt: number | null;
  lastOriginalAt: number | null;
  lastTranslatedAt: number | null;
  firstOriginalLatencyMs: number | null;
  firstTranslatedLatencyMs: number | null;
  lastError: { message: string; at: number } | null;
};

export class PublicSessionState {
  private readonly sessions = new Map<string, PublicSession>();

  constructor(sessionIds: string[], private readonly defaultSourceLanguage: LiveLanguage, private readonly defaultTargetLanguage: LiveLanguage) {
    for (const sessionId of sessionIds) {
      this.sessions.set(sessionId, {
        status: "offline",
        original: "",
        translated: "",
        sourceLanguage: defaultSourceLanguage,
        targetLanguage: defaultTargetLanguage,
        viewers: new Set(),
        lastUpdatedAt: null,
        lastOriginalAt: null,
        lastTranslatedAt: null,
        firstOriginalLatencyMs: null,
        firstTranslatedLatencyMs: null,
        lastError: null,
      });
    }
  }

  subscribe(sessionId: string, viewer: ViewerSocket) {
    const session = this.requireSession(sessionId);
    session.viewers.add(viewer);
    this.send(viewer, this.message("session.snapshot", sessionId, session));
  }

  unsubscribe(sessionId: string, viewer: ViewerSocket) {
    this.requireSession(sessionId).viewers.delete(viewer);
  }

  setStatus(sessionId: string, status: PublicSessionStatus) {
    const session = this.requireSession(sessionId);
    if (session.status === status) return;
    session.status = status;
    session.lastUpdatedAt = Date.now();
    this.broadcast(sessionId, session);
  }

  beginRun(sessionId: string, sourceLanguage: LiveLanguage, targetLanguage: LiveLanguage) {
    const session = this.requireSession(sessionId);
    session.firstOriginalLatencyMs = null;
    session.firstTranslatedLatencyMs = null;
    session.sourceLanguage = sourceLanguage;
    session.targetLanguage = targetLanguage;
    session.lastError = null;
    session.status = "live";
    session.lastUpdatedAt = Date.now();
    this.broadcast(sessionId, session);
  }

  setOriginal(sessionId: string, original: string, firstLatencyMs: number | null = null) {
    const session = this.requireSession(sessionId);
    session.original = original;
    const now = Date.now();
    session.lastOriginalAt = now;
    session.lastUpdatedAt = now;
    if (session.firstOriginalLatencyMs === null && firstLatencyMs !== null) session.firstOriginalLatencyMs = firstLatencyMs;
    this.broadcast(sessionId, session);
  }

  setTranslated(sessionId: string, translated: string, firstLatencyMs: number | null = null) {
    const session = this.requireSession(sessionId);
    session.translated = translated;
    const now = Date.now();
    session.lastTranslatedAt = now;
    session.lastUpdatedAt = now;
    if (session.firstTranslatedLatencyMs === null && firstLatencyMs !== null) session.firstTranslatedLatencyMs = firstLatencyMs;
    this.broadcast(sessionId, session);
  }

  setError(sessionId: string, message: string) {
    const session = this.requireSession(sessionId);
    const now = Date.now();
    session.lastError = { message, at: now };
    session.lastUpdatedAt = now;
  }

  viewerCount(sessionId: string) {
    return this.requireSession(sessionId).viewers.size;
  }

  monitoring(sessionId: string): PublicSessionMonitoring {
    const session = this.requireSession(sessionId);
    return {
      sessionId,
      status: session.status,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
      viewerCount: session.viewers.size,
      lastUpdatedAt: session.lastUpdatedAt,
      lastOriginalAt: session.lastOriginalAt,
      lastTranslatedAt: session.lastTranslatedAt,
      firstOriginalLatencyMs: session.firstOriginalLatencyMs,
      firstTranslatedLatencyMs: session.firstTranslatedLatencyMs,
      lastError: session.lastError,
    };
  }

  private broadcast(sessionId: string, session: PublicSession) {
    const payload = JSON.stringify(this.message("session.update", sessionId, session));
    for (const viewer of session.viewers) {
      if (viewer.readyState === 1) viewer.send(payload);
    }
  }

  private send(viewer: ViewerSocket, message: PublicSessionMessage) {
    if (viewer.readyState === 1) viewer.send(JSON.stringify(message));
  }

  private message(type: PublicSessionMessage["type"], sessionId: string, session: PublicSession): PublicSessionMessage {
    return {
      type,
      sessionId,
      status: session.status,
      original: session.original,
      translated: session.translated,
      sourceLanguage: session.sourceLanguage,
      targetLanguage: session.targetLanguage,
    };
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown public session: ${sessionId}`);
    return session;
  }
}
