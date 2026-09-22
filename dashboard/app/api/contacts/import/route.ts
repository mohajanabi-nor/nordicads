/**
 * Import a Shopify customer CSV into the local contact list.
 *
 * Accepts either a multipart upload (field "file") or a raw text/csv body, so
 * the UI can post a picked file and a human can curl one in.
 *
 * The import is upsert-with-skip: known addresses are left completely alone.
 * See lib/contacts.ts for why that rule is the one that matters.
 */
import { importCsv } from "@/lib/contacts";

export const dynamic = "force-dynamic";
// A large export takes a moment to parse; well under the default but explicit.
export const maxDuration = 120;

/** Shopify exports of a few thousand customers are ~1-2 MB; 20 leaves room. */
const MAX_BYTES = 20 * 1024 * 1024;

function sourceLabel(filename: string | null): string {
  const day = new Date().toISOString().slice(0, 10);
  const base = (filename ?? "").trim().replace(/\.csv$/i, "").slice(0, 40);
  return base ? `csv:${base}:${day}` : `shopify-csv-${day}`;
}

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let text: string;
    let filename: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "ingen fil i opplastingen" }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        return Response.json(
          { error: `filen er for stor (${Math.round(file.size / 1024 / 1024)} MB, maks 20 MB)` },
          { status: 413 },
        );
      }
      filename = file.name;
      text = await file.text();
    } else {
      text = await req.text();
      if (text.length > MAX_BYTES) {
        return Response.json({ error: "filen er for stor (maks 20 MB)" }, { status: 413 });
      }
    }

    if (!text.trim()) {
      return Response.json({ error: "filen er tom" }, { status: 400 });
    }

    const result = await importCsv(text, sourceLabel(filename));
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
