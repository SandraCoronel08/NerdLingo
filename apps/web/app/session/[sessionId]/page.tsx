"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "../../../components/brand-mark";
import { StatusBadge } from "../../../components/monitoring-ui";
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
    <main className="nerdlingo-shell min-h-screen px-5 py-7 text-white sm:px-8 sm:py-10">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-4xl flex-col">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-white/15 pb-5">
          <div>
            <BrandMark dark />
            <div className="mt-4 flex items-center gap-2"><span className="h-px w-8 bg-[#00ACA8]" /><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#D8E3E6]">Audience captions</p></div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{stageLabel}</h1>
          </div>
          <StatusBadge status={state.status} />
        </header>

        <nav className="mt-5 flex flex-wrap gap-2" aria-label="Session selector">
          <Link className={`rounded-lg border px-4 py-2.5 font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#FFBA00] ${sessionId === "stage-1" ? "border-[#00ACA8] bg-[#00ACA8] text-[#1A1A1A]" : "border-white/15 bg-white/5 text-white hover:border-[#00ACA8]"}`} href="/session/stage-1">Stage 1</Link>
          <Link className={`rounded-lg border px-4 py-2.5 font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#FFBA00] ${sessionId === "stage-2" ? "border-[#00ACA8] bg-[#00ACA8] text-[#1A1A1A]" : "border-white/15 bg-white/5 text-white hover:border-[#00ACA8]"}`} href="/session/stage-2">Stage 2</Link>
          <Link className="rounded-lg px-4 py-2.5 font-semibold text-[#FFBA00] underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[#FFBA00]" href="/session">All sessions</Link>
        </nav>

        <section className="mt-5 inline-flex w-fit rounded-xl border border-white/15 bg-black/25 p-1.5" aria-label="Caption language">
          <button aria-pressed={language === "original"} className={`min-h-11 rounded-lg px-4 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#FFBA00] ${language === "original" ? "bg-[#FFBA00] text-[#1A1A1A]" : "text-[#D8E3E6] hover:bg-white/10"}`} onClick={() => setLanguage("original")}>
            Original (English)
          </button>
          <button aria-pressed={language === "spanish"} className={`min-h-11 rounded-lg px-4 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-[#FFBA00] ${language === "spanish" ? "bg-[#FFBA00] text-[#1A1A1A]" : "text-[#D8E3E6] hover:bg-white/10"}`} onClick={() => setLanguage("spanish")}>
            Español
          </button>
        </section>

        <section className="nerdlingo-panel mt-6 flex flex-1 items-center rounded-3xl border-l-4 border-l-[#00ACA8] p-7 shadow-2xl sm:mt-8 sm:p-12" aria-live="polite" aria-label="Live captions">
          {caption || state.status === "live" ? <p className="w-full text-3xl font-medium leading-relaxed tracking-tight text-white sm:text-5xl sm:leading-snug">
            {caption || "Listening for captions…"}
          </p> : <div className="mx-auto flex max-w-md flex-col items-center text-center">
            <BrandMark dark compact />
            <StatusBadge status="offline" />
            <p className="mt-5 text-2xl font-semibold">This session is offline</p>
            <p className="mt-2 leading-7 text-[#D8E3E6]">Captions will appear here when the stage goes live.</p>
          </div>}
        </section>
        <p className="mt-4 text-center text-sm text-[#9FB3B7]">{connected ? "Connected" : "Reconnecting…"}</p>
      </div>
    </main>
  );
}
