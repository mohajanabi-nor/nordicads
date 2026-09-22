/**
 * Who is allowed in.
 *
 * The tool had no auth at all: it ran on one laptop, so the machine was the
 * perimeter. Hosted, the URL is the perimeter, and an unauthenticated
 * `/api/generate` is a button strangers can press to spend Actions minutes and
 * Shopify quota — never mind the customer list sitting behind `/epost`.
 *
 * Supabase Auth does the password handling. This is the one place the no-SDK
 * rule is worth breaking: session cookies, token refresh and constant-time
 * comparisons are a bad thing to re-derive from scratch, and the project already
 * depends on Supabase for everything else anyway.
 *
 * There is no sign-up route. The single account is created by hand in the
 * Supabase dashboard, because this tool has exactly one operator and an open
 * registration form would be a liability rather than a feature.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export function authConfig() {
  return {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
  };
}

export function authConfigProblems(): string[] {
  const cfg = authConfig();
  const problems: string[] = [];
  if (!cfg.url) problems.push("SUPABASE_URL mangler");
  if (!cfg.anonKey) problems.push("SUPABASE_ANON_KEY mangler");
  return problems;
}

/**
 * A Supabase client bound to the request's cookies, for use in route handlers
 * and server components.
 *
 * Deliberately the ANON key, not the service-role one: this client acts as the
 * signed-in user, and handing it a key that bypasses RLS would defeat the point
 * of having a session at all.
 */
export function createClient() {
  const cookieStore = cookies();
  const cfg = authConfig();

  return createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          /* as above */
        }
      },
    },
  });
}

/** The signed-in user, or null. */
export async function currentUser() {
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}
