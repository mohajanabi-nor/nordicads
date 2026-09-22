/**
 * Sign in.
 *
 * A plain route handler taking a normal form POST, rather than a server action.
 * Two reasons: every other entry point in this app is a route handler, and a
 * gate you cannot exercise with curl is a gate nobody checks. It also works with
 * no JavaScript, which a login form should.
 *
 * The password and the anon key never leave the server.
 */
import { NextResponse } from "next/server";

import { authConfigProblems, createClient } from "@/lib/auth";
import { logInfo, logWarn } from "@/lib/eventlog";

export const dynamic = "force-dynamic";

/** Only ever send the operator back to a path inside this app. An open redirect
 *  on a login form is how a convincing phishing link gets built. */
function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function back(req: Request, message: string, next: string): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("feil", message);
  if (next !== "/") url.searchParams.set("neste", next);
  // 303: turn the POST into a GET so a refresh does not re-submit the password.
  return NextResponse.redirect(url, 303);
}

export async function POST(req: Request) {
  let email = "";
  let password = "";
  let next = "/";

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    email = String(body.email ?? "").trim();
    password = String(body.password ?? "");
    next = safeNext(typeof body.neste === "string" ? body.neste : "/");
  } else {
    const form = await req.formData();
    email = String(form.get("email") ?? "").trim();
    password = String(form.get("password") ?? "");
    next = safeNext(String(form.get("neste") ?? ""));
  }

  const problems = authConfigProblems();
  if (problems.length) return back(req, problems.join(" · "), next);
  if (!email || !password) return back(req, "Fyll inn e-post og passord.", next);

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Deliberately vague to the user — saying which half was wrong tells an
    // attacker whether the address exists. The log keeps the detail.
    await logWarn("auth", "auth.failed", `Mislykket innlogging for ${email}.`, {
      email,
      reason: error.message,
    });
    return back(req, "Feil e-post eller passord.", next);
  }

  await logInfo("auth", "auth.signedIn", `Innlogging: ${email}.`, { email });
  return NextResponse.redirect(new URL(next, req.url), 303);
}
