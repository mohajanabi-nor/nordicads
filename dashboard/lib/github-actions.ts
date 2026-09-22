/**
 * Dispatching renders to GitHub Actions.
 *
 * The worker used to be a child process. Hosted, it is a workflow run: Vercel
 * cannot spawn Python, and a render needs more memory than any free always-on
 * host provides. See .github/workflows/generate.yml for the other half.
 *
 * The awkward part of the Actions API is that dispatching a workflow returns
 * 204 with no body — you get no run id for the thing you just started. The
 * workflow therefore sets its `run-name` from the job id we pass in, and we find
 * the run by matching on that. Everything else keys off our own job id, so a
 * missing or slow-to-appear run id degrades to "no link to GitHub yet" rather
 * than to a lost job.
 *
 * Server-only.
 */

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const WORKFLOW_FILE = "generate.yml";

export function githubConfig() {
  return {
    token: process.env.GITHUB_TOKEN || "",
    repo: process.env.GITHUB_REPO || "",
    ref: process.env.GITHUB_REF_NAME || "main",
  };
}

/** Whether renders should go to Actions at all. When this is false the caller
 *  falls back to spawning the worker locally, which is what makes development
 *  on a laptop work without pushing to GitHub for every test. */
export function usesGitHubActions(): boolean {
  const cfg = githubConfig();
  return Boolean(cfg.token && cfg.repo);
}

export function githubConfigProblems(): string[] {
  const cfg = githubConfig();
  const problems: string[] = [];
  if (!cfg.token) problems.push("GITHUB_TOKEN mangler i dashboard/.env.local");
  if (!cfg.repo) problems.push("GITHUB_REPO mangler (f.eks. \"shadyahmed41/nordicads\")");
  return problems;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = githubConfig();
  if (!cfg.token || !cfg.repo) {
    throw new GitHubError(githubConfigProblems().join("; "), 0);
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitHubError(`nettverksfeil mot GitHub: ${message}`, 0);
  }

  if (!res.ok) {
    const raw = await res.text();
    let body: { message?: string } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* non-JSON error body */
    }
    // 403 here is nearly always the token missing the Actions scope, which is
    // worth saying outright rather than leaving as a bare status code.
    const hint =
      res.status === 403 || res.status === 404
        ? " — mangler token-et 'Actions: read and write' på riktig repo?"
        : "";
    throw new GitHubError(`${body.message || raw.slice(0, 200) || `HTTP ${res.status}`}${hint}`, res.status);
  }

  return res;
}

export interface RenderInputs {
  command?: "generate" | "preview" | "status";
  mock?: boolean;
  commit?: boolean;
  slider?: boolean;
  origin?: string;
}

/**
 * Start a render. Returns once GitHub has accepted the dispatch — the run
 * itself takes a further ~20-30s to get a machine, which is why the caller
 * reports progress from our own job row rather than waiting on this.
 */
export async function dispatchRender(jobId: string, inputs: RenderInputs): Promise<void> {
  const cfg = githubConfig();
  // The API only accepts strings for workflow inputs.
  const payload = {
    ref: cfg.ref,
    inputs: {
      job_id: jobId,
      command: inputs.command ?? "generate",
      mock: String(inputs.mock ?? false),
      commit: String(inputs.commit ?? true),
      slider: String(inputs.slider ?? true),
      origin: inputs.origin ?? "none",
    },
  };

  await gh(`/repos/${cfg.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | …
  htmlUrl: string;
}

/**
 * Find the run started for `jobId`, or null if it has not registered yet.
 *
 * Dispatch does not tell us the run id, so we look for the run whose name
 * carries our job id — see `run-name` in the workflow. Only recent dispatches
 * are searched; an old job id will simply not be found, which is the right
 * answer anyway.
 */
export async function findRun(jobId: string): Promise<WorkflowRun | null> {
  const cfg = githubConfig();
  const res = await gh(
    `/repos/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=30`,
  );
  const body = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  for (const run of body.workflow_runs ?? []) {
    if (typeof run.name === "string" && run.name.includes(jobId)) {
      return {
        id: run.id as number,
        name: run.name,
        status: String(run.status ?? ""),
        conclusion: (run.conclusion as string | null) ?? null,
        htmlUrl: String(run.html_url ?? ""),
      };
    }
  }
  return null;
}

export async function getRun(runId: number): Promise<WorkflowRun> {
  const cfg = githubConfig();
  const res = await gh(`/repos/${cfg.repo}/actions/runs/${runId}`);
  const run = (await res.json()) as Record<string, unknown>;
  return {
    id: run.id as number,
    name: String(run.name ?? ""),
    status: String(run.status ?? ""),
    conclusion: (run.conclusion as string | null) ?? null,
    htmlUrl: String(run.html_url ?? ""),
  };
}

/** Cancel a run in flight — the dashboard's stop button. */
export async function cancelRun(runId: number): Promise<void> {
  const cfg = githubConfig();
  await gh(`/repos/${cfg.repo}/actions/runs/${runId}/cancel`, { method: "POST" });
}
