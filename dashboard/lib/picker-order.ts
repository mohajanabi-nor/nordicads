/**
 * Ordering for the picker's "what just arrived" grid.
 *
 * Lives here rather than in the route because a Next.js route file may export
 * nothing but handlers, and this is the part most worth testing: it decides
 * what the operator sees first on a screen whose entire purpose is to answer
 * "what came in".
 */

/** The fields the ordering reads. Anything with these can be ranked. */
export interface Arrival {
  id: string;
  title: string;
  vendor: string;
  created_at: string | null;
  inventory_updated_at: string | null;
  restock_increase: number | null;
}

export function ms(t: string | null): number {
  return t ? new Date(t).getTime() : 0;
}

/**
 * When this product actually landed — the moment the operator is scanning for.
 *
 * A new arrival's moment is when it was created; a restock's is when the stock
 * moved. A product can be both, and then the later one wins. Anything that
 * merely SOLD contributes nothing: its inventory_updated_at is recent, but no
 * goods arrived, and ranking on it would float sold items to the top of a
 * screen whose whole purpose is "what came in".
 */
function eventTime(p: Arrival, cutoff: number, minRestock: number): number {
  const asNew = ms(p.created_at) >= cutoff ? ms(p.created_at) : 0;
  const asRestock =
    p.restock_increase != null &&
    p.restock_increase >= minRestock &&
    ms(p.inventory_updated_at) >= cutoff
      ? ms(p.inventory_updated_at)
      : 0;
  return Math.max(asNew, asRestock);
}

/** Local midnight for a moment — the day a delivery is filed under. */
function dayBucket(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Newest delivery day first, like-with-like inside it.
 *
 * `categoryOf` is injected because clustering depends on how common a
 * collection is across the whole catalogue, which only the caller knows.
 */
export function orderByArrival<T extends Arrival>(
  items: T[],
  cutoff: number,
  minRestock: number,
  categoryOf: (p: T) => string,
): T[] {
  const cat = new Map<string, string>(); // product id -> cluster category
  const day = new Map<string, number>(); // product id -> delivery day
  const when = new Map<string, number>(); // product id -> exact moment
  // day -> category -> freshest moment in it. Nested rather than a joined
  // string key, because a category name is store data and could contain
  // whatever separator we picked.
  const catFresh = new Map<number, Map<string, number>>();

  for (const p of items) {
    const c = categoryOf(p);
    const t = eventTime(p, cutoff, minRestock);
    const d = dayBucket(t);
    cat.set(p.id, c);
    when.set(p.id, t);
    day.set(p.id, d);
    let perDay = catFresh.get(d);
    if (!perDay) catFresh.set(d, (perDay = new Map()));
    perDay.set(c, Math.max(perDay.get(c) ?? 0, t));
  }

  return [...items].sort((a, b) => {
    const da = day.get(a.id)!, db = day.get(b.id)!;
    if (da !== db) return db - da; // newest delivery day on top
    const ca = cat.get(a.id)!, cb = cat.get(b.id)!;
    if (ca !== cb) {
      // Within the day, the category holding that day's freshest item leads.
      return (
        (catFresh.get(db)!.get(cb)! - catFresh.get(da)!.get(ca)!) ||
        ca.localeCompare(cb)
      );
    }
    return (
      (when.get(b.id)! - when.get(a.id)!) ||
      (a.vendor || "").localeCompare(b.vendor || "") ||
      a.title.localeCompare(b.title)
    );
  });
}

/**
 * The start of a window, as both sides compute it.
 *
 * Calendar-aligned rather than a rolling 24h: "I dag" means since local
 * midnight. The server filters on this and the card badges are drawn from it,
 * so they have to be the same arithmetic — a card reading NYHET in a window the
 * server did not consider it new is the kind of disagreement nobody reports as
 * a bug, they just stop trusting the badges.
 */
export function windowStart(days: number, now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
}

export function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  // Calendar-aligned, matching the server: snap to start of the local day and
  // count whole days back, so the card badges agree with what the window filter
  // actually included ("I dag" = since local midnight, not a rolling 24h).
  return Number.isFinite(t) && t >= windowStart(days);
}

/** Why is this product in the window? new arrival, or restocked +N. Mirrors the
 *  server's isFresh(): NEW wins, else a confirmed restock. */
export function freshSignal(
  p: Arrival,
  days: number,
  minRestock: number,
): { kind: "nyhet" | "restock"; text: string } | null {
  if (withinDays(p.created_at, days)) return { kind: "nyhet", text: "NYHET" };
  if (
    p.restock_increase != null &&
    p.restock_increase >= minRestock &&
    withinDays(p.inventory_updated_at, days)
  ) {
    return { kind: "restock", text: `+${p.restock_increase} inn` };
  }
  return null;
}

