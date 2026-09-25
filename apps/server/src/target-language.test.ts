import assert from "node:assert/strict";
import test from "node:test";
import { defaultLanguageSelection, languageLabel, languageSelectionFromAudioStart } from "./target-language.js";

test("uses EN to ES by default and accepts only opposite English and Spanish pairs", () => {
  assert.deepEqual(defaultLanguageSelection, { sourceLanguage: "en", targetLanguage: "es" });
  assert.deepEqual(languageSelectionFromAudioStart("es", "en"), { sourceLanguage: "es", targetLanguage: "en" });
  assert.deepEqual(languageSelectionFromAudioStart("en", "en"), defaultLanguageSelection);
  assert.deepEqual(languageSelectionFromAudioStart("es", "es"), defaultLanguageSelection);
  assert.deepEqual(languageSelectionFromAudioStart("en", "fr"), defaultLanguageSelection);
  assert.equal(languageLabel("en"), "English");
  assert.equal(languageLabel("es"), "Spanish");
});
