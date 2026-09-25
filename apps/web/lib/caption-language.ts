import { languageLabel, type LiveLanguage } from "./target-language";

export type OverlayLanguage = LiveLanguage | "original";

export function overlayLanguageFromQuery(value: string | undefined): OverlayLanguage {
  return value === "original" || value === "en" ? value : "es";
}

export function overlayCaption(language: OverlayLanguage, state: { original: string; translated: string; targetLanguage: LiveLanguage }) {
  if (language === "original") return state.original;
  return language === state.targetLanguage ? state.translated : "";
}

export function audienceLanguageLabels(sourceLanguage: LiveLanguage, targetLanguage: LiveLanguage) {
  return {
    original: `Original (${languageLabel(sourceLanguage)})`,
    translated: languageLabel(targetLanguage),
  };
}
