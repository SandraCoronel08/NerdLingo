import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptStore, renderTranscriptTxt } from "./transcript-store.js";

test("keeps closed runs isolated by session and starts a clean replacement run", () => {
  const store = new TranscriptStore();
  store.start("stage-1", 1_000);
  store.appendOriginal("stage-1", "Hello");
  store.appendOriginal("stage-1", "world.");
  store.appendSpanish("stage-1", "Hola mundo.");
  store.finish("stage-1", 2_000);

  store.start("stage-2", 1_500);
  store.appendOriginal("stage-2", "Independent stage.");
  store.finish("stage-2", 2_500);

  const firstRun = store.latest("stage-1");
  assert.equal(firstRun?.originalText, "Hello world.");
  assert.equal(firstRun?.spanishText, "Hola mundo.");
  assert.equal(store.latest("stage-2")?.originalText, "Independent stage.");

  store.start("stage-1", 3_000);
  store.appendOriginal("stage-1", "New run.");
  store.finish("stage-1", 4_000);
  assert.equal(store.latest("stage-1")?.originalText, "New run.");
});

test("renders the required UTF-8 TXT structure and uses memory-only fallback", () => {
  const store = new TranscriptStore();
  store.start("stage-1", Date.parse("2026-09-25T09:10:20.123Z"));
  store.appendOriginal("stage-1", "Original text.");
  store.appendSpanish("stage-1", "Texto en español.");
  const run = store.finish("stage-1", Date.parse("2026-09-25T09:10:25.123Z"));
  assert.equal(run?.storageStatus, "memory-only");
  assert.match(renderTranscriptTxt(run!), /Session: stage-1/);
  assert.match(renderTranscriptTxt(run!), /=== ORIGINAL ===\n\nOriginal text\./);
  assert.match(renderTranscriptTxt(run!), /=== ESPAÑOL ===\n\nTexto en español\./);
});

test("keeps the closed transcript in memory when object storage fails", async () => {
  let failureReported = false;
  const store = new TranscriptStore({
    storage: { save: async () => { throw new Error("simulated storage failure"); } },
    onStorageFailure: () => { failureReported = true; },
  });
  store.start("stage-1", 1_000);
  store.appendOriginal("stage-1", "Still exportable.");
  store.finish("stage-1", 2_000);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.latest("stage-1")?.storageStatus, "failed");
  assert.equal(store.monitoring("stage-1").available, true);
  assert.equal(failureReported, true);
});
