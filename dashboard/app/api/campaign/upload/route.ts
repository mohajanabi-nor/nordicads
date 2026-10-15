/**
 * Hand the browser a place to put a PDF it wants to attach.
 *
 * The file itself never goes through this route: a serverless request body is
 * capped far below a catalogue-sized PDF, so we only validate the claim and
 * return a signed storage URL for the browser to PUT to.
 */
import { MAX_UPLOAD_BYTES, newUploadId, signUpload, uploadFilename } from "@/lib/campaign-upload";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { filename?: string; size?: number };
    const filename = (body.filename ?? "").trim();
    if (!/\.pdf$/i.test(filename)) {
      return Response.json({ error: "bare PDF-filer kan legges ved" }, { status: 400 });
    }
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      return Response.json({ error: "tom fil" }, { status: 400 });
    }
    if (size > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "filen er for stor (maks 25 MB)" }, { status: 413 });
    }

    const uploadId = newUploadId();
    const url = await signUpload(uploadId);
    return Response.json({ uploadId, url, filename: uploadFilename(filename) });
  } catch (err) {
    return Response.json({ error: String((err as Error).message) }, { status: 500 });
  }
}
