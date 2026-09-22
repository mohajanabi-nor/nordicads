import type { Metadata } from "next";
import Link from "next/link";
import LoggNavLink from "@/components/LoggNavLink";
import PriserNavLink from "@/components/PriserNavLink";
import { currentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nordic Engros — Drop Tool",
  description: "Kontrollpanel for katalog- og reels-generering",
  // The UI is Norwegian and the browser may well be set to another language, so
  // Chrome offers to translate it. Google Translate swaps text nodes underneath
  // React, which then fails with "removeChild: node is not a child of this node"
  // the moment anything re-renders. This is an internal tool — translation is
  // never wanted, so turn it off rather than fight the symptom.
  other: { google: "notranslate" },
};

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-orange text-cream">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 17 L9 8 L13 13 L21 4" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-extrabold tracking-wide text-ink">NORDIC</span>
        <span className="block text-[11px] font-bold tracking-[0.3em] text-orange">ENGROS</span>
      </span>
    </Link>
  );
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Signed out, the nav is a row of links that all bounce back to /login, so it
  // is hidden rather than shown as a set of dead ends.
  const user = await currentUser().catch(() => null);

  return (
    <html lang="no" translate="no">
      <body className="notranslate min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-cream-2/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Logo />
            {user ? (
              <nav className="flex items-center gap-1 text-sm font-semibold">
                <Link href="/" className="rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink">
                  Dashboard
                </Link>
                <Link href="/drops" className="rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink">
                  Drops
                </Link>
                <Link href="/epost" className="rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink">
                  E-post
                </Link>
                <PriserNavLink />
                <LoggNavLink />
                <form action="/api/auth/logout" method="post" className="ml-2 border-l border-line pl-2">
                  <button
                    type="submit"
                    title={user.email ?? undefined}
                    className="rounded-lg px-3 py-2 text-ink/50 hover:bg-orange/10 hover:text-ink"
                  >
                    Logg ut
                  </button>
                </form>
              </nav>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
