"use client";

import { useEffect, useState } from "react";
import { DownloadTranscriptButton, Metric, StatusBadge, StorageBadge } from "../../components/monitoring-ui";
import { BrandHero, BrandMark } from "../../components/brand-mark";
import { backendHttpUrl } from "../../lib/backend-url";
import { emptyStageMonitoring, firstCaptionLatency, type MonitorResponse, type SessionId, type StageMonitoring, timestamp } from "../../lib/monitoring";

const sessionIds: SessionId[] = ["stage-1", "stage-2"];

export default function MonitorPage() {
  const [stages, setStages] = useState<StageMonitoring[]>(() => sessionIds.map(emptyStageMonitoring));
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(backendHttpUrl("/monitor"), { cache: "no-store" });
        if (!response.ok) throw new Error(`Monitor request failed (${response.status}).`);
        const payload = await response.json() as MonitorResponse;
        if (disposed || !Array.isArray(payload.stages)) return;
        setStages(payload.stages);
        setUpdatedAt(payload.generatedAt);
        setRequestError(null);
      } catch {
        if (!disposed) setRequestError("Monitoring data is temporarily unavailable.");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, []);

  return <main className="nerdlingo-shell mx-auto min-h-screen max-w-6xl px-6 py-12 text-white">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <BrandHero />
        <div className="mt-5"><BrandMark dark compact /></div>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Production monitor</h1>
        <p className="mt-2 text-[#D8E3E6]">All stages · refreshes every 3 seconds · last update {timestamp(updatedAt)}</p>
      </div>
      {requestError ? <p className="rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-800">{requestError}</p> : null}
    </header>

    <section className="mt-8 grid gap-6 lg:grid-cols-2" aria-label="Stage monitoring">
      {stages.map((stage) => <StageCard key={stage.sessionId} stage={stage} />)}
    </section>
  </main>;
}

function StageCard({ stage }: { stage: StageMonitoring }) {
  const stageLabel = stage.sessionId === "stage-1" ? "Stage 1" : "Stage 2";
  const status = stage.lastError ? "error" : stage.status;
  return <article className="nerdlingo-panel rounded-xl border-l-4 border-l-[#00ACA8] p-5 transition hover:-translate-y-0.5">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-2xl font-semibold">{stageLabel}</h2>
        <p className="mt-1 text-sm text-slate-600">Session: {stage.sessionId}</p>
      </div>
      <StatusBadge status={status} />
    </div>

    <dl className="mt-5 grid gap-x-5 gap-y-3 sm:grid-cols-2">
      <Metric label="Producer" value={stage.producerConnected ? "Connected" : "Not connected"} />
      <Metric label="Viewers" value={String(stage.viewerCount)} featured />
    </dl>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3">
      <Metric label="First Original caption" value={firstCaptionLatency(stage.firstOriginalLatencyMs)} featured />
      <Metric label="First Spanish caption" value={firstCaptionLatency(stage.firstSpanishLatencyMs)} featured />
      <Metric label="Transcript storage" value={<StorageBadge status={stage.transcript?.storageStatus ?? null} />} featured />
    </dl>

    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-4">
      <div className="text-sm">
        <p className="font-medium text-slate-700">Last activity</p>
        <p className="mt-1 text-slate-500">{timestamp(stage.lastUpdatedAt)}</p>
        <p className={stage.lastError ? "mt-2 text-red-700" : "mt-2 text-slate-500"}>{stage.lastError ? `Error: ${stage.lastError.message}` : "✓ No recent errors"}</p>
      </div>
      <DownloadTranscriptButton stage={stage} />
    </div>
  </article>;
}
