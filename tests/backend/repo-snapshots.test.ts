import { afterEach, describe, expect, it } from "vitest";
import { S3_REPO, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const SNAP = "abcdef0123456789";

async function withRepo() {
  const s = (server = await startServer());
  const res = await s.request("POST", "/repositories", S3_REPO);
  expect(res.status).toBe(200);
  return { s, repo: res.body };
}

describe("repository snapshots", () => {
  it("lists every snapshot, not only the ones of a job", async () => {
    const { s, repo } = await withRepo();
    s.ssh.replies.push({
      match: "restic snapshots",
      stdout: `[{"id":"${SNAP}","short_id":"abcdef01","time":"2026-11-04T02:00:00Z","hostname":"nas","paths":["/data"]}]`,
    });
    const res = await s.request(
      "GET",
      `/repositories/${repo.id}/snapshots?hostId=2`,
    );
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ shortId: "abcdef01", hostname: "nas" });
    const call = s.ssh.calls.at(-1)!;
    expect(call.hostId).toBe(2);
    expect(call.stdin).not.toContain("--tag");
  });

  it("needs a host and edit access to it", async () => {
    const { s, repo } = await withRepo();
    expect(
      (await s.request("GET", `/repositories/${repo.id}/snapshots`)).status,
    ).toBe(400);
    s.setLevel("connect");
    expect(
      (await s.request("GET", `/repositories/${repo.id}/snapshots?hostId=1`))
        .status,
    ).toBe(403);
  });

  it("lists files and restores to a picked host", async () => {
    const { s, repo } = await withRepo();
    s.ssh.replies.push({ match: "restic ls", stdout: "" });
    const files = await s.request(
      "GET",
      `/repositories/${repo.id}/snapshots/${SNAP}/files?hostId=1&path=/etc`,
    );
    expect(files.status).toBe(200);
    expect(s.ssh.calls.at(-1)!.stdin).toContain("restic ls");

    const res = await s.request(
      "POST",
      `/repositories/${repo.id}/snapshots/${SNAP}/restore`,
      { hostId: 2, path: "/tmp/out" },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "restore",
      jobId: null,
      jobName: S3_REPO.name,
      hostId: 2,
    });
    const audit = s.mock.audits.at(-1);
    expect(audit).toMatchObject({ action: "backups.restore", success: true });
  });

  it("needs a target host to restore", async () => {
    const { s, repo } = await withRepo();
    const res = await s.request(
      "POST",
      `/repositories/${repo.id}/snapshots/${SNAP}/restore`,
      { path: "/tmp/out" },
    );
    expect(res.status).toBe(400);
  });

  it("is only for the repository's owner", async () => {
    const { s, repo } = await withRepo();
    s.setActor("user-2");
    const res = await s.request(
      "GET",
      `/repositories/${repo.id}/snapshots?hostId=1`,
    );
    expect(res.status).toBe(404);
  });
});
