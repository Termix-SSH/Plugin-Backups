import { describe, expect, it } from "vitest";
import { trimEnd, trimStart } from "../../src/backend/trim.js";
import { repository } from "../../src/backend/validate.js";

// Long runs of slashes used to take quadratic time to trim.
const slashes = "/".repeat(200_000);

function elapsed(fn: () => unknown): number {
  const start = performance.now();
  try {
    fn();
  } catch {
    // only the time matters here
  }
  return performance.now() - start;
}

describe("trimming long values", () => {
  it("trims like the old patterns did", () => {
    expect(trimEnd("a/b//")).toBe("a/b");
    expect(trimStart("//a/b")).toBe("a/b");
    expect(trimStart(trimEnd("///"))).toBe("");
  });

  it("checks a repository with long slash runs quickly", () => {
    const s3 = (location: Record<string, string>) => () =>
      repository({
        name: "Main",
        kind: "s3",
        location: {
          bucket: "my-bucket",
          region: "us-east-1",
          accessKeyId: "AKIAEXAMPLE",
          ...location,
        },
      });
    expect(elapsed(s3({ prefix: `a${slashes}b` }))).toBeLessThan(500);
    expect(
      elapsed(s3({ endpoint: `https://s3.example.com${slashes}x` })),
    ).toBeLessThan(500);
    expect(s3({ prefix: "/backups/" })().location).toMatchObject({
      prefix: "backups",
    });
  });
});
