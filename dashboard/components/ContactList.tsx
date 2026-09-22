"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Contact,
  ContactFilter,
  ContactsResponse,
  ImportResult,
  SyncStatus,
} from "@/lib/types";

const PAGE_SIZE = 50;

const FILTERS: { key: ContactFilter; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "abonnerer", label: "Abonnerer" },
  { key: "avmeldt", label: "Avmeldt" },
  { key: "ugyldig", label: "Ugyldig adresse" },
  { key: "borte", label: "Borte fra Shopify" },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("no-NO", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "aldri";
  try {
    return new Date(iso).toLocaleString("no-NO", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** "om 21 t" / "nå" — enough for the operator to know the sync is alive. */
function fmtIn(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "nå";
  const hours = Math.round(ms / 3_600_000);
  return hours >= 1 ? `om ${hours} t` : `om ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Why a contact cannot be mailed, or null when it can. */
function blockedReason(c: Contact): string | null {
  if (c.invalidEmail) return "Ugyldig e-postadresse";
  if (c.missingInShopify) return "Finnes ikke lenger i Shopify";
  if (!c.subscribed) return "Avmeldt";
  return null;
}

export default function ContactList({
  onSelectionChange,
}: {
  /** The picked recipients, already narrowed to those who actually get mail. */
  onSelectionChange?: (mailableEmails: string[]) => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [stats, setStats] = useState({
    count: 0,
    subscribed: 0,
    unsubscribed: 0,
    invalid: 0,
    missing: 0,
    mailable: 0,
  });
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ContactFilter>("alle");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Which selected addresses may actually be mailed. Held separately because
   *  with server-side paging the browser no longer has every contact to ask. */
  const mailableRef = useRef<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Debounce typing so a search doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        q: search,
        filter,
      });
      const res = await fetch(`/api/contacts?${qs}`);
      const data: ContactsResponse & { error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setContacts(data.contacts ?? []);
      setStats({
        count: data.count,
        subscribed: data.subscribed,
        unsubscribed: data.unsubscribed,
        invalid: data.invalid,
        missing: data.missing,
        mailable: data.mailable,
      });
      setSync(data.sync ?? null);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      // Remember mailability for everything seen, so a selection made on page 1
      // is still understood after paging away.
      for (const c of data.contacts ?? []) {
        if (blockedReason(c) === null) mailableRef.current.add(c.email);
        else mailableRef.current.delete(c.email);
      }
    } catch (err) {
      setError(String((err as Error).message));
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [page, search, filter]);

  useEffect(() => {
    load();
  }, [load]);

  const notify = useCallback(
    (next: Set<string>) => {
      const mailable = Array.from(next).filter((e) => mailableRef.current.has(e));
      onSelectionChange?.(mailable);
    },
    [onSelectionChange],
  );

  const updateSelection = (fn: (prev: Set<string>) => Set<string>) =>
    setSelected((prev) => {
      const next = fn(prev);
      notify(next);
      return next;
    });

  const toggleSelected = (email: string) =>
    updateSelection((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  const pageSelectable = contacts.map((c) => c.email);
  const allPageSelected =
    pageSelectable.length > 0 && pageSelectable.every((e) => selected.has(e));

  const togglePage = () =>
    updateSelection((prev) => {
      const next = new Set(prev);
      if (allPageSelected) for (const e of pageSelectable) next.delete(e);
      else for (const e of pageSelectable) next.add(e);
      return next;
    });

  /** Select everything matching the current search/filter — across all pages.
   *  Without this, choosing the whole subscriber list would mean paging through
   *  sixteen pages by hand, and sending to everyone is the main use case. */
  async function selectAllMatching() {
    setBusy(true);
    try {
      const qs = new URLSearchParams({ q: search, filter, mailableOnly: "1" });
      const res = await fetch(`/api/contacts/ids?${qs}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const emails: string[] = data.emails ?? [];
      for (const e of emails) mailableRef.current.add(e);
      updateSelection(() => new Set(emails));
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const clearSelection = () => updateSelection(() => new Set());

  async function setSubscribed(emails: string[], subscribed: boolean) {
    try {
      const res = await fetch("/api/contacts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, subscribed }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function removeSelected() {
    const emails = Array.from(selected);
    if (emails.length === 0) return;
    if (
      !confirm(
        `Slette ${emails.length} kontakter permanent?\n\n` +
          "Avmeldte bør beholdes, ikke slettes — sletting fjerner beviset på at de har reservert seg.",
      )
    )
      return;
    try {
      const res = await fetch("/api/contacts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      clearSelection();
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function runSync() {
    setBusy(true);
    setImportResult(null);
    setError(null);
    try {
      const res = await fetch("/api/contacts/sync", { method: "POST" });
      const data: ImportResult & { error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setImportResult(data);
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function runImport(file: File) {
    setBusy(true);
    setImportResult(null);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/contacts/import", { method: "POST", body: form });
      const data: ImportResult & { error?: string } = await res.json();
      if (data.error) throw new Error(data.error);
      setImportResult(data);
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function addOne() {
    setAddError(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, name: newName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setAddError(data.reason ?? data.error ?? "kunne ikke legge til");
        return;
      }
      setNewEmail("");
      setNewName("");
      await load();
    } catch (err) {
      setAddError(String((err as Error).message));
    }
  }

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      {/* ---- header: stats, sync, import ---- */}
      <section className="rounded-2xl border border-line bg-cream-2 p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold text-ink">Kontakter</h2>
            <p className="mt-1 text-sm text-mute">
              {loading && contacts.length === 0 ? (
                "Laster…"
              ) : (
                <>
                  {stats.count.toLocaleString("no-NO")} kontakter ·{" "}
                  <span className="font-semibold text-ink">
                    {stats.mailable.toLocaleString("no-NO")} kan sendes til
                  </span>{" "}
                  · {stats.unsubscribed.toLocaleString("no-NO")} avmeldt
                  {stats.invalid > 0 && ` · ${stats.invalid} ugyldig`}
                  {stats.missing > 0 && ` · ${stats.missing} borte fra Shopify`}
                </>
              )}
            </p>
            {sync && (
              <p className="mt-1 text-[11px] text-mute">
                {sync.running
                  ? "Synkroniserer nå…"
                  : `Sist synkronisert: ${fmtWhen(sync.lastSyncAt)}`}
                {sync.enabled && !sync.running && sync.nextDueAt
                  ? ` · neste ${fmtIn(sync.nextDueAt)}`
                  : sync.enabled
                    ? ""
                    : " · automatisk synk er av"}
                {sync.lastResult && ` · ${sync.lastResult}`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) runImport(f);
              }}
            />
            <button
              onClick={runSync}
              disabled={busy}
              title="Henter kundene direkte fra Shopify. Nye legges til; kjente røres ikke — bortsett fra at samtykke som er trukket i Shopify også slår av her."
              className="rounded-xl bg-orange px-5 py-2.5 text-sm font-bold text-cream shadow-sm transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Jobber…" : "Hent fra Shopify"}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Alternativ til Shopify-synk: last opp en CSV-eksport."
              className="rounded-xl border border-orange bg-cream-2 px-4 py-2.5 text-sm font-bold text-orange shadow-sm transition hover:bg-orange hover:text-cream disabled:opacity-40"
            >
              Importer CSV
            </button>
            <a
              href="/api/contacts/export"
              download
              title="Last ned hele listen. Dette er sikkerhetskopien — den ligger bare på denne maskinen."
              className="rounded-lg bg-cream px-3 py-2.5 text-sm font-semibold text-ink/80 hover:bg-line/40"
            >
              Last ned CSV
            </a>
          </div>
        </div>

        {importResult && (
          <div className="mt-4 rounded-xl border border-orange/30 bg-orange/10 p-4 text-sm">
            <p className="font-bold text-ink">Ferdig — {importResult.added} nye lagt til</p>
            <ul className="mt-1 space-y-0.5 text-ink/80">
              {importResult.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <a href="/logg" className="mt-2 inline-block font-semibold text-orange underline">
              Se detaljer i loggen →
            </a>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">
            Feil: {error}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="ny@kunde.no"
            className="w-56 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Navn (valgfritt)"
            className="w-48 rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
          />
          <button
            onClick={addOne}
            disabled={!newEmail.trim()}
            className="rounded-lg bg-cream px-3 py-2 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
          >
            Legg til
          </button>
          {addError && <span className="text-sm text-red-700">{addError}</span>}
        </div>
      </section>

      {/* ---- search + filters ---- */}
      {/* Search left, filters and the hit count right. justify-between rather
          than a fixed width, so the two groups stack cleanly on a narrow window
          instead of the filters being pushed off the edge. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-cream-2 p-4">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Søk i hele listen — e-post, navn, firma…"
          className="w-72 max-w-full rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none focus:border-orange"
        />
        <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key);
                setPage(1);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                filter === f.key ? "bg-orange text-cream" : "bg-cream text-ink/70 hover:bg-line/40"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
          <span className="shrink-0 text-sm text-mute">
            {total.toLocaleString("no-NO")} treff
            {search && " for søket"}
          </span>
        </div>
      </div>

      {/* ---- selection bar ---- */}
      {(selected.size > 0 || total > 0) && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-orange/30 bg-orange/10 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                checked={allPageSelected}
                onChange={togglePage}
                disabled={contacts.length === 0}
                className="h-4 w-4 accent-orange"
              />
              Velg siden ({contacts.length})
            </label>
            <button
              onClick={selectAllMatching}
              disabled={busy || total === 0}
              className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
              title="Velger alle som kan sendes til i hele det filtrerte utvalget, ikke bare denne siden."
            >
              Velg alle som kan sendes til
            </button>
            <span className="text-sm font-semibold text-ink">{selected.size} valgt</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSubscribed(Array.from(selected), true)}
              disabled={selected.size === 0}
              className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
            >
              Sett som abonnent
            </button>
            <button
              onClick={() => setSubscribed(Array.from(selected), false)}
              disabled={selected.size === 0}
              className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
            >
              Meld av
            </button>
            <button
              onClick={clearSelection}
              disabled={selected.size === 0}
              className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
            >
              Nullstill
            </button>
            <button
              onClick={removeSelected}
              disabled={selected.size === 0}
              className="rounded-lg border border-red-600 bg-red-50 px-3 py-1.5 text-sm font-bold text-red-700 transition hover:bg-red-600 hover:text-white disabled:opacity-40"
            >
              Slett
            </button>
          </div>
        </div>
      )}

      {/* ---- table ---- */}
      {loading && contacts.length === 0 ? (
        <p key="loading" className="text-sm text-mute">
          Laster…
        </p>
      ) : contacts.length === 0 ? (
        <p
          key="empty"
          className="rounded-2xl border border-dashed border-line bg-cream-2 p-8 text-center text-sm text-mute"
        >
          {stats.count === 0
            ? "Ingen kontakter ennå. Trykk «Hent fra Shopify»."
            : "Ingen treff."}
        </p>
      ) : (
        <div key="table" className="overflow-hidden rounded-2xl border border-line bg-cream-2">
          {/* Paging sits at the TOP of the table: with 50 rows a page, having to
              scroll past the whole list to reach "Neste" made moving through 16
              pages needlessly tedious. */}
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-cream/60 px-4 py-2.5 text-sm">
              <span className="text-mute">
                Viser {from}–{to} av {total.toLocaleString("no-NO")}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(1)}
                  disabled={page <= 1 || loading}
                  className="rounded-lg bg-cream-2 px-2.5 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
                  title="Første side"
                >
                  «
                </button>
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || loading}
                  className="rounded-lg bg-cream-2 px-3 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
                >
                  ← Forrige
                </button>
                <span className="font-semibold text-ink">
                  Side {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || loading}
                  className="rounded-lg bg-cream-2 px-3 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
                >
                  Neste →
                </button>
                <button
                  onClick={() => setPage(totalPages)}
                  disabled={page >= totalPages || loading}
                  className="rounded-lg bg-cream-2 px-2.5 py-1.5 font-semibold text-ink/80 hover:bg-line/40 disabled:opacity-40"
                  title="Siste side"
                >
                  »
                </button>
              </div>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs font-bold uppercase tracking-wide text-mute">
              <tr>
                <th className="w-10 px-4 py-3"></th>
                <th className="w-24 px-2 py-3">Abonnerer</th>
                <th className="px-2 py-3">E-post</th>
                <th className="px-2 py-3">Navn</th>
                <th className="px-2 py-3">Firma</th>
                <th className="px-2 py-3">Sist sendt</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const blocked = blockedReason(c);
                return (
                  <tr
                    key={c.email}
                    className={`border-b border-line/60 last:border-0 ${
                      blocked ? "bg-cream/40 text-mute" : ""
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(c.email)}
                        onChange={() => toggleSelected(c.email)}
                        className="h-4 w-4 accent-orange"
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={c.subscribed}
                          disabled={c.invalidEmail}
                          onChange={(e) => setSubscribed([c.email], e.target.checked)}
                          className="h-4 w-4 accent-orange disabled:opacity-40"
                          title={
                            c.invalidEmail
                              ? "Adressen er ugyldig og kan aldri sendes til."
                              : c.subscribed
                                ? "Får e-post. Fjern haken for å melde av."
                                : "Får ikke e-post."
                          }
                        />
                        <span className="text-[11px] font-semibold">
                          {c.subscribed ? "Ja" : "Nei"}
                        </span>
                      </label>
                    </td>
                    <td className="px-2 py-2.5">
                      <span className={blocked ? "line-through" : "font-semibold text-ink"}>
                        {c.email}
                      </span>
                      {c.invalidEmail && (
                        <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                          UGYLDIG
                        </span>
                      )}
                      {c.missingInShopify && (
                        <span className="ml-2 rounded-full bg-ink/60 px-2 py-0.5 text-[10px] font-bold text-cream">
                          BORTE
                        </span>
                      )}
                      {c.failureCount > 0 && (
                        <span
                          className="ml-2 text-[10px] text-red-700"
                          title="Permanent avvist av Resend"
                        >
                          {c.failureCount} avvist
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">{c.name || "—"}</td>
                    <td className="px-2 py-2.5">{c.company || "—"}</td>
                    <td className="px-2 py-2.5 text-xs">{fmtDate(c.lastSentAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
