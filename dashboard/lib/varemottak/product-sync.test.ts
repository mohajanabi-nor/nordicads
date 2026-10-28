/**
 * The full product refresh that an invoice import starts: dispatched once, joined when one is running or recent, skipped
 * on a laptop, and never able to fail the import.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  githubOn: true,
  active: null as null | { id: string },
  jobs: [] as Array<{ command: string; created_at: string }>,
  created: [] as Array<{ id: string; command: string; inputs: unknown }>,
  dispatched: [] as Array<{ jobId: string; inputs: unknown }>,
  dispatchFails: false,
  logs: [] as string[],
}));

vi.mock("@/lib/github-actions", () => ({
  usesGitHubActions: () => state.githubOn,
  dispatchRender: async (jobId: string, inputs: unknown) => {
    if (state.dispatchFails) throw new Error("GitHub said no");
    state.dispatched.push({ jobId, inputs });
  },
}));
vi.mock("@/lib/worker-jobs", () => ({
  activeJobFor: async () => state.active,
  listJobs: async () => state.jobs,
  newJobId: () => "wTEST-1",
  createJob: async (id: string, command: string, inputs: unknown) => void state.created.push({ id, command, inputs }),
}));
vi.mock("@/lib/eventlog", () => ({
  logInfo: async (_s: string, event: string) => void state.logs.push(`info:${event}`),
  logError: async (_s: string, event: string) => void state.logs.push(`error:${event}`),
}));

import { requestProductSync } from "./product-sync";

beforeEach(() => {
  Object.assign(state, { githubOn: true, active: null, jobs: [], created: [], dispatched: [], dispatchFails: false, logs: [] });
  delete process.env.SHOPIFY_FAKE;
  delete process.env.VAREMOTTAK_STORE;
});

describe("requestProductSync", () => {
  it("starts the whole-catalogue job once and says where the request came from", async () => {
    expect(await requestProductSync()).toBe("started");
    expect(state.created).toEqual([{ id: "wTEST-1", command: "products", inputs: { trigger: "varemottak-import" } }]);
    expect(state.dispatched).toEqual([{ jobId: "wTEST-1", inputs: { command: "products" } }]);
    expect(state.logs).toEqual(["info:products.dispatched"]);
  });

  it("joins a refresh that is already running, or one started in the last ten minutes", async () => {
    state.active = { id: "w-running" };
    expect(await requestProductSync()).toBe("already-running");
    state.active = null;
    state.jobs = [{ command: "products", created_at: new Date(Date.now() - 3 * 60_000).toISOString() }];
    expect(await requestProductSync()).toBe("recent");
    expect(state.dispatched).toHaveLength(0);
    // an old one, or another kind of job, does not block it
    state.jobs = [{ command: "products", created_at: new Date(Date.now() - 30 * 60_000).toISOString() }, { command: "render", created_at: new Date().toISOString() }];
    expect(await requestProductSync()).toBe("started");
  });

  it("does nothing on a laptop (fake shop, local store, or no GitHub settings)", async () => {
    process.env.SHOPIFY_FAKE = "1";
    expect(await requestProductSync()).toBe("unavailable");
    delete process.env.SHOPIFY_FAKE;
    process.env.VAREMOTTAK_STORE = "file";
    expect(await requestProductSync()).toBe("unavailable");
    delete process.env.VAREMOTTAK_STORE;
    state.githubOn = false;
    expect(await requestProductSync()).toBe("unavailable");
    expect(state.created).toHaveLength(0);
  });

  it("a failed dispatch is reported as 'failed', logged, and never thrown", async () => {
    state.dispatchFails = true;
    await expect(requestProductSync()).resolves.toBe("failed");
    expect(state.logs).toContain("error:products.dispatchFailed");
  });
});
