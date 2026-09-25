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
const maxWordsPerCaptionBlock = 10;

function normalizeCaption(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function currentSentence(text: string) {
  const sentences = normalizeCaption(text).match(/[^.!?]+(?:[.!?]+|$)/g);
  return sentences?.at(-1)?.trim() ?? "";
}

function currentSentenceBlock(sentence: string) {
  const words = sentence.split(" ").filter(Boolean);
  if (!words.length) return "";

  const blockStart = Math.floor((words.length - 1) / maxWordsPerCaptionBlock) * maxWordsPerCaptionBlock;
  return words.slice(blockStart).join(" ");
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
  const visibleCaption = state.status === "live" ? currentSentenceBlock(currentSentence(caption)) : "";

  return (
    <main className="flex min-h-screen items-end justify-center bg-transparent px-[5vw] pb-[8vh] pt-[30vh] text-center text-white" aria-live="polite" aria-label="Live captions overlay">
      {visibleCaption ? (
        <div className="w-[86vw] max-w-[1500px] rounded-lg bg-black/55 px-5 py-2 shadow-[0_2px_8px_rgb(0_0_0_/_0.95)] sm:px-6">
          <div className="flex h-[1.2em] items-end overflow-hidden text-[clamp(1.75rem,2.2vw,2.625rem)] font-semibold leading-[1.2] tracking-tight">
            <p className="w-full shrink-0">{visibleCaption}</p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
