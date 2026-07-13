import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chdir, cwd } from "process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryPublicDb } from "../src/lib/db";
import { createQueryAuditEvent, readQueryAuditEvents } from "../src/lib/query-audit";
import { QueryExecutionError, QuerySemaphore } from "../src/lib/query-executor";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-query-test-"));
  process.env.COFORGE_QUERY_AUDIT_PATH = join(tempDir, "query-audit.jsonl");
});

afterEach(async () => {
  delete process.env.COFORGE_QUERY_AUDIT_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe("queryPublicDb", () => {
  it("executes aggregate queries without changing SQLite's process-wide heap limit", async () => {
    const result = await queryPublicDb("SELECT COUNT(*) AS cargo_count FROM cargoes", { source: "api" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ cargo_count: 48 }]);
  });

  it("resolves the native database module in the host when cwd is isolated", async () => {
    const originalCwd = cwd();
    const originalDbPath = process.env.DB_PATH;
    try {
      process.env.DB_PATH = join(originalCwd, "data", "coal-demo.db");
      chdir(tempDir);
      const result = await queryPublicDb("SELECT name FROM suppliers ORDER BY id LIMIT 1", {
        source: "agent",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.rows).toHaveLength(1);
    } finally {
      chdir(originalCwd);
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
    }
  });

  it("returns one success envelope and appends only redacted audit metadata", async () => {
    const secret = "private-vessel-filter";
    const result = await queryPublicDb(
      `SELECT vessel_name, status FROM cargoes WHERE vessel_name = '${secret}' LIMIT 2`,
      { source: "api" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.error).toBeNull();
    expect(result.meta.source).toBe("api");
    expect(result.meta.rowCount).toBe(result.rows.length);
    expect(result.meta.responseBytes).toBeGreaterThan(0);
    expect(result.meta.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.meta.auditEventId).toMatch(/^[a-f0-9-]{36}$/);

    const rawAudit = await readFile(process.env.COFORGE_QUERY_AUDIT_PATH!, "utf8");
    expect(rawAudit).not.toContain(secret);
    expect(rawAudit).not.toContain("SELECT");
    const events = await readQueryAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "api", outcome: "success", tables: ["cargoes"] });
    expect(events[0].eventId).toBe(result.meta.auditEventId);
    expect(events[0].resultHash).toBe(result.meta.resultHash);
    expect(events[0].sqlHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the same failure envelope and audit trail for rejected SQL", async () => {
    const result = await queryPublicDb("SELECT name FROM sqlite_master", { source: "agent" });

    expect(result).toMatchObject({
      ok: false,
      rows: [],
      error: { code: "QUERY_REJECTED" },
      executedSql: null,
      meta: { source: "agent" },
    });
    const events = await readQueryAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "rejected", errorCode: "QUERY_REJECTED" });
  });

  it("does not let a CTE name hide a schema-qualified system table", async () => {
    const result = await queryPublicDb(
      "WITH sqlite_master AS (SELECT name FROM main.sqlite_master) SELECT name FROM sqlite_master",
      { source: "api" },
    );
    expect(result).toMatchObject({ ok: false, rows: [], error: { code: "QUERY_REJECTED" } });
  });

  it("rejects hidden columns reached through GROUP BY alias collisions", async () => {
    const result = await queryPublicDb(
      "SELECT 1 AS rowid, COUNT(*) AS grouped FROM suppliers GROUP BY rowid ORDER BY grouped",
      { source: "api" },
    );
    expect(result).toMatchObject({ ok: false, rows: [], error: { code: "QUERY_REJECTED" } });
  });

  it("rejects hidden columns in every UNION branch before execution", async () => {
    const result = await queryPublicDb(
      "SELECT x.vessel_name FROM (SELECT vessel_name FROM cargoes UNION SELECT rowid AS vessel_name FROM suppliers) x",
      { source: "api" },
    );

    expect(result).toMatchObject({
      ok: false,
      rows: [],
      error: { code: "QUERY_REJECTED" },
      executedSql: null,
    });
  });

  it("rejects hidden columns used as JOIN predicates before execution", async () => {
    const result = await queryPublicDb(
      "SELECT c.vessel_name FROM cargoes c JOIN suppliers s ON s.rowid = c.id",
      { source: "api" },
    );
    expect(result).toMatchObject({
      ok: false,
      rows: [],
      error: { code: "QUERY_REJECTED" },
      executedSql: null,
    });
  });

  it("enforces response byte and column limits inside the isolated process", async () => {
    const oversized = await queryPublicDb(
      "SELECT vessel_name, status FROM cargoes LIMIT 5",
      { source: "internal", maxResponseBytes: 8 },
    );
    expect(oversized).toMatchObject({ ok: false, error: { code: "QUERY_RESPONSE_LIMIT" } });

    const tooManyColumns = await queryPublicDb(
      "SELECT vessel_name, status FROM cargoes LIMIT 1",
      { source: "internal", maxColumns: 1 },
    );
    expect(tooManyColumns).toMatchObject({ ok: false, error: { code: "QUERY_COLUMN_LIMIT" } });

    const oversizedCell = await queryPublicDb(
      "SELECT vessel_name FROM cargoes LIMIT 1",
      { source: "internal", maxCellBytes: 1 },
    );
    expect(oversizedCell).toMatchObject({ ok: false, error: { code: "QUERY_CELL_LIMIT" } });
  });

  it("caps rows and reports the actual executed limit in the evidence envelope", async () => {
    const result = await queryPublicDb(
      "SELECT vessel_name FROM cargoes LIMIT 100",
      { source: "demo-cache", maxRows: 3 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(result.executedSql).toContain("LIMIT 3");
    expect(result.meta).toMatchObject({ source: "demo-cache", rowCount: 3, limit: 3, truncated: true });
  });

  it("preserves pagination offsets and does not mark LIMIT 0 as truncated", async () => {
    const firstPage = await queryPublicDb(
      "SELECT vessel_name FROM cargoes ORDER BY id LIMIT 3",
      { source: "internal" },
    );
    const secondPage = await queryPublicDb(
      "SELECT vessel_name FROM cargoes ORDER BY id LIMIT 3 OFFSET 3",
      { source: "internal" },
    );
    const empty = await queryPublicDb(
      "SELECT vessel_name FROM cargoes LIMIT 0",
      { source: "internal" },
    );

    expect(firstPage.ok && secondPage.ok).toBe(true);
    if (!firstPage.ok || !secondPage.ok || !empty.ok) return;
    expect(secondPage.executedSql).toMatch(/LIMIT 3 OFFSET 3/i);
    expect(secondPage.rows).not.toEqual(firstPage.rows);
    expect(empty.rows).toEqual([]);
    expect(empty.meta.truncated).toBe(false);
  });

  it("hard-kills a query process when its deadline expires", async () => {
    const result = await queryPublicDb(
      "SELECT COUNT(c1.id) AS total FROM cargoes c1, cargoes c2, cargoes c3, cargoes c4, cargoes c5",
      { source: "api", timeoutMs: 10 },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "QUERY_TIMEOUT" } });
    const events = await readQueryAuditEvents();
    expect(events.at(-1)).toMatchObject({ outcome: "timeout", errorCode: "QUERY_TIMEOUT" });
  });
});

describe("query concurrency gate", () => {
  it("limits active work and rejects an overflowing queue", async () => {
    const gate = new QuerySemaphore(1, 1);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = gate.execute(() => blocked);
    const second = gate.execute(async () => "queued");
    await expect(gate.execute(async () => "overflow")).rejects.toMatchObject({
      code: "QUERY_BUSY",
    } satisfies Partial<QueryExecutionError>);
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("queued");
  });

  it("removes queued work when its deadline expires", async () => {
    const gate = new QuerySemaphore(1, 2);
    let release!: () => void;
    let queuedRan = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = gate.execute(() => blocked);
    await expect(gate.execute(async () => {
      queuedRan = true;
    }, 5)).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queuedRan).toBe(false);
  });

  it("releases a slot when work throws synchronously", async () => {
    const gate = new QuerySemaphore(1, 1);
    await expect(gate.execute(() => { throw new Error("sync failure"); })).rejects.toThrow("sync failure");
    await expect(gate.execute(async () => "next")).resolves.toBe("next");
  });
});

describe("audit event immutability", () => {
  it("freezes the event and table list while retaining no raw SQL", () => {
    const event = createQueryAuditEvent({
      queryId: "query-1",
      source: "demo-cache",
      outcome: "failed",
      sql: "SELECT vessel_name FROM cargoes WHERE vessel_name = 'sensitive'",
      tables: ["cargoes"],
      durationMs: 4,
      errorCode: "QUERY_EXECUTION_ERROR",
    });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.tables)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("sensitive");
  });
});
