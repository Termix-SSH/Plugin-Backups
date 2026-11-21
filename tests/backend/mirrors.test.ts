import { afterEach, describe, expect, it } from "vitest";
import {
  copySourceEnv,
  mirrorConflict,
  mirrorEnv,
} from "../../src/backend/repo-env.js";
import { mirrorLines } from "../../src/backend/scripts.js";
import { JOB, S3_REPO, decoded, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const s3 = (accessKeyId: string, region = "eu-1") => ({
  kind: "s3" as const,
  location: { bucket: "b", accessKeyId, region },
});

describe("mirror rules", () => {
  it("refuses pairs that need the same env names with other values", () => {
    expect(mirrorConflict(s3("A"), s3("A"), 1)).toBeNull();
    expect(mirrorConflict(s3("A"), s3("B"), 1)).toMatch(/access key/);
    expect(mirrorConflict(s3("A"), s3("A", "us-1"), 1)).toMatch(/region/);
    expect(
      mirrorConflict(
        { kind: "rclone", location: { remote: "box" } },
        { kind: "rclone", location: { remote: "BOX" } },
        1,
      ),
    ).toMatch(/remote names/);
    expect(
      mirrorConflict(s3("A"), { kind: "local", location: { hostId: 2 } }, 1),
    ).toMatch(/own host/);
    expect(
      mirrorConflict(s3("A"), { kind: "local", location: { hostId: 1 } }, 1),
    ).toBeNull();
  });

  it("prefixes a mirror's env and puts a rest login in the source address", () => {
    expect(
      mirrorEnv(2, {
        RESTIC_REPOSITORY: "s3:x",
        RESTIC_PASSWORD: "pw",
        RESTIC_PROGRESS_FPS: "0.2",
      }),
    ).toEqual({
      TMX_M2_RESTIC_REPOSITORY: "s3:x",
      TMX_M2_RESTIC_PASSWORD: "pw",
    });
    expect(
      copySourceEnv(
        "rest",
        { url: "https://backup.example.com:8000/host1", username: "me" },
        "p@ss word",
      ),
    ).toEqual({
      TMX_FROM_REPOSITORY:
        "rest:https://me:p%40ss%20word@backup.example.com:8000/host1/",
    });
    expect(copySourceEnv("s3", { bucket: "b" }, "x")).toEqual({});
  });

  it("copies each mirror in its own subshell and only warns on failure", () => {
    const lines = mirrorLines(2, "termix-job:abc", "--keep-daily 7");
    expect(lines).toContain("for M in 1 2; do");
    expect(lines).toContain("restic copy --tag 'termix-job:abc'");
    expect(lines).toContain("--keep-daily 7 --prune");
    expect(lines).toContain("STATUS=warning");
    expect(lines).not.toContain("fail ");
    expect(mirrorLines(0, "t", "")).toBe("");
  });
});

describe("mirror jobs", () => {
  it("saves a mirror and copies to it after the backup", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    const second = await s.request("POST", "/repositories", {
      ...S3_REPO,
      name: "Second",
      location: { ...S3_REPO.location, bucket: "copy" },
    });
    const res = await s.request("POST", "/hosts/1/jobs", {
      ...JOB,
      mirrors: [second.body.id, 1],
    });
    expect(res.status).toBe(200);
    expect(res.body.mirrors).toEqual([second.body.id]);

    await s.request("POST", `/jobs/${res.body.id}/run`);
    const launch = s.ssh.calls
      .filter((c) => c.stdin.includes("setsid bash"))
      .pop()!;
    expect(launch.stdin).toContain("export TMX_M1_RESTIC_REPOSITORY=");
    const script = decoded(launch.stdin).find((text) =>
      text.includes("Copying to mirror"),
    );
    expect(script).toContain("for M in 1; do");

    const del = await s.request("DELETE", `/repositories/${second.body.id}`);
    expect(del.status).toBe(409);
  });

  it("refuses a mirror that can't take a copy", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    const other = await s.request("POST", "/repositories", {
      ...S3_REPO,
      name: "Other key",
      location: { ...S3_REPO.location, accessKeyId: "OTHERKEY" },
    });
    const res = await s.request("POST", "/hosts/1/jobs", {
      ...JOB,
      mirrors: [other.body.id],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("access key");
  });
});
