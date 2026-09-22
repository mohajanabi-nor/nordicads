/** Sign out, then back to the login screen. */
import { NextResponse } from "next/server";

import { createClient } from "@/lib/auth";
import { logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  await supabase.auth.signOut();
  if (data.user?.email) {
    await logInfo("auth", "auth.signedOut", `Logget ut: ${data.user.email}.`, {
      email: data.user.email,
    });
  }
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
