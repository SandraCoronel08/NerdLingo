"use client";

import { useEffect, useState } from "react";
import { backendHttpUrl } from "../../lib/backend-url";

type SessionId = "stage-1" | "stage-2";
type StageMonitoring = {
  sessionId: SessionId;
  status: "offline" | "live";
  producerConnected: boolean;
  viewerCount: number;
  lastUpdatedAt: number | null;
  lastOriginalAt: number | null;
  lastSpanishAt: number | null;
  firstOriginalLatencyMs: number | null;
  firstSpanishLatencyMs: number | null;
  lastError: { message: string; at: number } | null;
  transcript: { available: boolean; storageStatus: "pending" | "stored" | "memory-only" | "failed" | null };
};

type MonitorResponse = { generatedAt: number; stages: StageMonitoring[] };

const sessionIds: SessionId[] = ["stage-1", "stage-2"];
const initialStages: StageMonitoring[] = sessionIds.map((sessionId) => ({
  sessionId,
  status: "offline",
  producerConnected: false,
  viewerCount: 0,
  lastUpdatedAt: null,
  lastOriginalAt: null,
  lastSpanishAt: null,
  firstOriginalLatencyMs: null,
  firstSpanishLatencyMs: null,
  lastError: null,
  transcript: { available: false, storageStatus: null },
}));

function timestamp(value: number | null) {
  return value === null ? "—" : new Date(value).toLocaleTimeString();
}

function latency(value: number | null) {
  return value === null ? "Not available" : `${value} ms`;
}

function transcriptUrl(sessionId: SessionId) {
  return backendHttpUrl(`/transcript/${sessionId}`);
}

function storageStatus(value: StageMonitoring["transcript"]["storageStatus"]) {
  if (value === "stored") return "Stored";
  if (value === "memory-only") return "Memory only";
  if (value === "failed") return "Failed";
  if (value === "pending") return "Saving…";
  return "Not available";
}

export default function MonitorPage() {
  const [stages, setStages] = useState(initialStages);
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
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-12 text-slate-950">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-700">NerdLingo</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Production monitor</h1>
          <p className="mt-2 text-slate-600">Refreshes every 3 seconds. Last dashboard update: {timestamp(updatedAt)}</p>
        </div>
        {requestError ? <p className="rounded bg-red-100 px-3 py-2 text-sm font-medium text-red-800">{requestError}</p> : null}
      </header>

      <section className="mt-8 grid gap-6 lg:grid-cols-2" aria-label="Stage monitoring">
        {stages.map((stage) => {
          const stageLabel = stage.sessionId === "stage-1" ? "Stage 1" : "Stage 2";
          const hasError = stage.lastError !== null;
          return <article key={stage.sessionId} className={`rounded-xl border p-6 shadow-sm ${hasError ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold">{stageLabel}</h2>
                <p className="mt-1 text-sm text-slate-600">Session: {stage.sessionId}</p>
              </div>
              <p className={`rounded-full px-3 py-1 text-sm font-semibold ${stage.status === "live" ? "bg-emerald-200 text-emerald-900" : "bg-slate-200 text-slate-700"}`}>{stage.status === "live" ? "Live" : "Offline"}</p>
            </div>

            <dl className="mt-6 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Metric label="Producer" value={stage.producerConnected ? "Connected" : "Not connected"} />
              <Metric label="Viewers" value={String(stage.viewerCount)} />
              <Metric label="Last update" value={timestamp(stage.lastUpdatedAt)} />
              <Metric label="Original update" value={timestamp(stage.lastOriginalAt)} />
              <Metric label="Spanish update" value={timestamp(stage.lastSpanishAt)} />
              <Metric label="First original latency" value={latency(stage.firstOriginalLatencyMs)} />
              <Metric label="First Spanish latency" value={latency(stage.firstSpanishLatencyMs)} />
              <Metric label="Transcript storage" value={storageStatus(stage.transcript?.storageStatus ?? null)} />
            </dl>

            <div className="mt-6">
              {stage.transcript?.available ? <a className="inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white" href={`${transcriptUrl(stage.sessionId)}?format=txt`}>
                Download TXT
              </a> : <span className="inline-flex rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500">No transcript yet</span>}
            </div>

            {stage.lastError ? <div className="mt-6 rounded-lg border border-red-200 bg-white/70 p-4 text-sm text-red-900">
              <p className="font-semibold">Recent error</p>
              <p className="mt-1">{stage.lastError.message}</p>
              <p className="mt-1 text-red-700">{timestamp(stage.lastError.at)}</p>
            </div> : null}
          </article>;
        })}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div>
    <dt className="text-sm font-medium text-slate-600">{label}</dt>
    <dd className="mt-1 font-semibold text-slate-950">{value}</dd>
  </div>;
}
