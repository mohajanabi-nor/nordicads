"use client";

import { usePathname } from "next/navigation";
import { useLang } from "@/lib/i18n";

/** Norwegian / English switch. Only shown where a translation exists. */
export default function LangToggle() {
  const { lang, setLang } = useLang();
  const path = usePathname() ?? "";
  if (!path.startsWith("/epost") && !path.startsWith("/picker") && !path.startsWith("/varemottak")) return null;

  const btn = (l: "no" | "en", label: string) => (
    <button
      type="button"
      onClick={() => setLang(l)}
      aria-pressed={lang === l}
      className={`rounded-md px-2 py-1 text-xs font-bold transition ${
        lang === l ? "bg-orange text-cream" : "text-ink/60 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-cream p-0.5">
      {btn("no", "NO")}
      {btn("en", "EN")}
    </div>
  );
}
