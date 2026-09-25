export type LiveLanguage = "en" | "es";

export function languageLabel(language: LiveLanguage) {
  if (language === "en") return "English";
  return "Spanish";
}
