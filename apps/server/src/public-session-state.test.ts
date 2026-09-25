import assert from "node:assert/strict";
import test from "node:test";
import { PublicSessionState } from "./public-session-state.js";

type SentMessage = { sessionId: string; original: string; translated: string; sourceLanguage: string; targetLanguage: string };

function viewer(messages: SentMessage[]) {
  return { readyState: 1, send: (data: string) => messages.push(JSON.parse(data) as SentMessage) };
}

test("publishes translated text and target language without crossing stage boundaries", () => {
  const sessions = new PublicSessionState(["stage-1", "stage-2"], "en", "es");
  const stageOneMessages: SentMessage[] = [];
  const stageTwoMessages: SentMessage[] = [];
  sessions.subscribe("stage-1", viewer(stageOneMessages));
  sessions.subscribe("stage-2", viewer(stageTwoMessages));

  sessions.beginRun("stage-1", "es", "en");
  sessions.setOriginal("stage-1", "Hola mundo.", 320);
  sessions.setTranslated("stage-1", "Hello world.", 410);

  const update = stageOneMessages.at(-1)!;
  assert.equal(update.original, "Hola mundo.");
  assert.equal(update.translated, "Hello world.");
  assert.equal(update.sourceLanguage, "es");
  assert.equal(update.targetLanguage, "en");
  assert.equal(sessions.monitoring("stage-1").firstTranslatedLatencyMs, 410);
  assert.equal(sessions.monitoring("stage-2").sourceLanguage, "en");
  assert.equal(sessions.monitoring("stage-2").targetLanguage, "es");
  assert.equal(stageTwoMessages.at(-1)?.translated, "");
});
