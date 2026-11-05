import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostAccess } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";

export const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = manifestJson as unknown as PluginManifest;

export interface Call {
  hostId: number;
  command: string;
  stdin: string;
}

export interface FakeSsh {
  calls: Call[];
  /** Replies by a piece of the script text. The first match wins. */
  replies: Array<{
    match: string;
    stdout?: string;
    stderr?: string;
    code?: number;
  }>;
}

export interface TestServer {
  mock: MockPluginContext;
  ssh: FakeSsh;
  request: (
    method: string,
    path: string,
    body?: unknown,
    // Route bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  setLevel: (next: PluginHostAccess["permissionLevel"] | "none") => void;
  setActor: (userId: string) => void;
  close: () => Promise<void>;
}

/** The plugin on a real express app and database, with ctx.ssh.exec played by a fake. */
export async function startServer(
  options: {
    permissions?: string[];
    level?: PluginHostAccess["permissionLevel"] | "none";
  } = {},
): Promise<TestServer> {
  let router: Router | null = null;
  const db = await createTestDb(pluginDir);
  db.sqlite.exec(
    "INSERT INTO users (id, username) VALUES ('user-1', 'user-1'), ('user-2', 'user-2')",
  );
  db.sqlite.exec("INSERT INTO ssh_data DEFAULT VALUES");
  db.sqlite.exec("INSERT INTO ssh_data DEFAULT VALUES");
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    actor: "user-1",
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["backups.use"],
  });

  const rank = { connect: 1, view: 2, edit: 3, manage: 4 } as const;
  let level = options.level ?? "manage";
  let actor = "user-1";
  Object.assign(mock.ctx, {
    currentActor: () => actor,
    asUser: async <T>(_id: string, fn: () => Promise<T> | T) => fn(),
  });
  Object.assign(mock.ctx.hosts, {
    checkAccess: async (
      _id: number,
      need: keyof typeof rank = "connect",
    ): Promise<PluginHostAccess> => ({
      hasAccess: level !== "none" && rank[level] >= rank[need],
      isOwner: true,
      isShared: false,
      permissionLevel: level === "none" ? undefined : level,
    }),
    list: async () =>
      level === "none"
        ? []
        : [
            { id: 1, name: "one" },
            { id: 2, name: "two" },
          ],
    get: async (id: number) => ({ id, name: `host ${id}`, ip: "10.0.0.1" }),
  });

  const ssh: FakeSsh = { calls: [], replies: [] };
  Object.assign(mock.ctx.ssh, {
    exec: async (
      hostId: number,
      command: string,
      opts?: { stdin?: string },
    ) => {
      const stdin = opts?.stdin ?? "";
      ssh.calls.push({ hostId, command, stdin });
      const reply = ssh.replies.find((r) => stdin.includes(r.match));
      return {
        stdout: reply?.stdout ?? "",
        stderr: reply?.stderr ?? "",
        code: reply?.code ?? 0,
        truncated: false,
        timedOut: false,
      };
    },
  });

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => router!(req, res, next));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    mock,
    ssh,
    setLevel(next) {
      level = next;
    },
    setActor(userId) {
      actor = userId;
    },
    async request(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

export const S3_REPO = {
  name: "Offsite",
  kind: "s3",
  location: {
    endpoint: "https://s3.example.com",
    bucket: "backups",
    prefix: "termix",
    region: "eu-1",
    accessKeyId: "AKIDEXAMPLE",
  },
  secret: "s3-very-secret",
  password: "repo-pass-1",
};

export const JOB = {
  name: "Nightly",
  repositoryId: 1,
  enabled: true,
  sources: [
    {
      id: "a1",
      kind: "paths",
      paths: ["/etc", "/srv/my data"],
      excludes: ["*.tmp"],
    },
  ],
  hooks: { pre: "echo before", post: "" },
  cron: "0 2 * * *",
  timezone: "",
  keep: { last: 0, daily: 7, weekly: 4, monthly: 0, yearly: 0 },
  alerts: { onFailure: true, staleDays: 3 },
  oneFileSystem: false,
};

/** Decodes every `printf %s '<base64>'` in a script. */
export function decoded(stdin: string): string[] {
  return [...stdin.matchAll(/printf %s '([A-Za-z0-9+/=]*)'/g)].map((m) =>
    Buffer.from(m[1]!, "base64").toString("utf8"),
  );
}

export function pollOutput(
  uid: string,
  parts: {
    alive?: boolean;
    result?: string;
    summary?: string;
    progress?: string;
    log?: string;
  },
): string {
  const M = "@@termix:";
  return [
    `${M}run=${uid}`,
    parts.alive ? `${M}alive` : "",
    parts.result ? `${M}result\n${parts.result}` : "",
    parts.progress ? `${M}progress\n${parts.progress}` : "",
    parts.summary ? `${M}summary\n${parts.summary}` : "",
    `${M}log\n${parts.log ?? "a log line"}`,
    `${M}end`,
  ]
    .filter(Boolean)
    .join("\n");
}
