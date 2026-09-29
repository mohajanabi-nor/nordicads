"use client";

/**
 * The last resort when a page crashes while rendering: report it to Sentry and show
 * something better than a blank screen.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="no">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 20 }}>Noe gikk galt</h1>
        <p>Feilen er rapportert. Prøv igjen, eller last siden på nytt.</p>
        <button onClick={() => reset()} style={{ padding: "10px 18px", cursor: "pointer" }}>
          Prøv igjen
        </button>
      </body>
    </html>
  );
}
