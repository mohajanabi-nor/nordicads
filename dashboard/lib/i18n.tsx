"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Lang = "no" | "en";

const STORAGE_KEY = "lang";

interface LangValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Pick the string for the current language: t("Norsk", "English"). */
  t: (no: string, en: string) => string;
  /** Locale for dates and numbers. */
  locale: string;
}

const LangContext = createContext<LangValue>({
  lang: "no",
  setLang: () => {},
  t: (no) => no,
  locale: "no-NO",
});

/**
 * Only /epost and /picker are translated; everything else stays Norwegian.
 * The server always renders Norwegian and the saved choice is applied after
 * mount, so the first paint matches the server and hydration stays clean.
 */
export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("no");

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "en") setLangState("en");
    } catch {
      /* storage blocked — stay on Norwegian */
    }
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* the choice just won't persist */
    }
  }, []);

  const value: LangValue = {
    lang,
    setLang,
    t: (no, en) => (lang === "en" ? en : no),
    locale: lang === "en" ? "en-GB" : "no-NO",
  };

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangValue {
  return useContext(LangContext);
}
