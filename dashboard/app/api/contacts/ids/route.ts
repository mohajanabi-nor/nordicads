/**
 * Every address matching the current search/filter — just the addresses, no rows.
 *
 * This is what makes «Velg alle 556 som abonnerer» possible. With server-side
 * pagination the browser only ever holds 50 contacts, so selecting the whole
 * subscriber list would otherwise mean paging through twelve pages by hand —
 * and sending to everyone is the main thing this feature is for.
 */
import { filterContacts, isMailable, readContacts } from "@/lib/contacts";
import type { ContactFilter } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const q = sp.get("q") ?? "";
    const filter = (sp.get("filter") ?? "alle") as ContactFilter;
    // Selecting recipients should never hand back someone who cannot be mailed.
    const mailableOnly = sp.get("mailableOnly") === "1";

    let matched = filterContacts(await readContacts(), q, filter);
    if (mailableOnly) matched = matched.filter(isMailable);

    return Response.json({
      emails: matched.map((c) => c.email),
      count: matched.length,
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
