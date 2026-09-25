import { backendHttpUrl } from "./backend-url";

export type SessionId = "stage-1" | "stage-2";

export type StageMonitoring = {
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

export type MonitorResponse = { generatedAt: number; stages: StageMonitoring[] };

export function emptyStageMonitoring(sessionId: SessionId): StageMonitoring {
  return {
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
  };
}

export function timestamp(value: number | null) {
  return value === null ? "—" : new Date(value).toLocaleTimeString();
}

export function firstCaptionLatency(value: number | null) {
  return value === null ? "Not available" : `${(value / 1_000).toFixed(1)} s`;
}

export function storageStatus(value: StageMonitoring["transcript"]["storageStatus"]) {
  if (value === "stored") return "Stored";
  if (value === "memory-only") return "Memory only";
  if (value === "failed") return "Failed";
  if (value === "pending") return "Saving";
  return "Not available";
}

export function transcriptUrl(sessionId: SessionId) {
  return backendHttpUrl(`/transcript/${sessionId}`);
}
