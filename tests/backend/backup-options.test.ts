import { describe, expect, it } from "vitest";
import { backupOptionArgs, backupOptions } from "../../src/backend/validate.js";

describe("extra restic options", () => {
  it("keeps flags and their values, tidied", () => {
    expect(backupOptions("  --exclude-caches   --limit-upload 2048 ")).toBe(
      "--exclude-caches --limit-upload 2048",
    );
    expect(backupOptions(undefined)).toBe("");
    expect(backupOptionArgs("--a  -b c")).toEqual(["--a", "-b", "c"]);
  });

  it("refuses options Termix sets itself", () => {
    for (const text of [
      "--repo /tmp/x",
      "-r /tmp/x",
      "--password-command=id",
      "--exclude-caches --password-file /x",
      "--json",
      "--stdin-from-command",
    ]) {
      expect(() => backupOptions(text)).toThrow(/set by Termix/);
    }
  });

  it("refuses text that is not options", () => {
    expect(() => backupOptions("rm -rf /")).toThrow(/start with a dash/);
    expect(() => backupOptions("--a\n--b")).toThrow(/not valid/);
    expect(() => backupOptions(`--a ${"x".repeat(1000)}`)).toThrow(/not valid/);
  });
});
