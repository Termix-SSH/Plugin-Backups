import { describe, expect, it } from "vitest";
import { source } from "../../src/backend/validate.js";

const db = (extra: Record<string, unknown>) => ({
  id: "s1",
  kind: "database",
  address: "",
  username: "",
  runAs: "",
  databases: [],
  ...extra,
});

describe("database sources", () => {
  it("take MongoDB, Redis and SQL Server", () => {
    expect(source(db({ engine: "mongo", databases: ["shop"] }))).toMatchObject({
      engine: "mongo",
      databases: ["shop"],
    });
    expect(
      source(db({ engine: "mssql", username: "sa", serverDir: "/srv/bak" })),
    ).toMatchObject({ engine: "mssql", serverDir: "/srv/bak" });
  });

  it("save Redis as a whole and drop database names", () => {
    expect(
      source(db({ engine: "redis", databases: ["0", "1"] })),
    ).toMatchObject({ engine: "redis", databases: [] });
  });

  it("refuse a relative SQL Server folder and unknown engines", () => {
    expect(() =>
      source(db({ engine: "mssql", serverDir: "backups" })),
    ).toThrow();
    expect(() => source(db({ engine: "oracle" }))).toThrow(
      "Pick a database engine",
    );
  });

  it("keep serverDir off other engines", () => {
    expect(
      source(db({ engine: "mongo", serverDir: "/srv/bak" })),
    ).not.toHaveProperty("serverDir");
  });
});
