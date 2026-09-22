/**
 * Where a render got to, by job id.
 *
 * The stream is the normal way to watch a render, but a connection that lasts
 * two minutes is not something to depend on — a sleeping laptop or a proxy can
 * end it while the job carries on perfectly well on the runner. Without a way
 * to ask afterwards, the browser is left showing a spinner for work that
 * finished, which is indistinguishable from a hang.
 */
import { getJob, isTerminal, readLogs } from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  if (!jobId) return Response.json({ error: "jobId mangler" }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "ukjent jobb" }, { status: 404 });

  const since = Number.parseInt(new URL(req.url).searchParams.get("since") ?? "-1", 10);
  const logs = await readLogs(jobId, Number.isFinite(since) ? since : -1);

  return Response.json({
    jobId,
    status: job.status,
    finished: isTerminal(job.status),
    exitCode: job.exit_code,
    drop: job.drop_dir,
    error: job.error_message,
    logs,
  });
}
