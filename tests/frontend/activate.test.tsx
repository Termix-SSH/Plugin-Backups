import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import {
  formatBytes,
  formatDuration,
  partsOf,
  presetOf,
} from "../../src/frontend/format";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  root: true,
  os: "Debian",
  arch: "x86_64",
  packageManager: "apt-get",
  restic: "0.18.0",
  resticOk: true,
  rclone: null,
  docker: true,
  tools: { mysqldump: true, pgDump: true, sqlite3: true },
};

const job = {
  id: 1,
  hostId: 1,
  repositoryId: 1,
  repositoryName: "Offsite",
  repositoryKind: "s3",
  name: "Nightly",
  enabled: true,
  sources: [{ id: "a", kind: "paths", paths: ["/etc"], excludes: [] }],
  hooks: { pre: "", post: "" },
  cron: "0 2 * * *",
  timezone: "",
  keep: { last: 0, daily: 7, weekly: 0, monthly: 0, yearly: 0 },
  alerts: { onFailure: true, staleDays: 0 },
  oneFileSystem: false,
  lastStatus: "failed",
  lastRunAt: "2026-11-01T02:00:00Z",
  lastSuccessAt: null,
  nextRunAt: null,
  lastSnapshotId: null,
  lastBytes: null,
  runningRunId: null,
  canEditRepo: true,
};

const repo = {
  id: 1,
  name: "Offsite",
  kind: "s3",
  location: { bucket: "b" },
  hasSecret: true,
  jobs: 1,
  createdAt: "",
  updatedAt: "",
};

function api(currentStatus: unknown = status, jobs: unknown[] = [job]) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? currentStatus
        : url.endsWith("/jobs")
          ? jobs
          : url.endsWith("/repositories")
            ? [repo]
            : url.endsWith("/database-logins")
              ? { available: false, logins: [] }
              : url.startsWith("/runs")
                ? { runs: [], next: null }
                : url.endsWith("/snapshots")
                  ? []
                  : {},
    })),
    post: vi.fn(async () => ({ data: { id: 5, version: "0.19.1" } })),
  } as never;
}

const host = { id: 1, name: "web", enableSsh: true };

describe(`${manifest.id} activate`, () => {
  it("registers both tabs and the card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs().sort()).toEqual([
      "backups",
      "backups-host",
    ]);
  });

  it("shows the jobs of a host", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales, api: api() });
    rendered.renderTab("backups-host", { isVisible: true, host });
    expect(await screen.findByText("Nightly")).toBeTruthy();
    expect(screen.getByText(locales.status.failed)).toBeTruthy();
    expect(screen.getByText("Daily at 02:00")).toBeTruthy();
  });

  it("offers the install when restic is missing", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, restic: null, resticOk: false }, []),
    });
    rendered.renderTab("backups-host", { isVisible: true, host });
    expect(await screen.findByText(locales.install.missing)).toBeTruthy();
    expect(screen.getByText(locales.install.button)).toBeTruthy();
  });

  it("opens the editor from Add job", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales, api: api() });
    rendered.renderTab("backups-host", { isVisible: true, host });
    await screen.findByText("Nightly");
    fireEvent.click(screen.getByText(locales.jobs.add));
    expect(await screen.findByText(locales.editor.newTitle)).toBeTruthy();
    expect(screen.getByText(locales.sources.paths)).toBeTruthy();
    expect(screen.getByText(locales.keep.title)).toBeTruthy();
  });

  it("lists repositories in the Backups tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales, api: api() });
    rendered.renderTab("backups", { isVisible: true });
    fireEvent.click(await screen.findByText(locales.tab.viewRepos));
    expect(await screen.findByText(locales.repos.kinds.s3)).toBeTruthy();
  });
});

describe("format", () => {
  it("formats sizes and times", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(null)).toBe("");
    expect(formatDuration(3700)).toBe("1h 1m");
    expect(formatDuration(65)).toBe("1m 5s");
  });

  it("reads presets from cron", () => {
    expect(presetOf("")).toBe("manual");
    expect(presetOf("0 2 * * *")).toBe("daily");
    expect(presetOf("30 4 * * 1")).toBe("weekly");
    expect(presetOf("*/5 * * * *")).toBe("custom");
    expect(partsOf("30 4 * * 1")).toEqual({ hour: 4, minute: 30, weekday: 1 });
  });
});

describe("locales", () => {
  it("has every key the manifest names", () => {
    const text = JSON.stringify(manifestJson);
    for (const [, key] of text.matchAll(
      /"(?:titleKey|descriptionKey)":"([^"]+)"/g,
    )) {
      const value = key!
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown>)?.[part],
          locales,
        );
      expect(typeof value, key).toBe("string");
    }
  });
});
