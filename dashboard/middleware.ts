/**
 * The gate. Nothing loads until you are signed in.
 *
 * Runs on every request, so it also refreshes the Supabase session — without
 * that, a valid session expires mid-use and the operator is bounced to the
 * login screen for no reason they can see.
 *
 * Two kinds of exception, and the distinction matters:
 *
 *   /login          — obviously, or there is no way back in.
 *   machine routes  — Resend's inbound webhook, Supabase, and Vercel Cron are
 *                     not browsers and have no session. They authenticate with
 *                     a signature or a shared secret INSIDE the handler. They
 *                     are listed here because that check is theirs to make, not
 *                     because they are open.
 *
 * Anything not listed is protected by default. A new route is private until
 * someone deliberately says otherwise, which is the right way round.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Routes that must be reachable without a session. */
const OPEN_ROUTES = [
  "/api/auth/login", // the way in — it IS the authentication
  "/api/inbound/", // Resend inbound email — verified by Svix signature
  "/api/cron/", // Vercel Cron — verified by CRON_SECRET
];

function isOpenRoute(pathname: string): boolean {
  return OPEN_ROUTES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isOpenRoute(pathname)) return NextResponse.next();

  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_ANON_KEY || "",
    {
      cookies: {
        get: (name: string) => request.cookies.get(name)?.value,
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: "", ...options });
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value: "", ...options });
        },
      },
    },
  );

  // getUser, not getSession: getSession trusts the cookie as-is, while getUser
  // verifies it with Supabase. On a gate, "the cookie says so" is not enough.
  const { data } = await supabase.auth.getUser();
  const signedIn = Boolean(data.user);

  if (pathname === "/login") {
    // Already signed in? Then the login page is just a dead end.
    if (signedIn) return NextResponse.redirect(new URL("/", request.url));
    return response;
  }

  if (!signedIn) {
    // An API call gets a 401 it can act on; a page gets sent to the login
    // screen, remembering where it was going.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "ikke innlogget" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("neste", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and the favicon. Fonts and
     * images are excluded too — they carry nothing worth protecting and would
     * otherwise pay for a session lookup each.
     */
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
