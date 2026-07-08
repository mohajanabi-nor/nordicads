/**
 * Serve a single asset (PDF / mp4) out of a drop folder.
 *
 * Files live OUTSIDE Next's public dir, so we stream them here with the right
 * content-type and HTTP Range support — Range is what lets the <video> element
 * seek/scrub instead of downloading the whole reel first. Path-traversal is
 * blocked by resolveDropFile (must stay inside output/).
 */
import fs from "node:fs";
import { resolveDropFile } from "@/lib/worker";
import { Readable } from "node:stream";

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
  const target = resolveDropFile(
    decodeURIComponent(params.dir),
    decodeURIComponent(params.file),
  );
  if (!target) {
    return new Response("Not found", { status: 404 });
  }

  const stat = fs.statSync(target);
  const total = stat.size;
  const type = contentType(target);
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
      const stream = fs.createReadStream(target, { start, end });
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

  const stream = fs.createReadStream(target);
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
