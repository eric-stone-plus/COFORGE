import Database from "better-sqlite3";
import { copyFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardSummary, getAllModuleSummaries } from "../src/lib/co-modules";

let tempDir: string;
let db: Database.Database;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-dashboard-test-"));
  const dbPath = join(tempDir, "dashboard.db");
  await copyFile(join(process.cwd(), "data", "coal-demo.db"), dbPath);
  db = new Database(dbPath);
});

afterEach(async () => {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("dynamic dashboard snapshot", () => {
  it("reports source and freshness metadata rather than presenting a fixture as live data", () => {
    const snapshot = dashboardSummary(db, { now: new Date("2026-07-12T00:00:00Z") });

    expect(snapshot.source).toEqual({ kind: "synthetic-sqlite", label: "本地合成煤炭演示库" });
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.asOf).toBe("2026-04-01");
    expect(snapshot.stale).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.freshness.reason).toBeNull();
    expect(snapshot.freshness.datasets).toHaveLength(5);
    expect(snapshot.freshness.datasets.every((dataset) => dataset.status === "fresh")).toBe(true);
  });

  it("marks an old database stale instead of claiming a fresh snapshot", () => {
    db.prepare("UPDATE cargoes SET eta = '2024-01-01'").run();
    db.prepare("UPDATE price_indices SET index_date = '2024-01-01'").run();
    db.prepare("UPDATE freight_quotes SET quote_month = '2024-01'").run();
    db.prepare("UPDATE inventory SET arrival_month = '2024-01'").run();
    db.prepare("UPDATE contracts SET delivery_month = '2024-01'").run();

    const snapshot = dashboardSummary(db, { now: new Date("2026-07-12T00:00:00Z") });
    expect(snapshot.stale).toBe(true);
    expect(snapshot.asOf).toBe("2024-01-01");
    expect(snapshot.freshness.datasets.every((dataset) => dataset.status === "stale")).toBe(true);
    expect(snapshot.freshness.reason).toContain("已滞后");
  });

  it("marks missing and partially stale datasets explicitly", () => {
    db.prepare("DELETE FROM freight_quotes").run();
    db.prepare("UPDATE inventory SET arrival_month = '2025-01'").run();

    const snapshot = dashboardSummary(db, { now: new Date("2026-07-12T00:00:00Z") });
    const freight = snapshot.freshness.datasets.find((dataset) => dataset.id === "freight_quotes");
    const inventory = snapshot.freshness.datasets.find((dataset) => dataset.id === "inventory");
    expect(snapshot.stale).toBe(true);
    expect(snapshot.asOf).toBeNull();
    expect(freight).toMatchObject({ status: "missing", asOf: null, ageDays: null });
    expect(inventory?.status).toBe("stale");
    expect(snapshot.freshness.reason).toContain("航线运价无数据");
    expect(snapshot.freshness.reason).toContain("库存到货已滞后");
  });

  it("recomputes every KPI and chart from the current database state", () => {
    const before = dashboardSummary(db);
    const cargo = db.prepare("SELECT * FROM cargoes LIMIT 1").get() as Record<string, unknown>;
    const nextId = (db.prepare("SELECT MAX(id) AS id FROM cargoes").get() as { id: number }).id + 1;
    const insertedQuantity = 12_345;

    db.prepare(`
      INSERT INTO cargoes (
        id, supplier_id, coal_spec_id, load_port_id, discharge_port_id, vessel_name,
        laycan_start, laycan_end, eta, quantity_mt, price_usd_t, freight_usd_t,
        status, demurrage_days, quality_penalty_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nextId,
      cargo.supplier_id,
      cargo.coal_spec_id,
      cargo.load_port_id,
      cargo.discharge_port_id,
      "Synthetic Dashboard Probe",
      cargo.laycan_start,
      cargo.laycan_end,
      "2026-07-12",
      insertedQuantity,
      cargo.price_usd_t,
      cargo.freight_usd_t,
      "delayed",
      100,
      0,
    );

    const after = dashboardSummary(db);
    expect(after.kpis.cargoCount).toBe(before.kpis.cargoCount + 1);
    expect(after.kpis.cargoVolumeMt).toBe(before.kpis.cargoVolumeMt + insertedQuantity);
    expect(after.kpis.delayedCargoes).toBe(before.kpis.delayedCargoes + 1);
    expect(after.statuses).not.toEqual(before.statuses);
    expect(after.watchlist.some((row) => row.vessel === "Synthetic Dashboard Probe")).toBe(true);
  });

  it("declares the method, version, and assumptions for every demo summary", () => {
    for (const module of getAllModuleSummaries(db)) {
      expect(module.method).toBeTruthy();
      expect(module.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(module.assumptions.length).toBeGreaterThan(0);
    }
  });
});
