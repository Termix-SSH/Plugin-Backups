import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JOB,
  S3_REPO,
  decoded,
  pollOutput,
  startServer,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

async function withJob(overrides: Record<string, unknown> = {}) {
  const s = (server = await startServer());
  expect((await s.request("POST", "/repositories", S3_REPO)).status).toBe(200);
  const res = await s.request("POST", "/hosts/1/jobs", {
    ...JOB,
    ...overrides,
  });
  expect(res.status).toBe(200);
  return { s, job: res.body };
}

const lastLaunch = (s: TestServer) =>
  s.ssh.calls.filter((c) => c.stdin.includes("setsid bash")).pop()!;

function runUid(s: TestServer): string {
  return /runs\/([0-9a-f-]{36})/.exec(lastLaunch(s).stdin)![1]!;
}

const SUMMARY =
  '{"message_type":"summary","total_files_processed":3,"total_bytes_processed":900,"snapshot_id":"abcdef0123456789"}';

describe("host status", () => {
  it("reads tools", async () => {
    server = await startServer();
    server.ssh.replies.push({
      match: "restic_ok()",
      stdout:
        "kernel=Linux\narch=x86_64\nroot=1\nos=Debian\npm=apt-get\nrestic=0.18.0\nrestic_ok=1\nrclone=\ndocker=1\nmysqldump=1\npg_dump=0\nsqlite3=1\n",
    });
    const res = await server.request("GET", "/hosts/1/status");
    expect(res.body).toMatchObject({
      root: true,
      restic: "0.18.0",
      resticOk: true,
      rclone: null,
      tools: { mysqldump: true, pgDump: false },
    });
  });

  it("refuses non Linux", async () => {
    server = await startServer();
    server.ssh.replies.push({
      match: "restic_ok()",
      stdout: "kernel=Darwin\n",
    });
    expect((await server.request("GET", "/hosts/1/status")).status).toBe(400);
  });

  it("asks for sudo when it is missing", async () => {
    server = await startServer();
    server.ssh.replies.push({
      match: "restic_ok()",
      stderr: "sudo: a password is required",
      code: 1,
    });
    const res = await server.request("GET", "/hosts/1/status");
    expect(res.body.code).toBe("sudo");
  });
});

describe("repositories", () => {
  it("never sends secrets back, and makes a password when none is given", async () => {
    server = await startServer();
    const res = await server.request("POST", "/repositories", {
      ...S3_REPO,
      password: "",
    });
    expect(res.status).toBe(200);
    expect(res.body.hasSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("s3-very-secret");
    const shown = await server.request(
      "POST",
      `/repositories/${res.body.id}/password`,
    );
    expect(shown.body.password.length).toBeGreaterThan(20);
    expect(server.mock.audits.map((a) => a.action)).toContain(
      "backups.repository.reveal",
    );
  });

  it("needs the s3 secret and a valid rclone config", async () => {
    server = await startServer();
    expect(
      (
        await server.request("POST", "/repositories", {
          ...S3_REPO,
          secret: "",
        })
      ).status,
    ).toBe(400);
    const rclone = await server.request("POST", "/repositories", {
      name: "r",
      kind: "rclone",
      location: { remote: "gd", path: "x" },
      secret: "nope",
    });
    expect(rclone.status).toBe(400);
  });

  it("refuses a user and password in a url", async () => {
    server = await startServer();
    const res = await server.request("POST", "/repositories", {
      name: "r",
      kind: "rest",
      location: { url: "https://u:p@host/" },
    });
    expect(res.status).toBe(400);
  });

  it("keeps saved secrets when edited with empty ones", async () => {
    server = await startServer();
    const { body } = await server.request("POST", "/repositories", S3_REPO);
    const res = await server.request("PUT", `/repositories/${body.id}`, {
      ...S3_REPO,
      name: "Renamed",
      secret: "",
      password: "",
    });
    expect(res.body).toMatchObject({ name: "Renamed", hasSecret: true });
    const shown = await server.request(
      "POST",
      `/repositories/${body.id}/password`,
    );
    expect(shown.body.password).toBe("repo-pass-1");
  });

  it("is only seen by its owner", async () => {
    const s = (server = await startServer());
    const { body } = await s.request("POST", "/repositories", S3_REPO);
    s.setActor("user-2");
    expect((await s.request("GET", "/repositories")).body).toEqual([]);
    expect(
      (await s.request("POST", `/repositories/${body.id}/password`)).status,
    ).toBe(404);
  });

  it("can't be deleted while a job uses it", async () => {
    const { s } = await withJob();
    expect((await s.request("DELETE", "/repositories/1")).status).toBe(409);
    await s.request("DELETE", "/jobs/1");
    expect((await s.request("DELETE", "/repositories/1")).status).toBe(200);
  });

  it("checks and sets up from a host", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    s.ssh.replies.push({ match: "restic init", stdout: "init=1\n" });
    const res = await s.request("POST", "/repositories/1/test", {
      hostId: 1,
      init: true,
    });
    expect(res.body).toEqual({ ok: true, created: true, error: null });
    s.ssh.replies.length = 0;
    s.ssh.replies.push({
      match: "cat config",
      stdout: "ok=0\n@@termix:error\nwrong password\n",
    });
    const bad = await s.request("POST", "/repositories/1/test", { hostId: 1 });
    expect(bad.body).toMatchObject({ ok: false, error: "wrong password" });
  });
});

describe("jobs", () => {
  it("saves a job with a next run", async () => {
    const { job } = await withJob();
    expect(job).toMatchObject({
      name: "Nightly",
      repositoryName: "Offsite",
      repositoryKind: "s3",
      canEditRepo: true,
    });
    expect(Date.parse(job.nextRunAt)).toBeGreaterThan(Date.now());
  });

  it("has no next run when paused or by hand", async () => {
    expect((await withJob({ cron: "" })).job.nextRunAt).toBeNull();
    await server?.close();
    expect((await withJob({ enabled: false })).job.nextRunAt).toBeNull();
  });

  it("rejects bad input", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    const post = (body: unknown) => s.request("POST", "/hosts/1/jobs", body);
    expect((await post({ ...JOB, cron: "nope" })).status).toBe(400);
    expect((await post({ ...JOB, sources: [] })).status).toBe(400);
    expect(
      (
        await post({
          ...JOB,
          sources: [{ kind: "paths", paths: ["relative"] }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...JOB,
          sources: [{ kind: "docker", volumes: ["a;rm"], stacks: [] }],
        })
      ).status,
    ).toBe(400);
  });

  it("needs a repository of your own", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    s.setActor("user-2");
    const res = await s.request("POST", "/hosts/1/jobs", JOB);
    expect(res.status).toBe(400);
  });

  it("refuses a folder repository from another host", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", {
      name: "Disk",
      kind: "local",
      location: { hostId: 2, path: "/mnt/r" },
    });
    expect((await s.request("POST", "/hosts/1/jobs", JOB)).status).toBe(400);
    expect((await s.request("POST", "/hosts/2/jobs", JOB)).status).toBe(200);
  });

  it("seals a typed database password and keeps it on edit", async () => {
    const source = {
      id: "d1",
      kind: "database",
      engine: "mysql",
      loginId: 0,
      username: "root",
      password: "db-secret",
      databases: ["shop"],
    };
    const { s, job } = await withJob({ sources: [source] });
    expect(JSON.stringify(job)).not.toContain("db-secret");
    expect(job.sources[0].hasPassword).toBe(true);
    const saved = await s.request("PUT", `/jobs/${job.id}`, {
      ...JOB,
      sources: [{ ...source, password: "" }],
    });
    expect(saved.body.sources[0].hasPassword).toBe(true);
    await s.request("POST", `/jobs/${job.id}/run`);
    expect(decoded(lastLaunch(s).stdin)).toContain("db-secret");
    expect(lastLaunch(s).command).not.toContain("db-secret");
  });

  it("gates by host access", async () => {
    const { s, job } = await withJob();
    s.setLevel("connect");
    expect((await s.request("GET", `/jobs/${job.id}`)).status).toBe(200);
    const run = await s.request("POST", `/jobs/${job.id}/run`);
    expect(run.status).toBe(403);
    expect(run.body.code).toBe("HOST_EDIT_REQUIRED");
    s.setLevel("none");
    expect((await s.request("GET", `/jobs/${job.id}`)).status).toBe(404);
    expect((await s.request("GET", "/jobs")).body).toEqual([]);
  });

  it("needs the permission", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/jobs")).status).toBe(403);
  });
});

describe("runs", () => {
  it("starts a run with secrets only inside the script", async () => {
    const { s, job } = await withJob();
    const res = await s.request("POST", `/jobs/${job.id}/run`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "running", trigger: "manual" });
    const call = lastLaunch(s);
    expect(call.command).not.toContain("s3-very-secret");
    expect(call.stdin).not.toContain("s3-very-secret");
    expect(decoded(call.stdin)).toContain("s3-very-secret");
    expect(decoded(call.stdin)).toContain("/etc\n/srv/my data\n");
    expect(decoded(call.stdin)).toContain("echo before");
    const view = await s.request("GET", `/jobs/${job.id}`);
    expect(view.body.runningRunId).toBe(res.body.id);
  });

  it("allows one backup per job", async () => {
    const { s, job } = await withJob();
    await s.request("POST", `/jobs/${job.id}/run`);
    const again = await s.request("POST", `/jobs/${job.id}/run`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("running");
  });

  it("marks a run failed when the host refuses to start it", async () => {
    const { s, job } = await withJob();
    s.ssh.replies.push({
      match: "setsid bash",
      stdout: "SCRIPT_ERR:restic is not installed on this host\n",
      code: 7,
    });
    const res = await s.request("POST", `/jobs/${job.id}/run`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("restic is not installed");
    const runs = await s.request("GET", "/runs");
    expect(runs.body.runs[0]).toMatchObject({ status: "failed" });
    expect((await s.request("GET", `/jobs/${job.id}`)).body.lastStatus).toBe(
      "failed",
    );
  });

  it("finishes a polled run, updates the job and cleans up", async () => {
    const { s, job } = await withJob();
    const started = await s.request("POST", `/jobs/${job.id}/run`);
    const uid = runUid(s);
    s.ssh.replies.push({
      match: "@@termix:run=",
      stdout: pollOutput(uid, {
        alive: true,
        progress: '{"message_type":"status","percent_done":0.5}',
      }),
    });
    await s.mock.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let run = await s.request("GET", `/runs/${started.body.id}`);
    expect(run.body).toMatchObject({ status: "running", log: "a log line" });
    expect(run.body.progress.percent).toBe(0.5);

    s.ssh.replies.length = 0;
    s.ssh.replies.push({
      match: "@@termix:run=",
      stdout: pollOutput(uid, {
        result: "status=success\ncode=0\nmessage=",
        summary: SUMMARY,
      }),
    });
    await s.mock.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = await s.request("GET", `/runs/${started.body.id}`);
    expect(run.body).toMatchObject({
      status: "success",
      snapshotId: "abcdef0123456789",
    });
    const view = await s.request("GET", `/jobs/${job.id}`);
    expect(view.body).toMatchObject({
      lastStatus: "success",
      lastBytes: 900,
      runningRunId: null,
    });
    expect(view.body.lastSuccessAt).toBeTruthy();
    expect(s.ssh.calls.some((c) => c.stdin.includes("rm -rf"))).toBe(true);
    expect(s.mock.operationEvents.map((e) => e.eventId)).toEqual([
      "backups.run-finished",
    ]);
  });

  it("alerts on failure, once it works again, and not on stop", async () => {
    const { s, job } = await withJob();
    const fail = async (result: string) => {
      await s.request("POST", `/jobs/${job.id}/run`);
      s.ssh.replies.length = 0;
      s.ssh.replies.push({
        match: "@@termix:run=",
        stdout: pollOutput(runUid(s), { result }),
      });
      await s.mock.runScheduled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      s.ssh.replies.length = 0;
    };
    await fail("status=failed\ncode=1\nmessage=boom");
    expect(s.mock.notifications.at(-1)?.notification).toMatchObject({
      severity: "critical",
      category: "backups.run_failed",
    });
    await fail("status=success\ncode=0\nmessage=");
    expect(s.mock.notifications.at(-1)?.notification).toMatchObject({
      category: "backups.run_recovered",
    });
    const count = s.mock.notifications.length;
    await fail("status=canceled\ncode=130\nmessage=Canceled");
    expect(s.mock.notifications.length).toBe(count);
  });

  it("fails a dead run with no result after the grace time", async () => {
    const { s, job } = await withJob();
    const started = await s.request("POST", `/jobs/${job.id}/run`);
    s.ssh.replies.push({
      match: "@@termix:run=",
      stdout: pollOutput(runUid(s), {}),
    });
    await s.mock.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await s.request("GET", `/runs/${started.body.id}`)).body.status,
    ).toBe("running");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await s.mock.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.restoreAllMocks();
    const run = await s.request("GET", `/runs/${started.body.id}`);
    expect(run.body.status).toBe("failed");
    expect(run.body.error).toContain("without a result");
  });

  it("stops a run", async () => {
    const { s, job } = await withJob();
    const started = await s.request("POST", `/jobs/${job.id}/run`);
    const res = await s.request("POST", `/runs/${started.body.id}/cancel`);
    expect(res.status).toBe(200);
    expect(s.ssh.calls.at(-1)!.stdin).toContain("kill -TERM");
  });

  it("pages history", async () => {
    const { s, job } = await withJob({ cron: "" });
    for (let i = 0; i < 3; i++) {
      await s.request("POST", `/jobs/${job.id}/run`);
      s.ssh.replies.length = 0;
      s.ssh.replies.push({
        match: "@@termix:run=",
        stdout: pollOutput(runUid(s), { result: "status=success\ncode=0" }),
      });
      await s.mock.runScheduled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      s.ssh.replies.length = 0;
    }
    const first = await s.request("GET", "/runs?limit=2");
    expect(first.body.runs).toHaveLength(2);
    expect(first.body.next).toBeTruthy();
    const second = await s.request(
      "GET",
      `/runs?limit=2&before=${first.body.next}`,
    );
    expect(second.body.runs).toHaveLength(1);
    expect(second.body.next).toBeNull();
  });
});

describe("snapshots", () => {
  const SNAP = "abcdef0123456789";
  const LISTED = `[{"id":"${SNAP}","time":"2026-11-04T02:00:00Z"}]`;

  it("lists, with the job's tag", async () => {
    const { s, job } = await withJob();
    s.ssh.replies.push({
      match: "restic snapshots",
      stdout: `[{"id":"${SNAP}","short_id":"abcdef01","time":"2026-11-04T02:00:00Z"}]`,
    });
    const res = await s.request("GET", `/jobs/${job.id}/snapshots`);
    expect(res.body[0]).toMatchObject({ shortId: "abcdef01" });
    expect(s.ssh.calls.at(-1)!.stdin).toContain("--tag 'termix-job:");
  });

  it("refuses a snapshot of another job", async () => {
    const { s, job } = await withJob();
    s.ssh.replies.push({ match: "restic snapshots", stdout: "[]" });
    const paths = [
      ["GET", `/jobs/${job.id}/snapshots/${SNAP}/files`],
      ["GET", `/jobs/${job.id}/snapshots/${SNAP}/download?path=/etc`],
      ["DELETE", `/jobs/${job.id}/snapshots/${SNAP}`],
      ["POST", `/jobs/${job.id}/snapshots/${SNAP}/restore`],
    ] as const;
    for (const [method, path] of paths) {
      const res = await s.request(
        method,
        path,
        method === "POST" ? {} : undefined,
      );
      expect(res.status, path).toBe(404);
    }
    expect(s.ssh.calls.some((c) => c.stdin.includes("restic ls"))).toBe(false);
    expect(s.ssh.calls.some((c) => c.stdin.includes("restic forget"))).toBe(
      false,
    );
    expect(s.ssh.calls.some((c) => c.stdin.includes("setsid bash"))).toBe(
      false,
    );
  });

  it("refuses a bad snapshot id", async () => {
    const { s, job } = await withJob();
    const res = await s.request("GET", `/jobs/${job.id}/snapshots/x;y/files`);
    expect(res.status).toBe(400);
  });

  it("needs edit to browse", async () => {
    const { s, job } = await withJob();
    s.setLevel("connect");
    const res = await s.request(
      "GET",
      `/jobs/${job.id}/snapshots/${SNAP}/files`,
    );
    expect(res.status).toBe(403);
  });

  it("restores on another host, and is audited", async () => {
    const { s, job } = await withJob();
    s.ssh.replies.push({ match: "restic snapshots", stdout: LISTED });
    const res = await s.request(
      "POST",
      `/jobs/${job.id}/snapshots/${SNAP}/restore`,
      {
        hostId: 2,
        path: "/tmp/out",
        includes: ["/etc/hosts"],
        overwrite: "never",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "restore", hostId: 2 });
    expect(lastLaunch(s).hostId).toBe(2);
    expect(decoded(lastLaunch(s).stdin)).toContain("/etc/hosts\n");
    expect(s.mock.audits.map((a) => a.action)).toContain("backups.restore");
    // A restore does not count as the job running.
    expect((await s.request("GET", `/jobs/${job.id}`)).body.runningRunId).toBe(
      null,
    );
  });

  it("won't restore a folder repository on another host", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", {
      name: "Disk",
      kind: "local",
      location: { hostId: 1, path: "/mnt/r" },
    });
    await s.request("POST", "/hosts/1/jobs", JOB);
    s.ssh.replies.push({ match: "restic snapshots", stdout: LISTED });
    const res = await s.request("POST", `/jobs/1/snapshots/${SNAP}/restore`, {
      hostId: 2,
    });
    expect(res.status).toBe(400);
  });
});

describe("scheduler", () => {
  it("runs a due job once and moves its next time on", async () => {
    const { s, job } = await withJob();
    const { createScheduler } = await import("../../src/backend/scheduler.js");
    const { createEngine } = await import("../../src/backend/engine.js");
    const { createStore } = await import("../../src/backend/store.js");
    const { createRemote } = await import("../../src/backend/remote.js");
    const tables = await import("../../src/backend/tables.js");
    const store = createStore(s.mock.ctx.db, {
      repositories: await s.mock.ctx.db.define(tables.repositories),
      jobs: await s.mock.ctx.db.define(tables.jobs),
      runs: await s.mock.ctx.db.define(tables.runs),
    });
    const engine = createEngine(s.mock.ctx, createRemote(s.mock.ctx), store);
    const scheduler = createScheduler(
      s.mock.ctx,
      store,
      engine,
      async () => {},
    );
    await store.updateJob(job.id, { nextRunAt: "2026-01-01T00:00:00.000Z" });
    await scheduler.tick(new Date());
    const row = await store.getJob(job.id);
    expect(Date.parse(row!.nextRunAt!)).toBeGreaterThan(Date.now());
    const runs = await s.request("GET", "/runs");
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0].trigger).toBe("schedule");
    await scheduler.tick(new Date());
    expect((await s.request("GET", "/runs")).body.runs).toHaveLength(1);
  });
});
