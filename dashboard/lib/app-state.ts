/**
 * Small singleton values that don't deserve a table of their own — when the
 * Logg tab was last opened, when the last sync ran, and so on.
 *
 * These used to be one-line JSON files next to the state folder. They are here
 * because a hosted app has no writable disk, and because two instances reading
 * different copies of "when did this last happen" causes work to be repeated.
 *
 * Server-only.
 */
import { eq, sbDelete, sbInsert, sbSelectOne } from "./supabase";

interface StateRow<T> {
  key: string;
  value: T;
}

export async function getAppState<T>(key: string): Promise<T | null> {
  const row = await sbSelectOne<StateRow<T>>("app_state", { key: eq(key), select: "key,value" });
  return row?.value ?? null;
}

export async function setAppState<T>(key: string, value: T): Promise<void> {
  await sbInsert(
    "app_state",
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key", merge: true },
  );
}

/** Remove a key entirely. Distinct from storing null, which the column forbids
 *  — and "no row" is the honest way to say a flag is not set. */
export async function clearAppState(key: string): Promise<void> {
  await sbDelete("app_state", { key: eq(key) });
}
