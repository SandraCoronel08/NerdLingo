"use client";

import { useEffect, useState } from "react";
import { backendWebSocketUrl } from "../../../lib/backend-url";

type SessionId = "stage-1" | "stage-2";
type OverlayLanguage = "es" | "original";
type OverlayState = {
  status: "offline" | "live";
  original: string;
  spanish: string;
};

const emptyState: OverlayState = { status: "offline", original: "", spanish: "" };
const maxCaptionCharacters = 210;

function latestCaptionWindow(caption: string) {
  const normalizedCaption = caption.trim();
  if (normalizedCaption.length <= maxCaptionCharacters) return normalizedCaption;

  const firstVisibleSpace = normalizedCaption.indexOf(" ", normalizedCaption.length - maxCaptionCharacters);
  const visibleText = normalizedCaption.slice(firstVisibleSpace === -1 ? normalizedCaption.length - maxCaptionCharacters : firstVisibleSpace + 1);

  return `…${visibleText}`;
}

export default function OverlayClient({ sessionId, language }: { sessionId: SessionId; language: OverlayLanguage }) {
  const [state, setState] = useState<OverlayState>(emptyState);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    const connect = () => {
      socket = new WebSocket(backendWebSocketUrl("/view", sessionId));
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;

        try {
          const message = JSON.parse(event.data) as {
            sessionId?: string;
            status?: OverlayState["status"];
            original?: string;
            spanish?: string;
          };
          if (message.sessionId !== sessionId || (message.status !== "live" && message.status !== "offline")) return;
          setState({ status: message.status, original: message.original ?? "", spanish: message.spanish ?? "" });
        } catch {
          // Ignore malformed viewer messages; a snapshot or later update repairs the overlay.
        }
      };
      socket.onclose = () => {
        if (!disposed) retryTimer = window.setTimeout(connect, 1_500);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close(1000, "Overlay closed");
    };
  }, [sessionId]);

  const caption = language === "original" ? state.original : state.spanish;
  const visibleCaption = state.status === "live" ? latestCaptionWindow(caption) : "";

  return (
    <main className="flex min-h-screen items-end justify-center bg-transparent px-[5vw] pb-[8vh] pt-[30vh] text-center text-white" aria-live="polite" aria-label="Live captions overlay">
      {visibleCaption ? (
        <p className="line-clamp-2 max-w-[90vw] overflow-hidden rounded-xl bg-black/55 px-6 py-3 text-[clamp(2rem,4.6vw,5.5rem)] font-semibold leading-[1.18] tracking-tight text-balance [overflow-wrap:anywhere] [text-shadow:0_2px_8px_rgb(0_0_0_/_0.95)] sm:px-10 sm:py-5">
          {visibleCaption}
        </p>
      ) : null}
    </main>
  );
}
