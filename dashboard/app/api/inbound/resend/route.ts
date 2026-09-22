/**
 * Supplier email arriving from Resend.
 *
 * This handler does as little as possible on purpose. Resend retries a webhook
 * that does not answer quickly, so doing the extraction here would mean a slow
 * Claude call turning into the same email delivered three times. It records
 * that an email exists and returns; the cron poller does the reading.
 *
 * Reachable without a session because Resend has no login — the signature is
 * what authenticates it, checked against the raw bytes before anything is
 * parsed or trusted.
 */
import { is, sbInsert, sbSelect } from "@/lib/supabase";
import { matchSupplier, parseAddress, type SupplierRow } from "@/lib/resend-inbound";
import { verifyWebhookSignature } from "@/lib/webhook-verify";
import { logInfo, logWarn } from "@/lib/eventlog";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  // The signature covers the exact bytes, so read text before JSON.parse.
  const raw = await req.text();
  const check = verifyWebhookSignature(raw, req.headers, process.env.RESEND_WEBHOOK_SECRET || "");
  if (!check.ok) {
    await logWarn("inbound", "inbound.badSignature", `Avviste innkommende webhook: ${check.reason}`);
    return Response.json({ error: "ugyldig signatur" }, { status: 401 });
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "ugyldig JSON" }, { status: 400 });
  }

  // Anything else Resend sends (delivery, bounce, …) is acknowledged and
  // ignored — a non-2xx would make it retry something we will never want.
  if (event.type !== "email.received") {
    return Response.json({ ok: true, ignored: event.type ?? null });
  }

  const data = event.data ?? {};
  const emailId = String(data.email_id ?? data.id ?? "");
  if (!emailId) return Response.json({ error: "mangler email id" }, { status: 400 });

  const fromRaw = String(data.from ?? "");
  const { address: fromAddress, name: fromName } = parseAddress(fromRaw);
  const toList = Array.isArray(data.to) ? data.to.map(String) : [String(data.to ?? "")];

  const suppliers = await sbSelect<SupplierRow>("suppliers", {
    select: "id,name,known_sender_addresses",
    archived: is(false),
  });
  const supplier = matchSupplier(fromAddress, suppliers);

  // ON CONFLICT DO NOTHING: a redelivered webhook must be a no-op, not a second
  // extraction of the same email.
  await sbInsert(
    "supplier_emails",
    {
      resend_email_id: emailId,
      supplier_id: supplier?.id ?? null,
      from_address: fromAddress,
      from_name: fromName,
      to_address: toList[0] ?? "",
      subject: data.subject ? String(data.subject) : null,
      received_at: data.created_at ? String(data.created_at) : new Date().toISOString(),
      status: "received",
      webhook_payload: event,
    },
    { onConflict: "resend_email_id", ignoreDuplicates: true },
  );

  await logInfo(
    "inbound",
    supplier ? "inbound.received" : "inbound.unknownSender",
    supplier
      ? `E-post mottatt fra ${supplier.name} (${fromAddress}).`
      : `E-post fra ukjent avsender ${fromAddress} — lagt i uavklarte.`,
    { emailId, from: fromAddress, supplier: supplier?.name ?? null },
  );

  return Response.json({ ok: true, emailId, supplier: supplier?.name ?? null });
}
