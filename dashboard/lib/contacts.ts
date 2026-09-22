/**
 * The local contact list — the recipient source for e-post campaigns.
 *
 * The store is on Shopify Basic, where a custom app cannot read customer email
 * addresses (that is "Level 2 protected customer data" and needs Grow or above).
 * So the list is not fetched: the operator exports customers from Shopify admin
 * once a week and imports the CSV here.
 *
 * The rule that makes that safe is UPSERT-WITH-SKIP: an email we already know is
 * left completely untouched on re-import. If someone unsubscribed last month,
 * next week's import cannot silently resubscribe them. Unsubscribed contacts are
 * kept (never deleted) for exactly the same reason.
 *
 * Server-only — this module touches the filesystem.
 */
import fs from "node:fs";
import path from "node:path";

import type { Contact, ContactFilter, ContactStats, ImportResult } from "./types";
import { WORKER_DIR } from "./worker";

/** Where the contact list and campaign logs live. Already gitignored via
 *  `worker/state/`, so customer addresses can never be committed. */
export const EMAIL_STATE_DIR =
  process.env.EMAIL_STATE_DIR || path.join(WORKER_DIR, "state", "email");

const CONTACTS_FILE = path.join(EMAIL_STATE_DIR, "contacts.json");

/** v1 had no shopifyId / invalidEmail / missingInShopify / failureCount. There is
 *  no migration system in this repo, so the loader backfills on read and the
 *  file is only rewritten on the next ordinary write. */
const SCHEMA_VERSION = 2;

interface ContactsFile {
  version: number;
  contacts: Contact[];
}

/** Fill in fields a v1 record predates. Cheap, and keeps every reader honest
 *  without a migration step anyone has to remember to run. */
function upgrade(raw: Partial<Contact> & { email: string }): Contact {
  return {
    email: raw.email,
    shopifyId: raw.shopifyId ?? null,
    name: raw.name ?? "",
    company: raw.company ?? "",
    city: raw.city ?? "",
    subscribed: raw.subscribed ?? true,
    invalidEmail: raw.invalidEmail ?? false,
    missingInShopify: raw.missingInShopify ?? false,
    lastSeenInShopifyAt: raw.lastSeenInShopifyAt ?? null,
    failureCount: raw.failureCount ?? 0,
    addedAt: raw.addedAt ?? new Date().toISOString(),
    source: raw.source ?? "ukjent",
    lastSentAt: raw.lastSentAt ?? null,
    note: raw.note ?? "",
  };
}

/**
 * The single place that decides who a campaign may be sent to.
 *
 * Kept as one function on purpose: the picker count, the send route and the
 * runner all ask this, so the rule cannot drift between what the operator is
 * shown and what actually goes out.
 */
export function isMailable(c: Contact): boolean {
  return c.subscribed && !c.invalidEmail && !c.missingInShopify;
}

// ---------------------------------------------------------------- storage ---

/** Normalise an address for use as the primary key. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Deliberately permissive: we reject the obviously-broken (no @, spaces, no
 *  dot in the domain) and let the mail server judge the rest. Being stricter
 *  than this rejects valid addresses far more often than it catches typos. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(email);
}

export function readContacts(): Contact[] {
  try {
    const raw = fs.readFileSync(CONTACTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as ContactsFile;
    if (!Array.isArray(parsed.contacts)) return [];
    return parsed.contacts.filter((c) => c?.email).map(upgrade);
  } catch {
    return []; // no file yet, or unreadable — an empty list is the right start
  }
}

/**
 * Write the whole list atomically: a partial write here would lose the only
 * record of who has opted out, so we never truncate the real file. Write a temp
 * file, fsync it, then rename — rename is atomic on both macOS and Windows.
 */
function writeContacts(contacts: Contact[]): void {
  fs.mkdirSync(EMAIL_STATE_DIR, { recursive: true });
  const payload: ContactsFile = { version: SCHEMA_VERSION, contacts };
  const tmp = `${CONTACTS_FILE}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, CONTACTS_FILE);
}

/**
 * Serialise every mutation through one promise chain. Two concurrent requests
 * (a bulk toggle and an import, say) would otherwise both read the list, both
 * write it, and the second would silently discard the first's changes.
 * Kept on globalThis so Next.js dev hot-reload doesn't hand out a second lock.
 */
const _g = globalThis as unknown as { _contactsLock?: Promise<unknown> };

function withLock<T>(fn: () => T): Promise<T> {
  const run = () => fn();
  // .then(run, run) so one failed mutation never wedges the queue.
  const next = (_g._contactsLock ?? Promise.resolve()).then(run, run);
  _g._contactsLock = next.catch(() => undefined);
  return next;
}

// ------------------------------------------------------------------ reads ---

export function contactStats(contacts: Contact[] = readContacts()): ContactStats {
  let subscribed = 0;
  let invalid = 0;
  let missing = 0;
  let mailable = 0;
  for (const c of contacts) {
    if (c.subscribed) subscribed++;
    if (c.invalidEmail) invalid++;
    if (c.missingInShopify) missing++;
    if (isMailable(c)) mailable++;
  }
  return {
    count: contacts.length,
    subscribed,
    unsubscribed: contacts.length - subscribed,
    invalid,
    missing,
    mailable,
  };
}

/** The addresses a campaign may actually be sent to. */
export function mailableEmails(): Set<string> {
  return new Set(readContacts().filter(isMailable).map((c) => c.email));
}

/**
 * Search and filter across the WHOLE list, before any pagination.
 *
 * Deliberately separate from paging: searching must find someone on page 12
 * from the search box, which it cannot do if the filter only ever sees the 50
 * rows currently on screen.
 */
export function filterContacts(
  contacts: Contact[],
  q: string,
  filter: ContactFilter,
): Contact[] {
  const needle = q.trim().toLowerCase();
  return contacts.filter((c) => {
    switch (filter) {
      case "abonnerer":
        if (!isMailable(c)) return false;
        break;
      case "avmeldt":
        if (c.subscribed) return false;
        break;
      case "ugyldig":
        if (!c.invalidEmail) return false;
        break;
      case "borte":
        if (!c.missingInShopify) return false;
        break;
      default:
        break;
    }
    if (!needle) return true;
    return `${c.email} ${c.name} ${c.company} ${c.city}`.toLowerCase().includes(needle);
  });
}

/** Newest first, so a fresh sync is visible at the top. */
export function sortContacts(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

// -------------------------------------------------------------- mutations ---

export function setSubscribed(emails: string[], subscribed: boolean): Promise<number> {
  const wanted = new Set(emails.map(normalizeEmail));
  return withLock(() => {
    const contacts = readContacts();
    let changed = 0;
    for (const c of contacts) {
      if (wanted.has(c.email) && c.subscribed !== subscribed) {
        c.subscribed = subscribed;
        changed++;
      }
    }
    if (changed) writeContacts(contacts);
    return changed;
  });
}

export function deleteContacts(emails: string[]): Promise<number> {
  const wanted = new Set(emails.map(normalizeEmail));
  return withLock(() => {
    const contacts = readContacts();
    const kept = contacts.filter((c) => !wanted.has(c.email));
    const removed = contacts.length - kept.length;
    if (removed) writeContacts(kept);
    return removed;
  });
}

/** Add one contact by hand. Returns false when the address already exists —
 *  same skip rule as import, so this can never resurrect an opt-out either. */
export function addContact(input: Partial<Contact> & { email: string }): Promise<boolean> {
  const email = normalizeEmail(input.email);
  return withLock(() => {
    if (!isValidEmail(email)) return false;
    const contacts = readContacts();
    if (contacts.some((c) => c.email === email)) return false;
    contacts.push(
      upgrade({
        email,
        name: (input.name ?? "").trim(),
        company: (input.company ?? "").trim(),
        city: (input.city ?? "").trim(),
        subscribed: input.subscribed ?? true,
        addedAt: new Date().toISOString(),
        source: input.source ?? "manual",
        note: (input.note ?? "").trim(),
      }),
    );
    writeContacts(contacts);
    return true;
  });
}

/**
 * Record a permanent send rejection and take the address out of circulation.
 *
 * Without a public URL there is no bounce webhook, so Resend's synchronous
 * rejection of an invalid recipient is the only bounce signal available. Acting
 * on it is what stops the list quietly rotting and dragging the sending domain's
 * reputation down with it. Returns the contacts actually unsubscribed, so the
 * caller can log each one — consent changed without a human deciding it, and
 * that must never be silent.
 */
export function recordPermanentFailure(emails: string[]): Promise<string[]> {
  const wanted = new Set(emails.map(normalizeEmail));
  return withLock(() => {
    const contacts = readContacts();
    const unsubscribed: string[] = [];
    for (const c of contacts) {
      if (!wanted.has(c.email)) continue;
      c.failureCount += 1;
      if (c.subscribed) {
        c.subscribed = false;
        unsubscribed.push(c.email);
      }
    }
    if (wanted.size) writeContacts(contacts);
    return unsubscribed;
  });
}

/** Stamp lastSentAt after a campaign. Best-effort: never fails a send. */
export function markSent(emails: string[], at = new Date().toISOString()): Promise<number> {
  const wanted = new Set(emails.map(normalizeEmail));
  return withLock(() => {
    const contacts = readContacts();
    let changed = 0;
    for (const c of contacts) {
      if (wanted.has(c.email)) {
        c.lastSentAt = at;
        changed++;
      }
    }
    if (changed) writeContacts(contacts);
    return changed;
  });
}

// -------------------------------------------------------------- CSV parse ---

/**
 * RFC 4180 CSV reader. Shopify's customer export quotes any field containing a
 * comma (addresses and tags routinely do) and can embed newlines inside quotes,
 * so splitting on "," or on "\n" corrupts real exports — this walks the text.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, ""); // strip UTF-8 BOM (Excel adds one)
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++; // CRLF and lone CR both end the line
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Header keys compared with spaces, underscores and case removed, so
 *  "Accepts Email Marketing", "accepts_email_marketing" and "AcceptsEmailMarketing"
 *  all match — Shopify's export has used several of these spellings. */
function headerKey(h: string): string {
  return h.toLowerCase().replace(/[\s_-]+/g, "");
}

function findColumn(headers: string[], candidates: string[]): number {
  const keys = headers.map(headerKey);
  for (const cand of candidates) {
    const idx = keys.indexOf(headerKey(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

const EMAIL_COLUMNS = ["Email", "Email Address", "Customer Email", "E-post"];
const CONSENT_COLUMNS = [
  "Accepts Email Marketing",
  "Email Marketing Consent",
  "Accepts Marketing",
  "Marketing Consent",
  "Email Subscription Status",
];
const FIRST_NAME_COLUMNS = ["First Name", "Firstname", "Fornavn"];
const LAST_NAME_COLUMNS = ["Last Name", "Lastname", "Etternavn"];
const NAME_COLUMNS = ["Name", "Customer Name", "Display Name", "Navn"];
const COMPANY_COLUMNS = ["Company", "Default Address Company", "Firma"];
const CITY_COLUMNS = ["City", "Default Address City", "By", "Poststed"];

/** Values that mean "this person has NOT consented". Everything else counts as
 *  subscribed — per the agreed rule, absence of a clear "no" is a yes. */
const NEGATIVE_CONSENT = new Set([
  "no",
  "false",
  "0",
  "unsubscribed",
  "not_subscribed",
  "notsubscribed",
  "declined",
  "never",
  "pending",
  "nei",
]);

function consentToSubscribed(raw: string): boolean {
  return !NEGATIVE_CONSENT.has(raw.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

// ------------------------------------------------------------------ import --

/**
 * Import a Shopify customer CSV. New addresses are added; addresses already in
 * the list are skipped whole — their subscribe status is never overwritten.
 *
 * Consent: if the CSV carries a marketing-consent column we follow it; if there
 * is no such column, new contacts default to subscribed. Either way the result
 * says which rule applied, so it is never a silent decision.
 */
export function importCsv(text: string, source: string): Promise<ImportResult> {
  return withLock(() => {
    const rows = parseCsv(text);
    const result: ImportResult = {
      added: 0,
      skippedExisting: 0,
      flaggedInvalid: 0,
      noEmail: 0,
      consentColumn: null,
      addedUnsubscribed: 0,
      notes: [],
    };
    if (rows.length < 2) {
      result.notes.push("Fant ingen rader i filen.");
      return result;
    }

    const headers = rows[0];
    const emailIdx = findColumn(headers, EMAIL_COLUMNS);
    if (emailIdx === -1) {
      result.notes.push(
        `Fant ingen e-postkolonne. Forventet en av: ${EMAIL_COLUMNS.join(", ")}.`,
      );
      return result;
    }
    const consentIdx = findColumn(headers, CONSENT_COLUMNS);
    if (consentIdx !== -1) result.consentColumn = headers[consentIdx];

    const firstIdx = findColumn(headers, FIRST_NAME_COLUMNS);
    const lastIdx = findColumn(headers, LAST_NAME_COLUMNS);
    const nameIdx = findColumn(headers, NAME_COLUMNS);
    const companyIdx = findColumn(headers, COMPANY_COLUMNS);
    const cityIdx = findColumn(headers, CITY_COLUMNS);

    const contacts = readContacts();
    const known = new Set(contacts.map((c) => c.email));
    const now = new Date().toISOString();
    const cell = (row: string[], idx: number) => (idx === -1 ? "" : (row[idx] ?? "").trim());

    for (const row of rows.slice(1)) {
      const email = normalizeEmail(cell(row, emailIdx));
      if (!email) {
        // No address at all — there is no key to store a contact under.
        result.noEmail++;
        continue;
      }
      if (known.has(email)) {
        // The whole point: an existing contact is left exactly as it is.
        result.skippedExisting++;
        continue;
      }
      // A malformed address is ADDED and flagged rather than dropped, so a typo
      // in the source data is something the operator can see and fix. It is
      // never mailable — isMailable() excludes it regardless of the checkbox.
      const malformed = !isValidEmail(email);
      const subscribed =
        !malformed && (consentIdx === -1 ? true : consentToSubscribed(cell(row, consentIdx)));
      const name =
        [cell(row, firstIdx), cell(row, lastIdx)].filter(Boolean).join(" ").trim() ||
        cell(row, nameIdx);

      contacts.push(
        upgrade({
          email,
          name,
          company: cell(row, companyIdx),
          city: cell(row, cityIdx),
          subscribed,
          invalidEmail: malformed,
          addedAt: now,
          source,
        }),
      );
      known.add(email);
      result.added++;
      if (malformed) result.flaggedInvalid++;
      if (!subscribed) result.addedUnsubscribed++;
    }

    if (result.added) writeContacts(contacts);

    // Say out loud which consent rule was applied — this is a legal decision,
    // not a detail, so it must never be invisible to the operator.
    if (result.consentColumn) {
      result.notes.push(
        `Fant kolonnen «${result.consentColumn}» — ${result.addedUnsubscribed} av ` +
          `${result.added} nye kontakter er ikke abonnenter.`,
      );
    } else {
      result.notes.push(
        `Ingen samtykkekolonne funnet — alle ${result.added} nye er satt som abonnenter.`,
      );
    }
    if (result.skippedExisting) {
      result.notes.push(
        `${result.skippedExisting} fantes fra før og ble ikke rørt ` +
          "(av/på-status beholdt).",
      );
    }
    if (result.flaggedInvalid) {
      result.notes.push(
        `${result.flaggedInvalid} har ugyldig e-postadresse — lagt inn, men merket og ` +
          "kan ikke sendes til.",
      );
    }
    if (result.noEmail) {
      result.notes.push(`${result.noEmail} rader manglet e-post helt og kunne ikke legges inn.`);
    }
    return result;
  });
}

// ------------------------------------------------------- shopify sync ------

/** One customer as the worker's `customers` command emits it. */
export interface ShopifyCustomerRow {
  id?: string | null;
  email: string | null;
  name?: string;
  company?: string;
  city?: string;
  marketing_state?: string | null;
}

/** What the sync learned about a single row, for the event log. Every row that
 *  is not a plain add or a plain skip produces one of these, which is what makes
 *  "nothing was skipped silently" checkable rather than merely asserted. */
export interface SyncNotice {
  level: "info" | "warn";
  event: string;
  message: string;
  data: Record<string, unknown>;
}

export interface SyncOutcome extends ImportResult {
  unsubscribedByShopify: number;
  emailChanged: number;
  markedMissing: number;
  incomplete: boolean;
  notices: SyncNotice[];
}

/**
 * Sync the list from Shopify.
 *
 * Consent moves in ONE direction only — toward "do not mail":
 *
 *   - new address            -> added, subscribed iff Shopify says SUBSCRIBED
 *   - known, Shopify says no -> unsubscribed here too (tightening is always safe)
 *   - known, Shopify says yes -> left exactly as it is
 *
 * That last rule is the important one. A plain "make local match Shopify" sync
 * would re-subscribe anyone who opted out by replying to a campaign, because
 * that opt-out lives here and never reached Shopify (we only hold read_customers).
 * Consent may therefore only ever be tightened automatically; loosening it stays
 * a deliberate act by the operator, via the checkbox.
 */
export function syncFromShopify(
  rows: ShopifyCustomerRow[],
  source: string,
  opts: { complete: boolean } = { complete: false },
): Promise<SyncOutcome> {
  return withLock(() => {
    const result: SyncOutcome = {
      added: 0,
      skippedExisting: 0,
      flaggedInvalid: 0,
      // Counted per row below, so `added + skippedExisting + noEmail` reconciles
      // exactly against what Shopify returned.
      noEmail: 0,
      consentColumn: "Shopify marketing consent",
      addedUnsubscribed: 0,
      unsubscribedByShopify: 0,
      emailChanged: 0,
      markedMissing: 0,
      incomplete: !opts.complete,
      notes: [],
      notices: [],
    };

    const contacts = readContacts();
    const byEmail = new Map(contacts.map((c) => [c.email, c]));
    const byShopifyId = new Map(
      contacts.filter((c) => c.shopifyId).map((c) => [c.shopifyId as string, c]),
    );
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const row of rows) {
      const email = normalizeEmail(row.email ?? "");
      if (!email) {
        result.noEmail++;
        result.notices.push({
          level: "warn",
          event: "sync.noEmail",
          message: `Kunde uten e-postadresse i Shopify: ${row.name || row.id || "ukjent"}`,
          data: { shopifyId: row.id ?? null, name: row.name ?? null },
        });
        continue;
      }

      const consented = row.marketing_state === "SUBSCRIBED";
      const malformed = !isValidEmail(email);

      // Match on the Shopify id FIRST. Keying on email alone means a customer
      // who changes their address in Shopify silently becomes two contacts here,
      // the old one lingering and guaranteed to bounce.
      const byId = row.id ? byShopifyId.get(row.id) : undefined;
      const existing = byId ?? byEmail.get(email);

      if (existing) {
        seen.add(existing.email);
        result.skippedExisting++;

        if (existing.email !== email) {
          result.notices.push({
            level: "info",
            event: "sync.emailChanged",
            message: `Adresse endret i Shopify: ${existing.email} → ${email}`,
            data: { from: existing.email, to: email, shopifyId: row.id ?? null },
          });
          byEmail.delete(existing.email);
          existing.email = email;
          existing.invalidEmail = malformed;
          byEmail.set(email, existing);
          seen.add(email);
          result.emailChanged++;
        }

        if (row.id && !existing.shopifyId) existing.shopifyId = row.id; // backfill
        existing.lastSeenInShopifyAt = now;
        if (existing.missingInShopify) existing.missingInShopify = false; // it's back

        // Tighten only — never flip an unsubscribed contact back on.
        if (!consented && existing.subscribed) {
          existing.subscribed = false;
          result.unsubscribedByShopify++;
        }
        continue;
      }

      const contact = upgrade({
        email,
        shopifyId: row.id ?? null,
        name: (row.name ?? "").trim(),
        company: (row.company ?? "").trim(),
        city: (row.city ?? "").trim(),
        // A malformed address can never be mailable, whatever Shopify says.
        subscribed: consented && !malformed,
        invalidEmail: malformed,
        lastSeenInShopifyAt: now,
        addedAt: now,
        source,
      });
      contacts.push(contact);
      byEmail.set(email, contact);
      if (contact.shopifyId) byShopifyId.set(contact.shopifyId, contact);
      seen.add(email);
      result.added++;
      if (malformed) {
        result.flaggedInvalid++;
        result.notices.push({
          level: "warn",
          event: "sync.invalidEmail",
          message: `Ugyldig e-postadresse lagt inn og merket: ${email}`,
          data: { email, shopifyId: row.id ?? null },
        });
      }
      if (!contact.subscribed) result.addedUnsubscribed++;
    }

    // ---- customers that vanished from Shopify ----
    //
    // Only ever acted on after a sync we KNOW was complete. A throttled or
    // half-failed fetch makes customers look deleted, and unsubscribing hundreds
    // of people on that evidence is not recoverable without manual work.
    if (opts.complete) {
      for (const c of contacts) {
        // Never touch rows that never came from Shopify (manual, CSV).
        if (!c.lastSeenInShopifyAt && !c.shopifyId) continue;
        if (seen.has(c.email)) continue;
        if (c.missingInShopify) continue; // already handled on an earlier run
        c.missingInShopify = true;
        c.subscribed = false;
        result.markedMissing++;
        result.notices.push({
          level: "warn",
          event: "contact.missingInShopify",
          message: `Ikke lenger i Shopify — meldt av: ${c.email}`,
          data: { email: c.email, shopifyId: c.shopifyId },
        });
      }
    }

    writeContacts(contacts);

    result.notes.push(
      `${result.added} nye kontakter lagt til ` +
        `(${result.addedUnsubscribed} av dem uten samtykke i Shopify).`,
    );
    if (result.skippedExisting) {
      result.notes.push(`${result.skippedExisting} fantes fra før — av/på-status beholdt.`);
    }
    if (result.emailChanged) {
      result.notes.push(`${result.emailChanged} fikk oppdatert e-postadresse fra Shopify.`);
    }
    if (result.unsubscribedByShopify) {
      result.notes.push(
        `${result.unsubscribedByShopify} ble meldt av fordi samtykket er trukket i Shopify.`,
      );
    }
    if (result.flaggedInvalid) {
      result.notes.push(
        `${result.flaggedInvalid} har ugyldig adresse — lagt inn, men merket og kan ikke sendes til.`,
      );
    }
    if (result.noEmail) {
      result.notes.push(
        `${result.noEmail} kunder i Shopify har ingen e-postadresse — se loggen for hvem.`,
      );
    }
    if (result.markedMissing) {
      result.notes.push(
        `${result.markedMissing} finnes ikke lenger i Shopify og ble meldt av.`,
      );
    }
    if (result.incomplete) {
      result.notes.push(
        "Synken var ufullstendig, så ingen ble merket som borte fra Shopify.",
      );
    }
    return result;
  });
}

// ------------------------------------------------------------------ export --

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The backup. This list is the only record of who has opted out, and it lives
 *  on one machine — exporting it regularly is a real requirement, not a nicety. */
export function contactsCsv(contacts: Contact[] = readContacts()): string {
  const header = [
    "Email",
    "Name",
    "Company",
    "City",
    "Subscribed",
    "Added At",
    "Source",
    "Last Sent At",
    "Note",
  ];
  const lines = [header.join(",")];
  for (const c of contacts) {
    lines.push(
      [
        c.email,
        c.name,
        c.company,
        c.city,
        c.subscribed ? "yes" : "no",
        c.addedAt,
        c.source,
        c.lastSentAt ?? "",
        c.note,
      ]
        .map((v) => csvCell(String(v ?? "")))
        .join(","),
    );
  }
  return lines.join("\r\n");
}
