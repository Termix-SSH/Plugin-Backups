import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseRcloneConfig,
  exportLines,
  repoEnv,
  repoString,
} from "../../src/backend/repo-env.js";
import {
  DOCKER_SCRIPT,
  INSTALL_RCLONE_SCRIPT,
  INSTALL_SCRIPT,
  STATUS_SCRIPT,
  backupRunScript,
  cancelScript,
  dumpScript,
  forgetSnapshotScript,
  launchScript,
  lsScript,
  pollScript,
  restoreRunScript,
  snapshotsScript,
  testRepoScript,
  type BackupPlan,
} from "../../src/backend/scripts.js";
import { EMPTY_KEEP } from "../../src/shared/types.js";

const hasBash = spawnSync("bash", ["--version"]).status === 0;

const ENV = repoEnv(
  "s3",
  { bucket: "b", accessKeyId: "AKID", region: "eu-1" },
  { password: "pw", secret: "topsecret" },
);

const PLAN: BackupPlan = {
  uid: "run-1",
  jobUid: "job-1",
  paths: ["/etc"],
  excludes: ["*.tmp"],
  dumps: [
    {
      file: "1-mysql-shop",
      engine: "mysql",
      address: "db.local",
      port: 3306,
      username: "o'brien",
      passwordEnv: "TERMIX_DB_1",
      runAs: "",
      databases: ["shop"],
    },
    {
      file: "2-postgres-all",
      engine: "postgres",
      address: "",
      port: null,
      username: "",
      passwordEnv: null,
      runAs: "postgres",
      databases: [],
    },
    {
      file: "3-postgres-app",
      engine: "postgres",
      address: "",
      port: 5432,
      username: "app",
      passwordEnv: "TERMIX_DB_3",
      runAs: "",
      databases: ["app one"],
    },
    {
      file: "4-sqlite-a",
      engine: "sqlite",
      address: "",
      port: null,
      username: "",
      passwordEnv: null,
      runAs: "",
      databases: ["/srv/my app/a.db"],
    },
  ],
  stopStacks: ["web"],
  oneFileSystem: true,
  keep: { ...EMPTY_KEEP, daily: 7 },
  pre: "echo hi",
  post: "",
};

describe.skipIf(!hasBash)("generated scripts", () => {
  const scripts: Record<string, string> = {
    status: STATUS_SCRIPT,
    install: INSTALL_SCRIPT,
    rclone: INSTALL_RCLONE_SCRIPT,
    docker: DOCKER_SCRIPT,
    backup: backupRunScript(PLAN),
    noDumps: backupRunScript({
      ...PLAN,
      dumps: [],
      stopStacks: [],
      keep: EMPTY_KEEP,
    }),
    restore: restoreRunScript({
      uid: "r",
      snapshot: "abcd1234",
      target: "/tmp/a b",
      includes: ["/etc"],
      overwrite: "never",
    }),
    launch: launchScript("r", { "run.sh": "echo", paths: "/etc\n" }, ENV),
    poll: pollScript(["a", "b"]),
    cancel: cancelScript("a"),
    snapshots: snapshotsScript(ENV, "termix-job:x"),
    ls: lsScript(ENV, "abcd1234", "/it's"),
    dump: dumpScript(ENV, "abcd1234", "/a b", true),
    forget: forgetSnapshotScript(ENV, "abcd1234"),
    test: testRepoScript(ENV, true),
  };
  for (const [name, script] of Object.entries(scripts)) {
    it(`${name} is valid bash`, () => {
      const run = spawnSync("bash", ["-n"], {
        input: script,
        encoding: "utf8",
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    });
  }
});

describe("backup script", () => {
  const script = backupRunScript(PLAN);

  it("holds no secret, only env names", () => {
    expect(script).toContain('export MYSQL_PWD="${TERMIX_DB_1:-}"');
    expect(script).not.toContain("topsecret");
  });

  it("quotes names", () => {
    expect(script).toContain(`-u 'o'\\''brien'`);
    expect(script).toContain(`-d 'app one'`);
  });

  it("dumps all databases when none are named", () => {
    expect(script).toContain("as_user 'postgres' pg_dumpall");
  });

  it("uses a staging folder per job, so restic finds its parent", () => {
    expect(script).toContain("/var/lib/termix-backups/staging/job-1/databases");
    expect(script).not.toContain("staging/run-1");
  });

  it("tags the backup and limits forget to the job", () => {
    expect(script).toContain("--tag 'termix-job:job-1'");
    expect(script).toContain(
      "restic forget --tag 'termix-job:job-1' --group-by '' --keep-daily 7 --prune",
    );
    expect(script).toContain("--one-file-system");
    expect(script).toContain('--exclude-file "$D/excludes"');
  });

  it("warns about a missing path and names a wrong password", () => {
    expect(script).toContain("does not exist, skipping");
    expect(script).toContain("The repository password is wrong");
  });

  it("skips forget with no keep policy", () => {
    expect(backupRunScript({ ...PLAN, keep: EMPTY_KEEP })).not.toContain(
      "restic forget",
    );
  });

  it("starts stopped stacks again in the exit trap", () => {
    expect(script).toContain('docker compose -p "$s" start $services');
    expect(script).toContain('ps --services --status running > "$D/stack-web"');
    expect(script).toContain('STOPPED="$STOPPED web"');
  });
});

describe("restic pin", () => {
  it("checks the download against a pinned sum for each arch", () => {
    expect(INSTALL_SCRIPT).toContain("sha256sum -c");
    expect(INSTALL_SCRIPT.match(/sha=[a-f0-9]{64}/g)).toHaveLength(4);
  });
});

describe("repository env", () => {
  it("builds repo strings with no secrets", () => {
    expect(repoString("s3", { bucket: "b", prefix: "p" })).toBe(
      "s3:https://s3.amazonaws.com/b/p",
    );
    expect(
      repoString("s3", { endpoint: "http://minio:9000/", bucket: "b" }),
    ).toBe("s3:http://minio:9000/b");
    expect(repoString("rest", { url: "https://r:8000/x" })).toBe(
      "rest:https://r:8000/x/",
    );
    expect(repoString("rclone", { remote: "gd", path: "a/b" })).toBe(
      "rclone:gd:a/b",
    );
    expect(repoString("local", { path: "/mnt/r" })).toBe("/mnt/r");
  });

  it("puts rest logins in env only", () => {
    const env = repoEnv(
      "rest",
      { url: "https://r", username: "u" },
      { password: "p", secret: "s" },
    );
    expect(env.RESTIC_REPOSITORY).toBe("rest:https://r/");
    expect(env).toMatchObject({
      RESTIC_REST_USERNAME: "u",
      RESTIC_REST_PASSWORD: "s",
    });
  });

  it("turns an rclone section into env values", () => {
    const env = repoEnv(
      "rclone",
      { remote: "gd", path: "x" },
      {
        password: "p",
        secret: '[gd]\n# note\ntype = drive\ntoken = {"a": "b=c"}\n',
      },
    );
    expect(env.RCLONE_CONFIG_GD_TYPE).toBe("drive");
    expect(env.RCLONE_CONFIG_GD_TOKEN).toBe('{"a": "b=c"}');
  });

  it("refuses rclone config with no type", () => {
    expect(() => parseRcloneConfig("key = value")).toThrow("type");
    expect(() => parseRcloneConfig("nonsense")).toThrow("not valid");
  });

  it("exports values as base64 so nothing is parsed by the shell", () => {
    const lines = exportLines({ RESTIC_PASSWORD: `a'b$(rm -rf /)"` });
    expect(lines).not.toContain("rm -rf");
    expect(lines).toContain("base64 -d");
    expect(() => exportLines({ "BAD NAME": "x" })).toThrow();
  });

  it("never puts a secret in a launch script in plain text", () => {
    const script = launchScript("r", { "run.sh": "echo" }, ENV);
    expect(script).not.toContain("topsecret");
    expect(script).toContain("setsid bash");
  });
});
