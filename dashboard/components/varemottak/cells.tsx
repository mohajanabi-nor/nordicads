"use client";
/* eslint-disable @next/next/no-img-element -- Shopify's CDN already resizes (see thumb()); next/image would proxy 270 images through Vercel for nothing. */

/**
 * Small building blocks for the review table.
 */
import { useEffect, useState } from "react";

export const fmt = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "–"
    : n.toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "–" : `${(n * 100).toFixed(digits).replace(".", ",")} %`);

/** Shopify's CDN resizes on the fly; a 270-row table of full-size images would crawl. */
export function thumb(url: string | null, width = 96): string | null {
  if (!url) return null;
  return url + (url.includes("?") ? "&" : "?") + `width=${width}`;
}

/** "28,5" and "28.5" both mean 28.5. */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A number input that edits as text and commits on blur or Enter. While focused it
 * shows what is being typed; otherwise the stored value, in Norwegian format.
 */
export function NumCell({
  value,
  onCommit,
  digits = 2,
  placeholder,
  className = "",
  title,
  disabled,
}: {
  value: number | null;
  onCommit: (n: number | null) => void;
  digits?: number;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const shown = value === null ? "" : String(value).replace(".", ",");
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);

  const commit = () => {
    setFocused(false);
    const n = parseNum(text);
    if (text.trim() !== "" && n === null) {
      setText(shown); // not a number: put it back
      return;
    }
    if (n !== value) onCommit(n);
  };

  return (
    <input
      value={focused ? text : value === null ? "" : fmt(value, digits)}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        setFocused(true);
        setText(shown);
        e.currentTarget.select();
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(shown);
          e.currentTarget.blur();
        }
      }}
      inputMode="decimal"
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      className={`w-full rounded border border-[#cdbf9d] bg-white px-1.5 py-1 text-right tabular-nums hover:border-orange/60 focus:border-orange focus:outline-none focus:ring-1 focus:ring-orange disabled:border-transparent disabled:bg-transparent ${className}`}
    />
  );
}

export function Badge({ tone, children, title }: { tone: "red" | "yellow" | "green" | "gray" | "orange"; children: React.ReactNode; title?: string }) {
  const tones = {
    red: "bg-red-100 text-red-800",
    yellow: "bg-yellow-100 text-yellow-900",
    green: "bg-green-100 text-green-800",
    gray: "bg-black/5 text-ink/70",
    orange: "bg-orange/15 text-orange",
  } as const;
  return (
    <span title={title} className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** A product picture at a fixed size; an empty box when there is none. */
export function Thumb({ url, size = 56 }: { url: string | null; size?: number }) {
  const src = thumb(url, size * 2);
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded bg-white" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" loading="lazy" className="object-contain" style={{ width: size, height: size }} /> : <span className="text-mute">–</span>}
    </span>
  );
}
