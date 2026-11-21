import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginHostAccess } from "@termix-ssh/plugin-sdk/backend";
import { looksLikeTar, relay } from "../../src/backend/relay.js";
import {
  parseSourceOutput,
  pullRoot,
  receiveScript,
  relativePaths,
  relaySourceScript,
  resticExcludes,
  restoreFileSink,
  restoreTarSink,
  sourcePath,
  tarExcludes,
} from "../../src/backend/relay-scripts.js";
import { parsePoll } from "../../src/backend/restic-json.js";
import { runnerHost } from "../../src/backend/validate.js";
import { JOB, S3_REPO, decoded, startServer, type TestServer } from "./helpers";

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const M = "@@termix:";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** A tar header: "ustar" at byte 257. */
function tarBytes(size = 1024): Buffer {
  const buf = Buffer.alloc(size, 1);
  buf.write("ustar", 257);
  return buf;
}

interface Exec {
  hostId: number;
  command: string;
  input: Buffer;
  channel: FakeChannel;
}

type Behavior = (exec: Exec) => void;

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  written: Buffer[] = [];
  done = false;
  constructor(private onEnd: () => void) {
    super();
  }
  write(data: string | Buffer) {
    this.written.push(Buffer.from(data));
    return true;
  }
  end() {
    setImmediate(() => this.onEnd());
  }
  close() {
    this.finish(null);
  }
  pause() {}
  resume() {}
  finish(code: number | null) {
    if (this.done) return;
    this.done = true;
    this.emit("exit", code);
    this.emit("close");
  }
}

/** ctx.ssh.connect played by per host behaviors. */
function fakeConnect(behaviors: Record<number, Behavior>) {
  const execs: Exec[] = [];
  const connect = async (hostId: number) => ({
    client: {
      exec(command: string, cb: (e: Error | undefined, s: unknown) => void) {
        const exec = { hostId, command, input: Buffer.alloc(0) } as Exec;
        exec.channel = new FakeChannel(() => {
          exec.input = Buffer.concat(exec.channel.written);
          behaviors[hostId]!(exec);
        });
        execs.push(exec);
        cb(undefined, exec.channel);
      },
    },
    jumpClient: null,
    host: { id: hostId },
    dispose: () => {},
  });
  return { connect, execs };
}

/** A source that sends data and stderr, then exits. */
const send =
  (data: Buffer[], stderr = "", code = 0): Behavior =>
  ({ channel }) => {
    for (const chunk of data) channel.emit("data", chunk);
    if (stderr) channel.stderr.emit("data", Buffer.from(stderr));
    channel.finish(code);
  };

const take =
  (code = 0, stderr = ""): Behavior =>
  ({ channel }) => {
    if (stderr) channel.stderr.emit("data", Buffer.from(stderr));
    channel.finish(code);
  };

function sourceStderr(status: string, present: string[], message = "") {
  return `2026-11-20T00:00:00Z Sending the files\n${M}result\nstatus=${status}\ncode=0\nmessage=${message}\n${M}present\n${present.join("\n")}\n`;
}

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

describe("relay script helpers", () => {
  it("makes paths relative to /", () => {
    expect(relativePaths(["/etc", "/srv/my data/", "/etc"])).toEqual([
      "etc",
      "srv/my data",
    ]);
    expect(relativePaths(["/etc", "/"])).toEqual(["."]);
  });

  it("turns restic excludes into tar options and moves absolute ones under the copy", () => {
    expect(
      tarExcludes(["/var/cache/", "*.log", "**/node_modules", "!x"]),
    ).toEqual([
      "--anchored",
      "--exclude=var/cache",
      "--no-anchored",
      "--exclude=*.log",
      "--exclude=*/node_modules",
    ]);
    expect(resticExcludes(["/var/cache", "*.log", "!/keep"], "/r")).toEqual([
      "/r/var/cache",
      "*.log",
      "!/r/keep",
    ]);
  });

  it("shows snapshot paths as they were on the source", () => {
    const root = pullRoot("j1");
    expect(sourcePath(`${root}/etc`, root)).toBe("/etc");
    expect(sourcePath(root, root)).toBe("/");
    expect(sourcePath("/other", root)).toBe("/other");
  });

  it("reads the source's log, result and found paths", () => {
    const out = parseSourceOutput(
      sourceStderr("warning", ["etc", "srv/a b"], "x"),
    );
    expect(out).toMatchObject({
      status: "warning",
      message: "x",
      present: ["etc", "srv/a b"],
    });
    expect(out.log).toContain("Sending the files");
    expect(parseSourceOutput("sudo: a password is required").status).toBeNull();
  });

  it("only treats a ustar header as a tar", () => {
    expect(looksLikeTar(tarBytes())).toBe(true);
    expect(looksLikeTar(Buffer.from("hello"))).toBe(false);
  });

  it("validates the restic host id", () => {
    expect(runnerHost(undefined)).toBeNull();
    expect(runnerHost(0)).toBeNull();
    expect(runnerHost("3")).toBe(3);
    expect(() => runnerHost(-1)).toThrow();
  });
});

describe.skipIf(!hasBash)("relay scripts are valid bash", () => {
  const base = {
    uid: "u1",
    jobUid: "j1",
    paths: ["etc", "srv/my data"],
    excludes: ["/var/cache", "*.log"],
    dumps: [],
    stopStacks: ["web"],
    oneFileSystem: true,
    pre: "echo hi",
    post: "echo bye",
    gen: "u1 abc",
  };
  const scripts = {
    gnuFull: relaySourceScript(
      { ...base, gnu: true, incremental: true, full: true },
      { TERMIX_DB_1: "pw" },
    ),
    gnuIncremental: relaySourceScript(
      { ...base, gnu: true, incremental: true, full: false },
      {},
    ),
    busybox: relaySourceScript(
      { ...base, gnu: false, incremental: false, full: true },
      {},
    ),
    receive: receiveScript({
      uid: "u1",
      jobUid: "j1",
      gnu: true,
      incremental: true,
      full: false,
      gen: "u1 abc",
    }),
    tarSink: restoreTarSink("/srv/out dir", "never", true),
    fileSink: restoreFileSink("/srv/out", "/etc/it's", "never"),
  };
  for (const [name, script] of Object.entries(scripts)) {
    it(name, () => {
      const run = spawnSync("bash", ["-n"], {
        input: script,
        encoding: "utf8",
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    });
  }

  it("keeps secrets out of the plain text and uses GNU options only with GNU tar", () => {
    expect(scripts.gnuFull).not.toContain("pw\n");
    expect(scripts.gnuFull).toContain("--listed-incremental");
    expect(scripts.gnuFull).toContain("--one-file-system");
    expect(scripts.gnuFull).toContain(
      "rm -f '/var/lib/termix-backups/pull/j1/src/snar'",
    );
    expect(scripts.gnuIncremental).toContain(
      "cp -f '/var/lib/termix-backups/pull/j1/src/snar'",
    );
    expect(scripts.busybox).not.toContain("--listed-incremental");
    expect(scripts.busybox).not.toContain("--exclude");
    expect(scripts.receive).toContain("--listed-incremental=/dev/null");
    expect(scripts.receive).not.toContain(
      "rm -rf '/var/lib/termix-backups/pull/j1/root'",
    );
    expect(scripts.tarSink).toContain("--skip-old-files");
  });
});

describe("relay", () => {
  it("pipes the source's stdout into the sink with the stream intact", async () => {
    const chunks = [tarBytes(300), Buffer.alloc(400, 2), Buffer.alloc(50, 3)];
    const { connect, execs } = fakeConnect({
      1: send(chunks, "log"),
      2: take(),
    });
    const ctx = { ssh: { connect } } as never;
    const result = await relay(ctx, {
      sourceHost: 1,
      sourceCommand: "src",
      sourceStdin: "script",
      sink: (head) => ({
        host: 2,
        command: looksLikeTar(head) ? "tar" : "file",
      }),
    });
    expect(result).toMatchObject({ bytes: 750, canceled: false });
    expect(result.source).toEqual({ code: 0, stderr: "log" });
    expect(result.sink?.code).toBe(0);
    const sink = execs.find((e) => e.hostId === 2)!;
    expect(sink.command).toBe("tar");
    expect(sink.input.equals(Buffer.concat(chunks))).toBe(true);
    expect(execs[0]!.input.toString()).toBe("script");
  });

  it("starts the sink for an empty file, but not when the source failed", async () => {
    const ok = fakeConnect({ 1: send([]), 2: take() });
    const result = await relay({ ssh: { connect: ok.connect } } as never, {
      sourceHost: 1,
      sourceCommand: "src",
      sink: (head) => ({
        host: 2,
        command: looksLikeTar(head) ? "tar" : "file",
      }),
    });
    expect(result.sink?.code).toBe(0);
    expect(ok.execs[1]!.command).toBe("file");

    const bad = fakeConnect({ 1: send([], "boom", 1), 2: take() });
    const failed = await relay({ ssh: { connect: bad.connect } } as never, {
      sourceHost: 1,
      sourceCommand: "src",
      sink: () => ({ host: 2, command: "x" }),
    });
    expect(failed.sink).toBeNull();
    expect(failed.source).toEqual({ code: 1, stderr: "boom" });
  });

  it("stops both sides on abort", async () => {
    const controller = new AbortController();
    const hang: Behavior = ({ channel }) => {
      channel.emit("data", tarBytes(600));
      setTimeout(() => controller.abort(), 20);
    };
    const { connect } = fakeConnect({ 1: hang, 2: () => {} });
    const result = await relay({ ssh: { connect } } as never, {
      sourceHost: 1,
      sourceCommand: "src",
      sink: () => ({ host: 2, command: "x" }),
      signal: controller.signal,
    });
    expect(result.canceled).toBe(true);
  });
});

/** Host 1 holds the files, host 2 runs restic. */
async function relayJob(level2: PluginHostAccess["permissionLevel"] = "edit") {
  const s = (server = await startServer());
  const original = s.mock.ctx.hosts.checkAccess;
  Object.assign(s.mock.ctx.hosts, {
    checkAccess: async (id: number, need: "connect" | "edit" = "connect") => {
      if (id !== 2) return original(id, need);
      const ok = need === "connect" || level2 === "edit" || level2 === "manage";
      return {
        hasAccess: ok,
        isOwner: false,
        isShared: true,
        permissionLevel: level2,
      };
    },
  });
  s.ssh.replies.push({
    match: "grep -q 'GNU tar'",
    stdout: "gnu=1\ntar=1\ngen=\n",
  });
  await s.request("POST", "/repositories", S3_REPO);
  const res = await s.request("POST", "/hosts/1/jobs", {
    ...JOB,
    runnerHostId: 2,
  });
  return { s, res };
}

describe("jobs that run restic on another host", () => {
  it("saves the restic host and needs edit access to it", async () => {
    const { res } = await relayJob();
    expect(res.status).toBe(200);
    expect(res.body.runnerHostId).toBe(2);

    await server!.close();
    server = null;
    const denied = await relayJob("view");
    expect(denied.res.status).toBe(403);
  });

  it("drops a restic host that is the job's own host", async () => {
    const s = (server = await startServer());
    await s.request("POST", "/repositories", S3_REPO);
    const res = await s.request("POST", "/hosts/1/jobs", {
      ...JOB,
      runnerHostId: 1,
    });
    expect(res.body.runnerHostId).toBeNull();
  });

  it("refuses a folder repository on the job's host when restic runs elsewhere", async () => {
    const s = (server = await startServer());
    const repo = await s.request("POST", "/repositories", {
      name: "Disk",
      kind: "local",
      location: { hostId: 1, path: "/srv/restic" },
      password: "p",
    });
    const res = await s.request("POST", "/hosts/1/jobs", {
      ...JOB,
      repositoryId: repo.body.id,
      runnerHostId: 2,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/runs restic/);
  });

  it("copies through Termix, then starts restic on the copy", async () => {
    const { s, res } = await relayJob();
    const job = res.body;
    const { connect, execs } = fakeConnect({
      1: send([tarBytes()], sourceStderr("success", ["etc"])),
      2: take(),
    });
    Object.assign(s.mock.ctx.ssh, { connect });

    const run = await s.request("POST", `/jobs/${job.id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.hostId).toBe(1);
    await until(() => s.ssh.calls.some((c) => c.stdin.includes("setsid bash")));

    const source = execs.find((e) => e.hostId === 1)!;
    expect(source.input.toString()).toContain("tar -c -f - -C /");
    expect(decoded(source.input.toString())).toContain("echo before");
    const sink = execs.find((e) => e.hostId === 2)!;
    expect(sink.command).toContain("receive.sh");

    const launch = s.ssh.calls.find((c) => c.stdin.includes("setsid bash"))!;
    expect(launch.hostId).toBe(2);
    const files = decoded(launch.stdin);
    const runSh = files.find((f) => f.includes("Backing up"))!;
    expect(runSh).toMatch(/cd '\/var\/lib\/termix-backups\/pull\/[^']+\/root'/);
    expect(runSh).toContain("'--host' 'host 1'");
    expect(files).not.toContain("echo before");
    expect(files).toContain("etc\n");
    expect(files.some((f) => f.includes("Copying all files"))).toBe(true);

    // The poll now asks host 2, where the run's files are.
    s.ssh.calls.length = 0;
    const row = await s.request("GET", `/runs/${run.body.id}`);
    expect(row.body.status).toBe("running");
    await s.mock.runScheduled();
    const poll = s.ssh.calls.find((c) => c.stdin.includes(`${M}end`));
    expect(poll?.hostId).toBe(2);
  });

  it("does a full copy the first time and builds on it after", async () => {
    const { s, res } = await relayJob();
    s.ssh.replies.unshift({
      match: "grep -q 'GNU tar'",
      stdout: "gnu=1\ntar=1\ngen=g1 0000000000000000\n",
    });
    const { connect, execs } = fakeConnect({
      1: send([tarBytes()], sourceStderr("success", ["etc"])),
      2: take(),
    });
    Object.assign(s.mock.ctx.ssh, { connect });
    await s.request("POST", `/jobs/${res.body.id}/run`);
    await until(() => execs.length === 2);
    // The saved state is from other paths, so this copy starts over.
    expect(execs[0]!.input.toString()).toContain(
      "rm -f '/var/lib/termix-backups/pull/",
    );
  });

  it("fails the run with the source host's message", async () => {
    const { s, res } = await relayJob();
    const { connect } = fakeConnect({
      1: send([], sourceStderr("failed", [], "The pre command failed"), 1),
      2: take(),
    });
    Object.assign(s.mock.ctx.ssh, { connect });
    const run = await s.request("POST", `/jobs/${res.body.id}/run`);
    await until(
      async () =>
        (await s.request("GET", `/runs/${run.body.id}`)).body.status !==
        "running",
    );
    const done = await s.request("GET", `/runs/${run.body.id}`);
    expect(done.body).toMatchObject({
      status: "failed",
      error: "The pre command failed",
    });
    expect(done.body.log).toContain("Sending the files");
  });

  it("fails when the restic host can't unpack, and cancels a copy", async () => {
    const { s, res } = await relayJob();
    const { connect } = fakeConnect({
      1: send([tarBytes()], sourceStderr("success", ["etc"])),
      2: take(1, `${M}message=Unpacking the files on the restic host failed\n`),
    });
    Object.assign(s.mock.ctx.ssh, { connect });
    const run = await s.request("POST", `/jobs/${res.body.id}/run`);
    await until(
      async () =>
        (await s.request("GET", `/runs/${run.body.id}`)).body.status ===
        "failed",
    );
    expect((await s.request("GET", `/runs/${run.body.id}`)).body.error).toBe(
      "Unpacking the files on the restic host failed",
    );

    const hang = fakeConnect({
      1: ({ channel }) => channel.emit("data", tarBytes(600)),
      2: () => {},
    });
    Object.assign(s.mock.ctx.ssh, { connect: hang.connect });
    const second = await s.request("POST", `/jobs/${res.body.id}/run`);
    await until(() => hang.execs.length === 2);
    const cancel = await s.request("POST", `/runs/${second.body.id}/cancel`);
    expect(cancel.status).toBe(200);
    await until(
      async () =>
        (await s.request("GET", `/runs/${second.body.id}`)).body.status ===
        "canceled",
    );
  });

  it("lists snapshots from the restic host with the source's paths", async () => {
    const { s, res } = await relayJob();
    await s.request("GET", `/jobs/${res.body.id}/snapshots`);
    const uid = /termix-job:([^']+)'/.exec(s.ssh.calls.at(-1)!.stdin)![1]!;
    expect(s.ssh.calls.at(-1)!.hostId).toBe(2);
    s.ssh.replies.unshift({
      match: "restic snapshots",
      stdout: JSON.stringify([
        {
          id: "abcdef0123",
          short_id: "abcdef01",
          time: "2026-11-04T02:00:00Z",
          paths: [`${pullRoot(uid)}/etc`, `${pullRoot(uid)}/srv/my data`],
        },
      ]),
    });
    const list = await s.request("GET", `/jobs/${res.body.id}/snapshots`);
    expect(list.body[0].paths).toEqual(["/etc", "/srv/my data"]);
  });

  it("restores onto the source host through Termix", async () => {
    const { s, res } = await relayJob();
    s.ssh.replies.unshift({
      match: "restic snapshots",
      stdout: `[{"id":"abcdef0123456789","time":"2026-11-04T02:00:00Z"}]`,
    });
    const { connect, execs } = fakeConnect({
      2: send([tarBytes()]),
      1: take(),
    });
    Object.assign(s.mock.ctx.ssh, { connect });
    const run = await s.request(
      "POST",
      `/jobs/${res.body.id}/snapshots/abcdef0123456789/restore`,
      { path: "/", includes: [], overwrite: "if-changed" },
    );
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ kind: "restore", hostId: 1 });
    await until(
      async () =>
        (await s.request("GET", `/runs/${run.body.id}`)).body.status ===
        "success",
    );
    expect(execs[0]!.hostId).toBe(2);
    expect(execs[0]!.input.toString()).toContain(
      "restic dump --no-lock --archive tar",
    );
    expect(execs[1]!.hostId).toBe(1);
    expect(execs[1]!.command).toContain("tar -x -f -");
    // Nothing was launched on a host: no restic is needed on the target.
    expect(s.ssh.calls.some((c) => c.stdin.includes("setsid bash"))).toBe(
      false,
    );
  });

  it("removes the copy from both hosts when the job is deleted", async () => {
    const { s, res } = await relayJob();
    s.ssh.calls.length = 0;
    const del = await s.request("DELETE", `/jobs/${res.body.id}`);
    expect(del.status).toBe(200);
    await until(() => s.ssh.calls.length === 2);
    expect(s.ssh.calls.map((c) => c.hostId).sort()).toEqual([1, 2]);
    expect(s.ssh.calls[0]!.stdin).toMatch(
      /rm -rf '\/var\/lib\/termix-backups\/pull\/[^']+'/,
    );
  });

  it("marks a run whose copy was cut off", () => {
    const polled = parsePoll(
      `${M}run=u1
${M}copying
${M}log
x
${M}end
`,
    );
    expect(polled[0]).toMatchObject({ uid: "u1", copying: true, alive: false });
  });
});
