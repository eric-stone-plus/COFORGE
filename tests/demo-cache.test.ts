import { describe, expect, it } from "vitest";
import { CACHED_RESULTS } from "../src/lib/demo-cache";

describe("demo cache explanations", () => {
  it("does not reuse a positive conclusion when a query returns no rows", () => {
    for (const entry of Object.values(CACHED_RESULTS)) {
      expect(entry.renderExplanation([])).toContain("没有返回");
      expect(entry.renderExplanation([])).toContain("不沿用旧排名或静态数字");
    }
  });

  it("follows a reversed landed-cost comparison", () => {
    const explanation = CACHED_RESULTS["印尼 4200 和澳煤 5500 的到岸成本怎么比？"].renderExplanation([
      { coal_type: "Indonesian NAR4200", avg_landed_cost: 100 },
      { coal_type: "Australian NAR5500", avg_landed_cost: 60 },
    ]);

    expect(explanation).toContain("澳煤 5500比印尼 4200低 $40.00/吨");
    expect(explanation).not.toContain("澳煤高");
  });

  it("uses explicit aggregate fields rather than the displayed row count", () => {
    const inventory = CACHED_RESULTS["库存还能覆盖多少天？"].renderExplanation([
      { coal_type: "Synthetic A", stock_mt: 10, total_stock_mt: 320_000 },
    ]);
    const blends = CACHED_RESULTS["哪个配煤方案成本最低且硫灰可控？"].renderExplanation([
      {
        plan_name: "Synthetic plan",
        target_nar: 4500,
        blended_cost_usd_t: 70,
        sulfur_pct: 0.4,
        ash_pct: 9,
        matching_plans: 17,
      },
    ]);

    expect(inventory).toContain("320,000 吨");
    expect(inventory).toContain("20.0 天");
    expect(blends).toContain("17 个方案");
  });

  it("derives freight ranking and handles a tie from the returned rows", () => {
    const entry = CACHED_RESULTS["航线运价对比"];
    const ranked = entry.renderExplanation([
      { route_name: "Route A", avg_rate_usd_t: 11, avg_congestion_days: 1 },
      { route_name: "Route B", avg_rate_usd_t: 29, avg_congestion_days: 3 },
    ]);
    const tied = entry.renderExplanation([
      { route_name: "Route A", avg_rate_usd_t: 15, avg_congestion_days: 1 },
      { route_name: "Route B", avg_rate_usd_t: 15, avg_congestion_days: 2 },
    ]);

    expect(ranked).toContain("Route B 平均运价最高");
    expect(ranked).toContain("Route A 最低");
    expect(tied).toContain("平均运价持平");
  });
});
