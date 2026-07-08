import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nordic Engros — Drop Tool",
  description: "Kontrollpanel for katalog- og reels-generering",
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="no">
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-20 border-b border-line bg-cream-2/90 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Logo />
            <nav className="flex items-center gap-1 text-sm font-semibold">
              <Link href="/" className="rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink">
                Dashboard
              </Link>
              <Link href="/drops" className="rounded-lg px-3 py-2 text-ink/80 hover:bg-orange/10 hover:text-ink">
                Drops
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
