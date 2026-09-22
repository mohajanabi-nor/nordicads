"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Nav entry for the Logg tab, carrying a count of errors not yet looked at.
 *
 * The point of the badge: the sync now runs on its own every 24 hours, and
 * contacts get unsubscribed automatically. A failure at 03:00 that nobody ever
 * notices is the failure mode this whole tab exists to prevent — so the count
 * has to be visible from every page, not only from the log itself.
 */
export default function LoggNavLink() {
  const [errors, setErrors] = useState(0);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/logs?badge=1");
        const data = await res.json();
        if (alive) setErrors(data.unseenErrors ?? 0);
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
      href="/logg"
      className="relative rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink"
    >
      Logg
      {errors > 0 && (
        <span
          className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
          title={`${errors} feil du ikke har sett på`}
        >
          {errors > 99 ? "99+" : errors}
        </span>
      )}
    </Link>
  );
}
