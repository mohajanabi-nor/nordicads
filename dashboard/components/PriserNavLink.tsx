"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Nav entry for the Priser tab, carrying a count of unresolved product matches.
 *
 * The badge matters because the pipeline deliberately refuses to guess: a row
 * it cannot identify is parked rather than merged into the wrong product. That
 * is the right call only if somebody finds out — an unresolved item nobody
 * looks at is a price silently missing from the comparison, which is exactly
 * the failure the feature exists to prevent.
 */
export default function PriserNavLink() {
  const [unresolved, setUnresolved] = useState(0);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/priser?badge=1");
        const data = await res.json();
        if (alive) setUnresolved(data.unresolved ?? 0);
      } catch {
        /* the badge is never worth surfacing an error of its own */
      }
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Link
      href="/priser"
      className="relative rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink"
    >
      Priser
      {unresolved > 0 && (
        <span
          className="ml-1.5 rounded-full bg-orange px-1.5 py-0.5 text-[10px] font-bold text-cream"
          title={`${unresolved} varer venter på å bli koblet`}
        >
          {unresolved > 99 ? "99+" : unresolved}
        </span>
      )}
    </Link>
  );
}
