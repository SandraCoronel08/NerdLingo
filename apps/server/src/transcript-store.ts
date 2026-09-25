import { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";
import { languageLabel, type LiveLanguage } from "./target-language.js";

export type TranscriptStorageStatus = "pending" | "stored" | "memory-only" | "failed";

export type TranscriptRun = {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  originalText: string;
  translatedText: string;
  sourceLanguage: LiveLanguage;
  targetLanguage: LiveLanguage;
  storageStatus: TranscriptStorageStatus;
};

export type TranscriptMonitoring = {
  available: boolean;
  storageStatus: Exclude<TranscriptStorageStatus, "pending"> | "pending" | null;
};

type TranscriptObjectStorage = {
  save(name: string, contents: string, contentType: string): Promise<void>;
};

type TranscriptStoreOptions = {
  storage?: TranscriptObjectStorage;
  onStorageFailure?: (sessionId: string) => void;
};

function appendTranscriptDelta(current: string, delta: string) {
  if (!current) return delta;
  if (!delta) return current;
  if (/^\s/.test(delta) || /\s$/.test(current) || /^[,.;:!?\)\]\}]/.test(delta)) return current + delta;
  return `${current} ${delta}`;
}

function transcriptId(startedAt: number) {
  return `${new Date(startedAt).toISOString()}-${randomUUID()}`;
}

function contentTypeForTxt() {
  return "text/plain; charset=utf-8";
}

export function renderTranscriptTxt(run: TranscriptRun) {
  const endedAt = run.endedAt === null ? "" : new Date(run.endedAt).toISOString();
  return [
    "NerdLingo transcript",
    `Session: ${run.sessionId}`,
    `Started: ${new Date(run.startedAt).toISOString()}`,
    `Ended: ${endedAt}`,
    "",
    `=== ORIGINAL (${languageLabel(run.sourceLanguage)}) ===`,
    "",
    run.originalText,
    "",
    `=== TRANSLATED (${languageLabel(run.targetLanguage)}) ===`,
    "",
    run.translatedText,
    "",
  ].join("\n");
}

export function createGcsTranscriptStorageFromEnv(environment: NodeJS.ProcessEnv): TranscriptObjectStorage | undefined {
  const projectId = environment.GCS_PROJECT_ID;
  const bucketName = environment.GCS_BUCKET_NAME;
  const serviceAccountJson = environment.GCS_SERVICE_ACCOUNT_JSON;
  if (!projectId || !bucketName || !serviceAccountJson) return undefined;

  try {
    const credentials = JSON.parse(serviceAccountJson) as { client_email?: string; private_key?: string };
    if (!credentials.client_email || !credentials.private_key) throw new Error("Missing service account fields.");
    const bucket = new Storage({ projectId, credentials }).bucket(bucketName);
    return {
      async save(name, contents, contentType) {
        await bucket.file(name).save(contents, { contentType, resumable: false });
      },
    };
  } catch {
    console.warn("GCS transcript persistence is disabled because its service account configuration is invalid.");
    return undefined;
  }
}

export class TranscriptStore {
  private readonly activeRuns = new Map<string, TranscriptRun>();
  private readonly lastClosedRuns = new Map<string, TranscriptRun>();
  private readonly storage: TranscriptObjectStorage | undefined;
  private readonly onStorageFailure: ((sessionId: string) => void) | undefined;

  constructor(options: TranscriptStoreOptions = {}) {
    this.storage = options.storage;
    this.onStorageFailure = options.onStorageFailure;
  }

  start(sessionId: string, sourceLanguage: LiveLanguage, targetLanguage: LiveLanguage, startedAt = Date.now()) {
    this.finish(sessionId, startedAt);
    const run: TranscriptRun = {
      id: transcriptId(startedAt),
      sessionId,
      startedAt,
      endedAt: null,
      originalText: "",
      translatedText: "",
      sourceLanguage,
      targetLanguage,
      storageStatus: this.storage ? "pending" : "memory-only",
    };
    this.activeRuns.set(sessionId, run);
    return run;
  }

  appendOriginal(sessionId: string, text: string) {
    const run = this.activeRuns.get(sessionId);
    if (run && text) run.originalText = appendTranscriptDelta(run.originalText, text);
  }

  appendTranslated(sessionId: string, text: string) {
    const run = this.activeRuns.get(sessionId);
    if (run && text) run.translatedText = appendTranscriptDelta(run.translatedText, text);
  }

  finish(sessionId: string, endedAt = Date.now()) {
    const run = this.activeRuns.get(sessionId);
    if (!run) return undefined;

    this.activeRuns.delete(sessionId);
    run.endedAt = endedAt;
    this.lastClosedRuns.set(sessionId, run);
    if (this.storage) void this.persist(run);
    return run;
  }

  latest(sessionId: string) {
    return this.lastClosedRuns.get(sessionId);
  }

  monitoring(sessionId: string): TranscriptMonitoring {
    const run = this.latest(sessionId);
    return {
      available: Boolean(run && (run.originalText || run.translatedText)),
      storageStatus: run?.storageStatus ?? null,
    };
  }

  private async persist(run: TranscriptRun) {
    try {
      await this.storage?.save(`transcripts/${run.sessionId}/${run.id}/transcript.txt`, renderTranscriptTxt(run), contentTypeForTxt());
      run.storageStatus = "stored";
    } catch {
      run.storageStatus = "failed";
      this.onStorageFailure?.(run.sessionId);
      console.warn(`[${run.sessionId}] transcript persistence failed; the in-memory export remains available.`);
    }
  }
}
