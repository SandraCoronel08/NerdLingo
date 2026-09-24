"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { backendWebSocketUrl } from "../../../lib/backend-url";

type SessionId = "stage-1" | "stage-2";
type Language = "original" | "spanish";
type AudienceState = {
  status: "offline" | "live";
  original: string;
  spanish: string;
};

const emptyState: AudienceState = { status: "offline", original: "", spanish: "" };

function audienceSessionId(value: string | string[] | undefined): SessionId {
  return value === "stage-2" ? "stage-2" : "stage-1";
}

function viewerWebSocketUrl(sessionId: SessionId) {
  return backendWebSocketUrl("/view", sessionId);
}

export default function AudienceSession() {
  const params = useParams<{ sessionId?: string | string[] }>();
  const sessionId = audienceSessionId(params.sessionId);
  return <AudienceSessionView key={sessionId} sessionId={sessionId} />;
}

function AudienceSessionView({ sessionId }: { sessionId: SessionId }) {
  const [language, setLanguage] = useState<Language>("spanish");
  const [state, setState] = useState<AudienceState>(emptyState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    const connect = () => {
      socket = new WebSocket(viewerWebSocketUrl(sessionId));
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { sessionId?: string; status?: AudienceState["status"]; original?: string; spanish?: string };
          if (message.sessionId !== sessionId || (message.status !== "live" && message.status !== "offline")) return;
          setState({ status: message.status, original: message.original ?? "", spanish: message.spanish ?? "" });
        } catch {
          // Ignore malformed viewer messages; the next snapshot/update will repair state.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) retryTimer = window.setTimeout(connect, 1_500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close(1000, "Audience page closed");
    };
  }, [sessionId]);

  const caption = language === "original" ? state.original : state.spanish;
  const stageLabel = sessionId === "stage-1" ? "Stage 1" : "Stage 2";

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-white sm:px-8 sm:py-12">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl flex-col">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-700 pb-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">NerdLingo</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{stageLabel}</h1>
          </div>
          <p className={`rounded-full px-3 py-1 text-sm font-semibold ${state.status === "live" ? "bg-emerald-400 text-emerald-950" : "bg-slate-700 text-slate-100"}`}>
            {state.status === "live" ? "Live" : "Offline"}
          </p>
        </header>

        <nav className="mt-5 flex flex-wrap gap-3" aria-label="Session selector">
          <Link className={`rounded-lg px-4 py-3 font-semibold ${sessionId === "stage-1" ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-white"}`} href="/session/stage-1">Stage 1</Link>
          <Link className={`rounded-lg px-4 py-3 font-semibold ${sessionId === "stage-2" ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-white"}`} href="/session/stage-2">Stage 2</Link>
          <Link className="px-4 py-3 font-semibold text-cyan-300 underline" href="/session">All sessions</Link>
        </nav>

        <section className="mt-6 flex gap-3" aria-label="Caption language">
          <button aria-pressed={language === "original"} className={`min-h-12 rounded-lg px-5 font-semibold ${language === "original" ? "bg-white text-slate-950" : "bg-slate-800 text-white"}`} onClick={() => setLanguage("original")}>
            Original (English)
          </button>
          <button aria-pressed={language === "spanish"} className={`min-h-12 rounded-lg px-5 font-semibold ${language === "spanish" ? "bg-white text-slate-950" : "bg-slate-800 text-white"}`} onClick={() => setLanguage("spanish")}>
            Español
          </button>
        </section>

        <section className="mt-8 flex flex-1 items-center rounded-3xl border border-slate-700 bg-slate-900 p-7 shadow-2xl sm:p-12" aria-live="polite" aria-label="Live captions">
          <p className="w-full text-3xl font-medium leading-relaxed tracking-tight text-white sm:text-5xl sm:leading-snug">
            {caption || (state.status === "live" ? "Listening for captions…" : "This session is offline.")}
          </p>
        </section>
        <p className="mt-5 text-center text-sm text-slate-400">{connected ? "Connected" : "Reconnecting…"}</p>
      </div>
    </main>
  );
}
