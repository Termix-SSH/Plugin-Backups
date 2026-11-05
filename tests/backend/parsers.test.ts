import { describe, expect, it } from "vitest";
import {
  parseDocker,
  parseErrors,
  parseLs,
  parsePoll,
  parseProgress,
  parseSnapshots,
  parseSummary,
} from "../../src/backend/restic-json.js";
import { pollOutput } from "./helpers";

const SUMMARY = JSON.stringify({
  message_type: "summary",
  files_new: 2,
  files_changed: 1,
  files_unmodified: 5,
  data_added: 1024,
  total_files_processed: 8,
  total_bytes_processed: 4096,
  total_duration: 3.5,
  snapshot_id: "abcdef0123456789",
});

describe("restic output", () => {
  it("reads a backup status line", () => {
    const progress = parseProgress(
      JSON.stringify({
        message_type: "status",
        percent_done: 0.5,
        total_files: 10,
        files_done: 5,
        total_bytes: 100,
        bytes_done: 50,
        seconds_elapsed: 2,
        seconds_remaining: 2,
        current_files: ["/a", "/b", "/c"],
      }),
    );
    expect(progress).toMatchObject({
      percent: 0.5,
      filesDone: 5,
      secondsRemaining: 2,
    });
    expect(progress?.current).toEqual(["/a", "/b"]);
  });

  it("reads a restore status line", () => {
    expect(
      parseProgress(
        '{"message_type":"status","percent_done":1,"total_files":3,"files_restored":3,"total_bytes":9,"bytes_restored":9}',
      ),
    ).toMatchObject({ filesDone: 3, bytesDone: 9, secondsRemaining: null });
  });

  it("ignores lines that are not its kind", () => {
    expect(parseProgress("not json")).toBeNull();
    expect(parseProgress(SUMMARY)).toBeNull();
    expect(parseSummary('{"message_type":"status"}')).toBeNull();
  });

  it("reads a summary and its snapshot", () => {
    expect(parseSummary(SUMMARY)).toMatchObject({
      snapshotId: "abcdef0123456789",
      summary: { filesNew: 2, dataAdded: 1024, totalFiles: 8, seconds: 3.5 },
    });
  });

  it("turns error lines into text", () => {
    expect(
      parseErrors(
        '{"message_type":"error","error":{"message":"denied"},"during":"archival","item":"/x"}\nnope',
      ),
    ).toEqual(["/x: denied"]);
  });

  it("sorts snapshots newest first", () => {
    const list = parseSnapshots(
      JSON.stringify([
        {
          id: "a".repeat(64),
          short_id: "aaaaaaaa",
          time: "2026-01-01T00:00:00Z",
          paths: ["/a"],
        },
        {
          id: "b".repeat(64),
          time: "2026-02-01T00:00:00Z",
          summary: { total_bytes_processed: 5, total_files_processed: 2 },
        },
      ]),
    );
    expect(list.map((s) => s.shortId)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
    expect(list[0]).toMatchObject({ bytes: 5, files: 2 });
    expect(list[1]!.bytes).toBeNull();
  });

  it("lists only direct children, folders first", () => {
    const lines = [
      '{"struct_type":"snapshot","id":"x"}',
      '{"struct_type":"node","name":"etc","type":"dir","path":"/etc"}',
      '{"struct_type":"node","name":"b.txt","type":"file","path":"/etc/b.txt","size":3}',
      '{"struct_type":"node","name":"sub","type":"dir","path":"/etc/sub"}',
      '{"struct_type":"node","name":"deep","type":"file","path":"/etc/sub/deep"}',
    ].join("\n");
    expect(parseLs(lines, "/etc").map((e) => e.name)).toEqual(["sub", "b.txt"]);
    expect(parseLs(lines, "/").map((e) => e.name)).toEqual(["etc"]);
  });
});

describe("poll output", () => {
  it("splits runs and reads each", () => {
    const out =
      pollOutput("one", {
        alive: true,
        progress: '{"message_type":"status","percent_done":0.25}',
      }).replace("@@termix:end", "") +
      pollOutput("two", {
        result: "status=warning\ncode=3\nmessage=Some files could not be read",
        summary: SUMMARY,
        log: "line 1\nline 2",
      });
    const [one, two] = parsePoll(out);
    expect(one).toMatchObject({ uid: "one", alive: true, result: null });
    expect(one!.progress?.percent).toBe(0.25);
    expect(two).toMatchObject({
      uid: "two",
      alive: false,
      snapshotId: "abcdef0123456789",
      result: {
        status: "warning",
        code: 3,
        message: "Some files could not be read",
      },
      log: "line 1\nline 2",
    });
  });

  it("marks a run whose folder is gone", () => {
    const [run] = parsePoll("@@termix:run=x\n@@termix:missing\n@@termix:end\n");
    expect(run).toMatchObject({ uid: "x", missing: true });
  });

  it("treats an unknown result as failed", () => {
    const [run] = parsePoll(pollOutput("x", { result: "status=odd\ncode=1" }));
    expect(run!.result?.status).toBe("failed");
  });
});

describe("docker inventory", () => {
  it("reads volumes and stacks", () => {
    const out = [
      "@@termix:volumes",
      "web_data|/var/lib/docker/volumes/web_data/_data|web",
      "loose|/var/lib/docker/volumes/loose/_data|<no value>",
      "@@termix:stacks",
      '[{"Name":"web","Status":"running(2)","ConfigFiles":"/opt/stacks/web/compose.yaml"}]',
    ].join("\n");
    const { docker, volumes, inventory } = parseDocker(out);
    expect(docker).toBe(true);
    expect(volumes[0]).toMatchObject({ name: "web_data", project: "web" });
    expect(volumes[1]!.project).toBe("");
    expect(inventory.stacks).toEqual([
      { name: "web", status: expect.any(String), dir: "/opt/stacks/web" },
    ]);
  });

  it("notices no docker", () => {
    expect(parseDocker("@@termix:nodocker\n").docker).toBe(false);
  });
});
