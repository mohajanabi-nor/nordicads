/**
 * Download the contact list as CSV.
 *
 * This is the backup. The list lives in one gitignored folder on one machine and
 * is the only record of who has opted out — losing it means re-mailing people who
 * asked not to be mailed. Exporting regularly is a requirement, not a convenience.
 */
import { contactsCsv } from "@/lib/contacts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Lead with a UTF-8 BOM: without it Excel reads the file as the system
    // codepage and mangles æ/ø/å in company names on a double-click.
    const csv = "﻿" + contactsCsv();
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="kontakter-${day}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
