import assert from "node:assert/strict";
import test from "node:test";
import { audienceLanguageLabels, overlayCaption, overlayLanguageFromQuery } from "./caption-language.js";

test("maps ES to EN metadata to audience labels and the matching English overlay", () => {
  const state = { original: "Hola mundo.", translated: "Hello world.", targetLanguage: "en" as const };
  assert.deepEqual(audienceLanguageLabels("es", "en"), { original: "Original (Spanish)", translated: "English" });
  assert.equal(overlayLanguageFromQuery("en"), "en");
  assert.equal(overlayCaption("en", state), "Hello world.");
  assert.equal(overlayCaption("es", state), "");
});

test("maps EN to ES metadata and keeps original overlay available", () => {
  const state = { original: "Hello world.", translated: "Hola mundo.", targetLanguage: "es" as const };
  assert.deepEqual(audienceLanguageLabels("en", "es"), { original: "Original (English)", translated: "Spanish" });
  assert.equal(overlayLanguageFromQuery("es"), "es");
  assert.equal(overlayCaption("es", state), "Hola mundo.");
  assert.equal(overlayCaption("original", state), "Hello world.");
});
