/**
 * Render jobs: the record of a run and the pipe its output comes back through.
 *
 * A render used to be a child process the dashboard could tail directly. Now it
 * happens on a GitHub Actions runner, and Actions only publishes logs once a run
 * has finished — useless for a progress bar. So the runner streams its stdout
 * into `worker_job_logs` as it goes (see worker/ci_run.py), and this module
 * reads it back out.
 *
 * Log lines are addressed by sequence number rather than by time, which is what
 * lets a browser that lost its connection resume from exactly where it stopped
 * instead of replaying a whole render or skipping its middle.
 *
 * Server-only.
 */
import { eq, gt, sbInsert, sbSelect, sbSelectOne, sbUpdate } from "./supabase";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface WorkerJob {
  id: string;
  command: string;
  inputs: Record<string, unknown>;
  status: JobStatus;
  github_run_id: number | null;
  exit_code: number | null;
  drop_dir: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface JobLogLine {
  seq: number;
  line: string;
}

/** Sortable and unique, and inside the `^[a-z0-9-]{8,64}$` the table enforces. */
export function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `w${stamp}-${rand}`;
}

export async function createJob(
  id: string,
  command: string,
  inputs: Record<string, unknown>,
): Promise<void> {
  await sbInsert("worker_jobs", { id, command, inputs, status: "queued" });
}

export async function getJob(id: string): Promise<WorkerJob | null> {
  return sbSelectOne<WorkerJob>("worker_jobs", { id: eq(id) });
}

export async function listJobs(limit = 20): Promise<WorkerJob[]> {
  return sbSelect<WorkerJob>("worker_jobs", { order: "created_at.desc", limit });
}

export async function attachRun(id: string, runId: number): Promise<void> {
  await sbUpdate("worker_jobs", { id: eq(id) }, { github_run_id: runId }, { returning: false });
}

/**
 * Mark a job finished from the dashboard's side.
 *
 * Normally the runner reports its own outcome. This exists for the cases it
 * cannot: a run that GitHub cancelled, or one that never started because the
 * dispatch itself failed — otherwise the job would sit at "queued" forever and
 * be indistinguishable from a slow one.
 */
export async function failJob(id: string, message: string, status: JobStatus = "failed"): Promise<void> {
  await sbUpdate(
    "worker_jobs",
    { id: eq(id), status: `in.(queued,running)` },
    { status, error_message: message, ended_at: new Date().toISOString() },
    { returning: false },
  );
}

/** Log lines after `sinceSeq`, oldest first. */
export async function readLogs(id: string, sinceSeq = -1, limit = 500): Promise<JobLogLine[]> {
  return sbSelect<JobLogLine>("worker_job_logs", {
    select: "seq,line",
    job_id: eq(id),
    seq: gt(sinceSeq),
    order: "seq.asc",
    limit,
  });
}

export function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
