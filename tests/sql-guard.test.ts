import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_LIMIT,
  guardReadOnlySql,
  MAX_QUERY_CTES,
  MAX_QUERY_SELECT_BLOCKS,
} from "../src/lib/sql-guard";

describe("guardReadOnlySql", () => {
  it("allows a business SELECT and applies the default limit", () => {
    const guarded = guardReadOnlySql("SELECT vessel_name, status FROM cargoes ORDER BY eta");
    expect(guarded.tables).toEqual(["cargoes"]);
    expect(guarded.limit).toBe(DEFAULT_QUERY_LIMIT);
    expect(guarded.executedSql).toContain("LIMIT 500");
  });

  it("preserves a smaller requested row limit and caps a larger one", () => {
    expect(guardReadOnlySql("SELECT vessel_name FROM cargoes LIMIT 7").limit).toBe(7);
    expect(guardReadOnlySql("SELECT vessel_name FROM cargoes LIMIT 99999").limit).toBe(500);
  });

  it("allows aggregate stars but rejects wildcard projections", () => {
    expect(() => guardReadOnlySql("SELECT COUNT(*) AS cargo_count FROM cargoes")).not.toThrow();
    expect(() => guardReadOnlySql("SELECT * FROM cargoes")).toThrow(/Wildcard/);
    expect(() => guardReadOnlySql("SELECT c.* FROM cargoes c")).toThrow(/Wildcard/);
  });

  it("rejects writes, multiple statements, metadata, and dangerous functions", () => {
    expect(() => guardReadOnlySql("DELETE FROM cargoes")).toThrow(/SELECT/);
    expect(() => guardReadOnlySql("SELECT vessel_name FROM cargoes; SELECT name FROM suppliers")).toThrow(/one SELECT/);
    expect(() => guardReadOnlySql("SELECT name FROM sqlite_master")).toThrow(/Table access/);
    expect(() => guardReadOnlySql("SELECT load_extension('module')")).toThrow(/Function/);
    expect(() => guardReadOnlySql("SELECT randomblob(1000000) AS payload FROM cargoes")).toThrow(/Function/);
    expect(() => guardReadOnlySql("SELECT printf('%50000000s', 'x') AS payload FROM cargoes")).toThrow(/Function/);
    expect(() => guardReadOnlySql("SELECT replace(vessel_name, 'a', printf('%1000000s', 'x')) AS payload FROM cargoes")).toThrow(/Function/);
    expect(() => guardReadOnlySql(
      "WITH sqlite_master AS (SELECT name FROM main.sqlite_master) SELECT name FROM sqlite_master",
    )).toThrow(/Table access/);
  });

  it("allows CTEs backed only by public business tables", () => {
    const guarded = guardReadOnlySql("WITH delayed AS (SELECT vessel_name FROM cargoes WHERE status = 'delayed') SELECT vessel_name FROM delayed");
    expect(guarded.tables).toEqual(["cargoes"]);
  });

  it("rejects recursive CTEs even when SQLite omits the RECURSIVE keyword", () => {
    expect(() => guardReadOnlySql(
      "WITH n(id) AS (SELECT id FROM cargoes UNION ALL SELECT id + 1 FROM n WHERE id < 20) SELECT id FROM n",
    )).toThrow(/Recursive CTE/);
  });

  it("rejects CTE chains that exponentially grow strings", () => {
    const doublingCtes = Array.from({ length: 6 }, (_, index) => {
      const source = index === 0 ? "seed" : `doubled_${index}`;
      return `doubled_${index + 1} AS (SELECT payload || payload AS payload FROM ${source})`;
    });
    const sql = `WITH ${[
      "seed AS (SELECT vessel_name AS payload FROM cargoes)",
      ...doublingCtes,
    ].join(", ")} SELECT payload FROM doubled_6`;

    expect(() => guardReadOnlySql(sql)).toThrow(/String concatenation/);
  });

  it("caps CTE and SELECT-block complexity while keeping ordinary CTEs available", () => {
    const ctes = Array.from({ length: MAX_QUERY_CTES + 1 }, (_, index) => {
      const source = index === 0 ? "cargoes" : `cte_${index - 1}`;
      return `cte_${index} AS (SELECT vessel_name FROM ${source})`;
    });
    expect(() => guardReadOnlySql(
      `WITH ${ctes.join(", ")} SELECT vessel_name FROM cte_${MAX_QUERY_CTES}`,
    )).toThrow(/too many CTEs/);

    let nested = "SELECT vessel_name FROM cargoes";
    for (let index = 1; index < MAX_QUERY_SELECT_BLOCKS + 1; index += 1) {
      nested = `SELECT vessel_name FROM (${nested}) nested_${index}`;
    }
    expect(() => guardReadOnlySql(nested)).toThrow(/too many SELECT blocks/);

    expect(() => guardReadOnlySql(
      "WITH delayed AS (SELECT vessel_name FROM cargoes WHERE status = 'delayed') SELECT vessel_name FROM delayed",
    )).not.toThrow();
  });

  it("allows validated derived-table outputs but rejects unknown derived columns", () => {
    expect(() => guardReadOnlySql(
      "SELECT x.ship FROM (SELECT vessel_name AS ship FROM cargoes) x",
    )).not.toThrow();
    expect(() => guardReadOnlySql(
      "SELECT x.secret FROM (SELECT vessel_name AS ship FROM cargoes) x",
    )).toThrow(/Column access/);
  });

  it("validates every branch of set operations", () => {
    expect(() => guardReadOnlySql(
      "SELECT x.vessel_name FROM (SELECT vessel_name FROM cargoes UNION SELECT rowid AS vessel_name FROM suppliers) x",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT vessel_name FROM cargoes UNION SELECT password_hash AS vessel_name FROM suppliers",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT vessel_name FROM cargoes UNION SELECT email AS vessel_name FROM suppliers",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT vessel_name FROM cargoes UNION SELECT name AS vessel_name FROM suppliers",
    )).not.toThrow();
  });

  it("rejects recursive CTEs and unknown business columns", () => {
    expect(() => guardReadOnlySql(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 10) SELECT x FROM n",
    )).toThrow(/Recursive CTE/);
    expect(() => guardReadOnlySql("SELECT password_hash FROM suppliers")).toThrow(/Column access/);
    expect(() => guardReadOnlySql("SELECT c.password_hash FROM cargoes c")).toThrow(/Column access/);
    expect(() => guardReadOnlySql("SELECT password_hash AS password_hash FROM suppliers")).toThrow(/Column access/);
    expect(() => guardReadOnlySql("SELECT secret AS secret FROM cargoes")).toThrow(/Column access/);
    expect(() => guardReadOnlySql("SELECT vessel_name FROM cargoes WHERE secret = 1")).toThrow(/Column access/);
    expect(() => guardReadOnlySql("SELECT vessel_name FROM suppliers")).toThrow(/Column access/);
  });

  it("rejects table-valued functions that bypass the table allowlist", () => {
    expect(() => guardReadOnlySql(
      "SELECT name AS name, type AS type FROM pragma_table_info('sqlite_master')",
    )).toThrow(/Table-valued functions/);
  });

  it("preserves validated LIMIT offsets in both SQLite syntaxes", () => {
    const keyword = guardReadOnlySql("SELECT vessel_name FROM cargoes LIMIT 3 OFFSET 5");
    const comma = guardReadOnlySql("SELECT vessel_name FROM cargoes LIMIT 5, 3");
    expect(keyword.limit).toBe(3);
    expect(keyword.executedSql).toMatch(/LIMIT 3 OFFSET 5/i);
    expect(comma.limit).toBe(3);
    expect(comma.executedSql).toMatch(/LIMIT 3 OFFSET 5/i);
  });

  it("allows known columns, aliases, joins, and aggregate output aliases", () => {
    expect(() => guardReadOnlySql(
      "SELECT c.vessel_name AS ship, cs.coal_type FROM cargoes c JOIN coal_specs cs ON cs.id = c.coal_spec_id ORDER BY ship",
    )).not.toThrow();
    expect(() => guardReadOnlySql(
      "SELECT status, COUNT(*) AS cargo_count FROM cargoes GROUP BY status ORDER BY cargo_count",
    )).not.toThrow();
    expect(() => guardReadOnlySql(
      "SELECT status AS state, COUNT(*) AS cargo_count FROM cargoes GROUP BY status HAVING COUNT(*) > 1 ORDER BY cargo_count",
    )).not.toThrow();
  });

  it("does not treat colliding GROUP BY or HAVING names as projection aliases", () => {
    expect(() => guardReadOnlySql(
      "SELECT 1 AS rowid, COUNT(*) AS grouped FROM suppliers GROUP BY rowid ORDER BY grouped",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT 1 AS password_hash, COUNT(*) AS grouped FROM suppliers GROUP BY id HAVING password_hash IS NOT NULL",
    )).toThrow(/Column access/);
  });

  it("validates JOIN ON and USING columns", () => {
    expect(() => guardReadOnlySql(
      "SELECT c.vessel_name FROM cargoes c JOIN suppliers s ON s.rowid = c.id",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT c.vessel_name FROM cargoes c JOIN suppliers s ON s.password_hash = c.vessel_name",
    )).toThrow(/Column access/);
    expect(() => guardReadOnlySql(
      "SELECT c.vessel_name FROM cargoes c JOIN suppliers s USING (id)",
    )).not.toThrow();
    expect(() => guardReadOnlySql(
      "SELECT c.vessel_name FROM cargoes c JOIN suppliers s USING (password_hash)",
    )).toThrow(/Column access/);
  });
});
