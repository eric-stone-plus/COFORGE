import { describe, expect, it } from "vitest";
import { MAX_ENUMERATED_SOLUTIONS, optimizeCoalBlend } from "../../src/lib/business/blending";

const BASE = {
  sources: [
    { id: "low", availableMt: 100, costUsdPerMt: 50, narKcalPerKg: 4_000, sulfurPct: 1, ashPct: 15, totalMoisturePct: 20 },
    { id: "high", availableMt: 100, costUsdPerMt: 90, narKcalPerKg: 6_000, sulfurPct: 0.2, ashPct: 5, totalMoisturePct: 8 },
  ],
  requirements: {
    targetMt: 100,
    stepMt: 10,
    minNarKcalPerKg: 5_000,
    maxSulfurPct: 0.6,
    maxAshPct: 10,
    maxTotalMoisturePct: 14,
  },
};

describe("coal blending optimizer", () => {
  it("finds the globally cheapest discrete blend with exact mass and quality conservation", () => {
    const result = optimizeCoalBlend(BASE);
    const optimum = result.solutions[0];

    expect(result.status).toBe("optimal");
    expect(result.searchSpaceSize).toBe(11);
    expect(optimum.totalCostUsd).toBe(7_000);
    expect(optimum.unitCostUsdPerMt).toBe(70);
    expect(optimum.allocations.map((row) => row.quantityMt)).toEqual([50, 50]);
    expect(optimum.allocations.reduce((sum, row) => sum + row.quantityMt, 0)).toBe(100);
    expect(optimum.quality).toEqual({ narKcalPerKg: 5_000, sulfurPct: 0.6, ashPct: 10, totalMoisturePct: 14 });
    expect(Object.values(optimum.constraintMargins).every((margin) => margin >= 0)).toBe(true);
  });

  it("returns explicit unattainable-quality diagnostics", () => {
    const result = optimizeCoalBlend({
      ...BASE,
      requirements: { ...BASE.requirements, minNarKcalPerKg: 6_500 },
    });
    expect(result.status).toBe("infeasible");
    expect(result.solutions).toEqual([]);
    expect(result.infeasibilityReasons).toContain("HEAT_MINIMUM_UNATTAINABLE");
  });

  it("enforces discrete quantities and source share bounds", () => {
    expect(() => optimizeCoalBlend({
      ...BASE,
      sources: [{ ...BASE.sources[0], availableMt: 55 }, BASE.sources[1]],
    })).toThrow("exact multiple");
    const result = optimizeCoalBlend({
      ...BASE,
      sources: [{ ...BASE.sources[0], maxSharePct: 40 }, BASE.sources[1]],
    });
    expect(result.solutions[0].allocations[0].sharePct).toBeLessThanOrEqual(40);
  });

  it("rejects exhaustive search spaces that would monopolize the request process", () => {
    const sources = Array.from({ length: 5 }, (_, index) => ({
      id: `source-${index}`,
      availableMt: 66,
      costUsdPerMt: 50 + index,
      narKcalPerKg: 5_000,
      sulfurPct: 0.5,
      ashPct: 10,
      totalMoisturePct: 12,
    }));
    expect(() => optimizeCoalBlend({
      sources,
      requirements: {
        targetMt: 66,
        stepMt: 1,
        minNarKcalPerKg: 4_000,
        maxSulfurPct: 1,
        maxAshPct: 20,
        maxTotalMoisturePct: 20,
      },
      maxSolutions: 20,
    })).toThrow(`exceeds ${MAX_ENUMERATED_SOLUTIONS} allocations`);
  });
});
