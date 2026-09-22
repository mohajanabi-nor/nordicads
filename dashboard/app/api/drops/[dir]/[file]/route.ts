/**
 * Serve a single asset (PDF / mp4) out of a drop.
 *
 * Two cases, because a drop can live in two places:
 *
 *   remote — the file is in Supabase Storage. We mint a short-lived signed URL
 *            and redirect. Storage honours Range on those URLs, so <video> can
 *            still seek, and a 40 MB reel never travels through this function.
 *   local  — the file is on disk outside Next's public dir, so it is streamed
 *            here with Range handled manually. Path traversal is blocked before
 *            we get this far.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { resolveDropTarget } from "@/lib/drops";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

export async function GET(
  req: Request,
  { params }: { params: { dir: string; file: string } },
) {
  let target;
  try {
    target = await resolveDropTarget(
      decodeURIComponent(params.dir),
      decodeURIComponent(params.file),
    );
  } catch (err) {
    return new Response(String(err instanceof Error ? err.message : err), { status: 502 });
  }

  if (!target) return new Response("Not found", { status: 404 });

  if (target.kind === "redirect") {
    // 302 rather than 307: the signed URL is a different resource each time, and
    // must not be cached as if it were this one.
    return Response.redirect(target.url, 302);
  }

  const stat = fs.statSync(target.path);
  const total = stat.size;
  const type = contentType(target.path);
  const range = req.headers.get("range");

  // Range request → 206 partial (video scrubbing).
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${total}` },
        });
      }
      const stream = fs.createReadStream(target.path, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const stream = fs.createReadStream(target.path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
