"use client";

import { useEffect, useState } from "react";
import { backendWebSocketUrl } from "../../../lib/backend-url";
import { overlayCaption, type OverlayLanguage } from "../../../lib/caption-language";
import type { LiveLanguage } from "../../../lib/target-language";

type SessionId = "stage-1" | "stage-2";
type OverlayState = {
  status: "offline" | "live";
  original: string;
  translated: string;
  targetLanguage: LiveLanguage;
};

const maxWordsPerCaptionBlock = 8;
const maxCharactersPerCaptionBlock = 54;

type CaptionLines = {
  top: string;
  bottom: string;
  exitingTop: string;
  rolling: boolean;
};

const emptyLines: CaptionLines = { top: "", bottom: "", exitingTop: "", rolling: false };

function normalizeCaption(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function captionUnits(text: string) {
  const sentences = normalizeCaption(text).match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  return sentences.flatMap((sentence) => {
    const words = sentence.trim().split(" ").filter(Boolean);
    const blocks: string[] = [];
    let block: string[] = [];
    for (const word of words) {
      const nextBlock = [...block, word];
      if (block.length && (nextBlock.length > maxWordsPerCaptionBlock || nextBlock.join(" ").length > maxCharactersPerCaptionBlock)) {
        blocks.push(block.join(" "));
        block = [word];
      } else {
        block = nextBlock;
      }
    }
    if (block.length) blocks.push(block.join(" "));
    return blocks;
  });
}

function desiredLines(units: string[]): Pick<CaptionLines, "top" | "bottom"> {
  if (units.length === 0) return { top: "", bottom: "" };
  if (units.length === 1) return { top: units[0], bottom: "" };
  return { top: units.at(-2) ?? "", bottom: units.at(-1) ?? "" };
}

function reconcileCaptionLines(current: CaptionLines, nextLines: Pick<CaptionLines, "top" | "bottom">): CaptionLines {
  if (!nextLines.top) return current.top || current.bottom ? emptyLines : current;
  if (!current.top) return { top: nextLines.top, bottom: nextLines.bottom, exitingTop: "", rolling: false };
  if (current.top === nextLines.top && current.bottom === nextLines.bottom) return current;

  const promotesBottom = Boolean(current.bottom && current.bottom === nextLines.top && current.top !== nextLines.top);
  if (promotesBottom) {
    return { top: nextLines.top, bottom: nextLines.bottom, exitingTop: current.top, rolling: true };
  }

  return { top: nextLines.top, bottom: nextLines.bottom, exitingTop: "", rolling: false };
}

export default function OverlayClient({ sessionId, language }: { sessionId: SessionId; language: OverlayLanguage }) {
  const [lines, setLines] = useState<CaptionLines>(emptyLines);

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
            translated?: string;
            targetLanguage?: LiveLanguage;
          };
          if (message.sessionId !== sessionId || (message.status !== "live" && message.status !== "offline")) return;
          const nextState = { status: message.status, original: message.original ?? "", translated: message.translated ?? "", targetLanguage: message.targetLanguage ?? "es" };
          const nextCaption = overlayCaption(language, nextState);
          setLines((current) => reconcileCaptionLines(current, desiredLines(nextState.status === "live" ? captionUnits(nextCaption) : [])));
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
  }, [language, sessionId]);

  const finishRollover = () => {
    setLines((current) => current.rolling ? { ...current, exitingTop: "", rolling: false } : current);
  };

  return (
    <main className="nerdlingo-overlay flex min-h-screen items-end justify-center bg-transparent px-[5vw] pb-[8vh] pt-[30vh] text-center text-white" aria-live="polite" aria-label="Live captions overlay">
      {lines.top ? (
        <div className="w-[86vw] max-w-[1500px] overflow-hidden rounded-lg bg-black/55 px-5 py-2 shadow-[0_2px_8px_rgb(0_0_0_/_0.95)] sm:px-6">
          <div className="text-[clamp(1.75rem,2.2vw,2.625rem)] font-semibold leading-[1.2] tracking-tight">
          <div className={`relative ${lines.bottom ? "h-[2.4em]" : "h-[1.2em]"}`}>
            {lines.rolling && lines.exitingTop ? <CaptionLine className="overlay-caption-exiting" text={lines.exitingTop} /> : null}
            <CaptionLine className={lines.rolling ? "overlay-caption-promoting" : ""} text={lines.top} onAnimationEnd={lines.rolling ? finishRollover : undefined} />
            {lines.bottom ? <CaptionLine className={`top-[1.2em] ${lines.rolling ? "overlay-caption-entering" : ""}`} text={lines.bottom} /> : null}
          </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function CaptionLine({ className = "", onAnimationEnd, text }: { className?: string; onAnimationEnd?: () => void; text: string }) {
  return (
    <div className={`absolute left-0 top-0 w-full ${className}`} onAnimationEnd={onAnimationEnd}>
      <p>{text}</p>
    </div>
  );
}
