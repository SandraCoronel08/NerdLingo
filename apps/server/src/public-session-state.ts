export type PublicSessionStatus = "offline" | "live";

export type PublicSessionMessage = {
  type: "session.snapshot" | "session.update";
  sessionId: string;
  status: PublicSessionStatus;
  original: string;
  spanish: string;
};

type ViewerSocket = {
  readyState: number;
  send(data: string): void;
};

type PublicSession = {
  status: PublicSessionStatus;
  original: string;
  spanish: string;
  viewers: Set<ViewerSocket>;
};

export class PublicSessionState {
  private readonly sessions = new Map<string, PublicSession>();

  constructor(sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      this.sessions.set(sessionId, { status: "offline", original: "", spanish: "", viewers: new Set() });
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
    this.broadcast(sessionId, session);
  }

  setOriginal(sessionId: string, original: string) {
    const session = this.requireSession(sessionId);
    session.original = original;
    this.broadcast(sessionId, session);
  }

  setSpanish(sessionId: string, spanish: string) {
    const session = this.requireSession(sessionId);
    session.spanish = spanish;
    this.broadcast(sessionId, session);
  }

  viewerCount(sessionId: string) {
    return this.requireSession(sessionId).viewers.size;
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
    return { type, sessionId, status: session.status, original: session.original, spanish: session.spanish };
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown public session: ${sessionId}`);
    return session;
  }
}
