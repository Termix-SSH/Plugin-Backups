import { afterEach, describe, expect, it } from "vitest";
import { JOB, S3_REPO, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

type Status = "ok" | "warn" | "fail" | "unknown";

async function withStorage(status: Status | null, repo: "local" | "s3") {
  const s = (server = await startServer());
  if (status) {
    s.mock.ctx.services.provide("storage-health.access", {
      check: async () => ({
        status,
        problems: 2,
        worstDrive: "sdb",
        readAt: Date.now(),
      }),
    });
  }
  const body =
    repo === "local"
      ? {
          name: "Disk",
          kind: "local",
          location: { hostId: 1, path: "/mnt/backups" },
        }
      : S3_REPO;
  expect((await s.request("POST", "/repositories", body)).status).toBe(200);
  const job = await s.request("POST", "/hosts/1/jobs", JOB);
  expect(job.status).toBe(200);
  const run = await s.request("POST", `/jobs/${job.body.id}/run`);
  expect(run.status).toBe(200);
  return s.mock.notifications
    .map((n) => n.notification)
    .filter((n) => n.category === "backups.target_unhealthy");
}

describe("backup to unhealthy storage", () => {
  it("warns when a folder repository sits on failing storage, and still runs", async () => {
    const sent = await withStorage("fail", "local");
    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe("critical");
    expect(sent[0].body).toContain("sdb");
    expect(sent[0].dedupeKey).toMatch(/^backups:\d+:storage:fail$/);
  });

  it("warns softly for a warning", async () => {
    const sent = await withStorage("warn", "local");
    expect(sent).toHaveLength(1);
    expect(sent[0].severity).toBe("warning");
  });

  it("stays quiet when storage is fine or unknown", async () => {
    expect(await withStorage("ok", "local")).toEqual([]);
    await server?.close();
    expect(await withStorage("unknown", "local")).toEqual([]);
  });

  it("ignores remote repositories", async () => {
    expect(await withStorage("fail", "s3")).toEqual([]);
  });

  it("works without the Storage Health plugin", async () => {
    expect(await withStorage(null, "local")).toEqual([]);
  });
});
