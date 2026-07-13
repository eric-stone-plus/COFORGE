import { describe, expect, it } from "vitest";
import { DomainValidationError } from "../../src/lib/business/domain-utils";
import { analyzeVlsfoScenarios, calculateVoyageCost } from "../../src/lib/business/freight";

const VOYAGE = {
  cargoMt: 60_000,
  seaDistanceNm: 2_880,
  ballastDistanceNm: 1_440,
  ladenSpeedKnots: 12,
  ballastSpeedKnots: 12,
  portDays: 4,
  idleDays: 1,
  ladenConsumptionMtPerDay: 30,
  ballastConsumptionMtPerDay: 25,
  portConsumptionMtPerDay: 5,
  idleConsumptionMtPerDay: 4,
  vlsfoPriceUsdPerMt: 600,
  bunkerMarginPct: 0.02,
  portCostsUsd: 100_000,
  canalCostsUsd: 20_000,
  otherVoyageCostsUsd: 10_000,
  commissionPctOfFreight: 0.025,
  freightRevenueUsd: 1_200_000,
  dailyHireUsd: 20_000,
};

describe("deterministic voyage engine", () => {
  it("conserves phase time and fuel and calculates net TCE", () => {
    const result = calculateVoyageCost(VOYAGE);

    expect(result.durations).toEqual({
      ladenDays: 10,
      ballastDays: 5,
      portDays: 4,
      idleDays: 1,
      totalVoyageDays: 20,
    });
    expect(result.fuel.totalFuelMt).toBe(449);
    expect(result.costs.bunkerCostUsd).toBeCloseTo(274_788, 6);
    expect(result.earnings.netVoyageRevenueUsd).toBeCloseTo(765_212, 6);
    expect(result.earnings.tceUsdPerDay).toBeCloseTo(38_260.6, 6);
    expect(result.earnings.profitAfterHireUsd).toBeCloseTo(365_212, 6);
    expect(result.metadata.version).toBe("freight-v1.0.0");
  });

  it("shows monotonic bunker cost and TCE impact across VLSFO scenarios", () => {
    const result = analyzeVlsfoScenarios({ voyage: VOYAGE, pricesUsdPerMt: [400, 600, 800] });

    expect(result.scenarios.map((row) => row.bunkerCostUsd)).toEqual(
      [...result.scenarios.map((row) => row.bunkerCostUsd)].sort((a, b) => a - b),
    );
    expect(result.scenarios[0].tceUsdPerDay).toBeGreaterThan(result.scenarios[2].tceUsdPerDay as number);
  });

  it("rejects unknown, non-finite, and physically invalid inputs", () => {
    expect(() => calculateVoyageCost({ ...VOYAGE, seaDistanceNm: Number.NaN }))
      .toThrow(DomainValidationError);
    expect(() => calculateVoyageCost({ ...VOYAGE, ladenSpeedKnots: 0 })).toThrow("must be > 0");
    expect(() => calculateVoyageCost({ ...VOYAGE, unexpected: true } as never)).toThrow("unsupported field");
  });
});
