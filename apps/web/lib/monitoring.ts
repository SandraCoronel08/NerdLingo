import { backendHttpUrl } from "./backend-url";
import type { LiveLanguage } from "./target-language";

export type SessionId = "stage-1" | "stage-2";

export type StageMonitoring = {
  sessionId: SessionId;
  status: "offline" | "live";
  sourceLanguage: LiveLanguage;
  targetLanguage: LiveLanguage;
  producerConnected: boolean;
  viewerCount: number;
  lastUpdatedAt: number | null;
  lastOriginalAt: number | null;
  lastTranslatedAt: number | null;
  firstOriginalLatencyMs: number | null;
  firstTranslatedLatencyMs: number | null;
  lastError: { message: string; at: number } | null;
  transcript: { available: boolean; storageStatus: "pending" | "stored" | "memory-only" | "failed" | null };
};

export type MonitorResponse = { generatedAt: number; stages: StageMonitoring[] };

export function emptyStageMonitoring(sessionId: SessionId): StageMonitoring {
  return {
    sessionId,
    status: "offline",
    sourceLanguage: "en",
    targetLanguage: "es",
    producerConnected: false,
    viewerCount: 0,
    lastUpdatedAt: null,
    lastOriginalAt: null,
    lastTranslatedAt: null,
    firstOriginalLatencyMs: null,
    firstTranslatedLatencyMs: null,
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
