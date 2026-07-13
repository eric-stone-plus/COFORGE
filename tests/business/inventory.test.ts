import { describe, expect, it } from "vitest";
import { MAX_DP_TRANSITIONS, optimizeRollingInventory } from "../../src/lib/business/inventory";

describe("CORICE rolling inventory", () => {
  it("carries inventory across periods, conserves mass, and chooses forward buying when economical", () => {
    const result = optimizeRollingInventory({
      initialInventoryMt: 20,
      initialInventoryCostUsdPerMt: 40,
      terminalMinInventoryMt: 10,
      stepMt: 10,
      defaultStorageCapacityMt: 100,
      periods: [
        { id: "p1", demandMt: 40, purchaseCostUsdPerMt: 50, maxPurchaseMt: 100, holdingCostUsdPerMt: 1 },
        { id: "p2", demandMt: 50, purchaseCostUsdPerMt: 80, maxPurchaseMt: 100, holdingCostUsdPerMt: 1 },
      ],
    });

    expect(result.status).toBe("optimal");
    if (result.status !== "optimal") throw new Error("Expected an optimal plan.");
    expect(result.plan.map((row) => row.purchaseMt)).toEqual([80, 0]);
    expect(result.plan.map((row) => row.endingInventoryMt)).toEqual([60, 10]);
    expect(result.plan.every((row) => row.balanceResidualMt === 0)).toBe(true);
    expect(result.costs).toMatchObject({
      purchaseCostUsd: 4_000,
      holdingCostUsd: 70,
      shortageCostUsd: 0,
      totalCostUsd: 4_070,
      endingInventoryBookValueUsd: 480,
      endingRollingAverageCostUsdPerMt: 48,
    });
  });

  it("reports infeasibility when supply cannot satisfy period demand", () => {
    const result = optimizeRollingInventory({
      initialInventoryMt: 0,
      stepMt: 10,
      defaultStorageCapacityMt: 100,
      periods: [{ id: "p1", demandMt: 100, purchaseCostUsdPerMt: 50, maxPurchaseMt: 50 }],
    });
    expect(result.status).toBe("infeasible");
    expect(result.infeasibilityReasons).toContain("NO_FEASIBLE_PERIOD_BALANCE");
  });

  it("uses explicit shortage penalties when shortages are allowed", () => {
    const result = optimizeRollingInventory({
      initialInventoryMt: 0,
      stepMt: 10,
      defaultStorageCapacityMt: 100,
      allowShortage: true,
      shortagePenaltyUsdPerMt: 100,
      periods: [{ id: "p1", demandMt: 100, purchaseCostUsdPerMt: 50, maxPurchaseMt: 50 }],
    });
    expect(result.status).toBe("optimal");
    if (result.status !== "optimal") throw new Error("Expected an optimal plan.");
    expect(result.plan[0]).toMatchObject({ purchaseMt: 50, fulfilledDemandMt: 50, shortageMt: 50 });
    expect(result.costs.shortageCostUsd).toBe(5_000);
  });

  it("discloses the opening-cost proxy and requires exact quantity steps", () => {
    const proxied = optimizeRollingInventory({
      initialInventoryMt: 10,
      stepMt: 10,
      defaultStorageCapacityMt: 100,
      periods: [{ id: "p", demandMt: 10, purchaseCostUsdPerMt: 1, maxPurchaseMt: 10 }],
    });
    expect(proxied.openingInventoryCostBasis).toEqual({
      costUsdPerMt: 1,
      source: "first-period-purchase-cost-proxy",
    });
    expect(() => optimizeRollingInventory({
      initialInventoryMt: 0,
      stepMt: 10,
      defaultStorageCapacityMt: 100,
      periods: [{ id: "p", demandMt: 15, purchaseCostUsdPerMt: 1, maxPurchaseMt: 10 }],
    })).toThrow("exact multiple");
  });

  it("enforces storage capacity on post-arrival peak inventory", () => {
    const result = optimizeRollingInventory({
      initialInventoryMt: 50,
      initialInventoryCostUsdPerMt: 40,
      stepMt: 10,
      defaultStorageCapacityMt: 50,
      periods: [{ id: "p", demandMt: 50, purchaseCostUsdPerMt: 1, minPurchaseMt: 10, maxPurchaseMt: 10 }],
    });
    expect(result.status).toBe("infeasible");
  });

  it("rejects dynamic-programming searches that are too costly for a synchronous request", () => {
    const periods = Array.from({ length: 120 }, (_, index) => ({
      id: `p-${index}`,
      demandMt: 0,
      purchaseCostUsdPerMt: 1,
      maxPurchaseMt: 128,
    }));
    expect(() => optimizeRollingInventory({
      initialInventoryMt: 0,
      stepMt: 1,
      defaultStorageCapacityMt: 128,
      periods,
    })).toThrow(`exceeds ${MAX_DP_TRANSITIONS} transitions`);
  });
});
