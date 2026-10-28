"use client";

import { useLang } from "@/lib/i18n";
import { translateMessage } from "@/lib/varemottak/messages";

/**
 * Translation for the Varemottak pages.
 *   t("Norsk", "English")  — text written in the component
 *   m(text)                — a message that came from the server (always Norwegian there)
 */
export function useTr() {
  const { lang, t, locale } = useLang();
  const m = (text: string) => (lang === "en" ? translateMessage(text) : text);
  return { t, m, lang, locale };
}
