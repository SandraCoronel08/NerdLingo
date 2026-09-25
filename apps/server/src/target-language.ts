export const supportedLiveLanguages = ["en", "es"] as const;

export type LiveLanguage = (typeof supportedLiveLanguages)[number];
export type LanguageSelection = { sourceLanguage: LiveLanguage; targetLanguage: LiveLanguage };

export const defaultLanguageSelection: LanguageSelection = { sourceLanguage: "en", targetLanguage: "es" };

function isLiveLanguage(value: string | undefined): value is LiveLanguage {
  return supportedLiveLanguages.includes(value as LiveLanguage);
}

export function languageSelectionFromAudioStart(sourceLanguage: string | undefined, targetLanguage: string | undefined): LanguageSelection {
  if (!isLiveLanguage(sourceLanguage) || !isLiveLanguage(targetLanguage) || sourceLanguage === targetLanguage) return defaultLanguageSelection;
  return { sourceLanguage, targetLanguage };
}

export function languageLabel(language: LiveLanguage) {
  if (language === "en") return "English";
  return "Spanish";
}
