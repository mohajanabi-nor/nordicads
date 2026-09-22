/**
 * The contact list: read it, flip the subscribe checkbox, add one by hand,
 * delete. Everything here is local state — no Shopify, no network.
 *
 * GET                        -> { count, subscribed, unsubscribed, contacts }
 * POST   { email, name?, … } -> add one manually
 * PATCH  { emails[], subscribed } -> bulk subscribe / unsubscribe
 * DELETE { emails[] }        -> remove entirely
 */
import {
  addContact,
  contactStats,
  deleteContacts,
  filterContacts,
  readContacts,
  setSubscribed,
  sortContacts,
} from "@/lib/contacts";
import { ensureScheduler, syncStatus } from "@/lib/scheduler";
import type { ContactFilter, ContactsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;

/**
 * A page of contacts.
 *
 * Search and filter run over the WHOLE list server-side and only then paginate,
 * so a search finds someone on page 12 from the search box. Paging also keeps
 * the browser from holding 800 customer email addresses at once, which matters
 * beyond payload size — that is personal data sitting in a tab.
 */
export async function GET(req: Request) {
  try {
    // Opening the dashboard is what starts the daily sync; there is no cron.
    ensureScheduler();

    const sp = new URL(req.url).searchParams;
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      500,
      Math.max(1, parseInt(sp.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    );
    const q = sp.get("q") ?? "";
    const filter = (sp.get("filter") ?? "alle") as ContactFilter;

    const all = await readContacts();
    const matched = sortContacts(filterContacts(all, q, filter));
    const start = (page - 1) * pageSize;

    const payload: ContactsResponse = {
      // Stats always describe the WHOLE list, never the current page — a header
      // that changed as you paged would be worse than useless.
      ...contactStats(all),
      contacts: matched.slice(start, start + pageSize),
      page,
      pageSize,
      total: matched.length,
      totalPages: Math.max(1, Math.ceil(matched.length / pageSize)),
      sync: await syncStatus(),
    };
    return Response.json(payload);
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      name?: string;
      company?: string;
      city?: string;
      note?: string;
    };
    const email = (body.email ?? "").trim();
    if (!email) {
      return Response.json({ error: "e-postadresse mangler" }, { status: 400 });
    }
    const added = await addContact({ ...body, email });
    if (!added) {
      // Either malformed, or already present — and an existing contact is never
      // overwritten, because that is what protects a recorded opt-out.
      return Response.json(
        { added: false, reason: "ugyldig eller finnes allerede" },
        { status: 409 },
      );
    }
    return Response.json({ added: true, ...contactStats(await readContacts()) });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}

/** Read a body of the shape { emails: string[] }, rejecting anything else. */
async function readEmails(req: Request): Promise<string[] | null> {
  try {
    const body = (await req.json()) as { emails?: unknown };
    if (!Array.isArray(body.emails)) return null;
    const emails = body.emails.filter(
      (e): e is string => typeof e === "string" && e.trim() !== "",
    );
    return emails.length ? emails : null;
  } catch {
    return null;
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.clone().json()) as { subscribed?: unknown };
    if (typeof body.subscribed !== "boolean") {
      return Response.json({ error: "subscribed må være true/false" }, { status: 400 });
    }
    const emails = await readEmails(req);
    if (!emails) {
      return Response.json({ error: "ingen e-postadresser oppgitt" }, { status: 400 });
    }
    const changed = await setSubscribed(emails, body.subscribed);
    return Response.json({ changed, ...contactStats(await readContacts()) });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const emails = await readEmails(req);
    if (!emails) {
      return Response.json({ error: "ingen e-postadresser oppgitt" }, { status: 400 });
    }
    const removed = await deleteContacts(emails);
    return Response.json({ removed, ...contactStats(await readContacts()) });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
