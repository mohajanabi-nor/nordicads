/**
 * The supplier list.
 *
 * An unrecognised sender cannot be attributed until a supplier claims its
 * domain, so managing this list is part of the review flow rather than a
 * settings page nobody opens.
 */
import { eq, is, sbInsert, sbSelect, sbUpdate } from "@/lib/supabase";
import { logInfo } from "@/lib/eventlog";

export const dynamic = "force-dynamic";

function slugify(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "leverandor";
}

export async function GET() {
  const suppliers = await sbSelect("suppliers", { archived: is(false), order: "name.asc" });
  return Response.json({ suppliers });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; senders?: string[]; id?: string };
    const senders = (body.senders ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (body.id) {
      const rows = await sbUpdate("suppliers", { id: eq(body.id) }, { known_sender_addresses: senders });
      return Response.json({ ok: true, supplier: rows[0] ?? null });
    }

    const name = (body.name ?? "").trim();
    if (!name) return Response.json({ error: "navn mangler" }, { status: 400 });

    const created = await sbInsert("suppliers", {
      name,
      slug: slugify(name),
      known_sender_addresses: senders,
    }, { returning: true });

    await logInfo("priser", "priser.supplierAdded", `Leverandør lagt til: ${name}`, { senders });
    return Response.json({ ok: true, supplier: created[0] });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
