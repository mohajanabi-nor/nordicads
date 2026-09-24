/**
 * Where a render got to, by job id.
 *
 * The stream is the normal way to watch a render, but a connection that lasts
 * two minutes is not something to depend on — a sleeping laptop or a proxy can
 * end it while the job carries on perfectly well on the runner. Without a way
 * to ask afterwards, the browser is left showing a spinner for work that
 * finished, which is indistinguishable from a hang.
 *
 * It answers with the checklist as well as the log, because those are the two
 * things the stream was providing. Logs alone leave the browser scrolling
 * through the reels while the checklist above still reads "Henter produkter" —
 * which looks far more like a stuck job than a lost connection does.
 */
import { getJob, isTerminal, readLogs } from "@/lib/worker-jobs";
import { GENERATE_STEPS, stepsFromLines } from "@/lib/pipeline-steps";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  if (!jobId) return Response.json({ error: "jobId mangler" }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return Response.json({ error: "ukjent jobb" }, { status: 404 });

  const since = Number.parseInt(new URL(req.url).searchParams.get("since") ?? "-1", 10);

  // The whole log, every time: a step is decided by a line that may have been
  // read long before this poller attached, so `since` can only narrow what is
  // SENT back, never what the checklist is worked out from.
  const all = await readLogs(jobId, -1);
  const cutoff = Number.isFinite(since) ? since : -1;

  return Response.json({
    jobId,
    status: job.status,
    finished: isTerminal(job.status),
    exitCode: job.exit_code,
    drop: job.drop_dir,
    error: job.error_message,
    logs: all.filter((entry) => entry.seq > cutoff),
    steps: stepsFromLines(GENERATE_STEPS, all.map((entry) => entry.line)),
  });
}
