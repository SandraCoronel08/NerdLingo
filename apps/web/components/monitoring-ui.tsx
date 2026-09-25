import type { StageMonitoring } from "../lib/monitoring";
import { transcriptUrl } from "../lib/monitoring";
import type { ReactNode } from "react";

export function StatusBadge({ status }: { status: "live" | "offline" | "connecting" | "error" | "ready" | "finishing" }) {
  const labels = { live: "Live", offline: "Offline", connecting: "Connecting", error: "Error", ready: "Ready", finishing: "Finishing" };
  const colors = {
    live: "bg-[#DDF5E7] text-[#006D32]",
    offline: "bg-[#D8E3E6] text-[#34495E]",
    connecting: "bg-[#DDF5FF] text-[#236EE2]",
    error: "bg-[#FFE0E2] text-[#B61F29]",
    ready: "bg-[#D8E3E6] text-[#34495E]",
    finishing: "bg-[#FFF0CC] text-[#8A5900]",
  };
  return <span className={`rounded-full px-3 py-1 text-sm font-semibold ${colors[status]} ${status === "live" ? "brand-live-pulse" : ""}`}>{labels[status]}</span>;
}

export function Metric({ label, value, featured = false }: { label: string; value: ReactNode; featured?: boolean }) {
  return <div className={featured ? "rounded-lg border border-slate-200 bg-slate-50 p-3" : ""}>
    <dt className="text-sm font-medium text-slate-600">{label}</dt>
    <dd className={`mt-1 font-semibold text-slate-950 ${featured ? "text-2xl" : ""}`}>{value}</dd>
  </div>;
}

export function StorageBadge({ status }: { status: StageMonitoring["transcript"]["storageStatus"] }) {
  const styles = {
    stored: "bg-[#DDF5E7] text-[#006D32]",
    pending: "bg-[#DDF5FF] text-[#236EE2]",
    "memory-only": "bg-[#FFF0CC] text-[#8A5900]",
    failed: "bg-[#FFE0E2] text-[#B61F29]",
    unavailable: "bg-[#D8E3E6] text-[#34495E]",
  };
  const labels = { stored: "Stored", pending: "Saving", "memory-only": "Memory only", failed: "Failed", unavailable: "Not available" };
  const key = status ?? "unavailable";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-sm font-semibold ${styles[key]}`}>{labels[key]}</span>;
}

export function DownloadTranscriptButton({ stage }: { stage: StageMonitoring }) {
  return stage.transcript?.available ? <a className="inline-flex rounded-lg bg-[#00ACA8] px-3 py-1.5 text-sm font-semibold text-[#1A1A1A]" href={`${transcriptUrl(stage.sessionId)}?format=txt`}>
    Download TXT
  </a> : <span className="inline-flex rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500">No transcript yet</span>;
}
