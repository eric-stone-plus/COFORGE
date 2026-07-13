import { describe, expect, it } from "vitest";
import {
  compareDomesticAndImported,
  matchCoalQuality,
  recommendInventoryPosition,
  scoreQualityIndicator,
  scoreSuppliers,
  SourcingValidationError,
} from "../../src/lib/business/sourcing";

describe("sourcing engine", () => {
  it("applies hard constraints before scoring coal quality", () => {
    const result = matchCoalQuality({
      coal: {
        narKcalPerKg: 5_500,
        sulfurPct: 1.2,
        ashPct: 12,
        totalMoisturePct: 15,
        ashFusionDtC: 1_300,
      },
      requirements: {
        minNarKcalPerKg: 5_300,
        maxSulfurPct: 1,
        maxAshPct: 15,
        maxTotalMoisturePct: 20,
        minAshFusionDtC: 1_250,
      },
    });

    expect(result.eligible).toBe(false);
    expect(result.score).toBe(0);
    expect(result.hardConstraintFailures).toContain("SULFUR_ABOVE_MAXIMUM");
  });

  it("uses lower, closer, and range score semantics", () => {
    expect(scoreQualityIndicator(0.3, 1, "lower")).toBe(100);
    expect(scoreQualityIndicator(1, 1, "lower")).toBe(50);
    expect(scoreQualityIndicator(5_500, 5_500, "closer")).toBe(100);
    expect(scoreQualityIndicator(25, [20, 30], "range")).toBe(100);
    expect(scoreQualityIndicator(35, [20, 30], "range")).toBe(50);
  });

  it("keeps ash-fusion DT as a hard constraint and risk label", () => {
    const result = matchCoalQuality({
      coal: {
        narKcalPerKg: 5_500,
        sulfurPct: 0.3,
        ashPct: 8,
        totalMoisturePct: 12,
        volatileMatterPct: 28,
        hgi: 55,
        ashFusionDtC: 1_280,
      },
      requirements: {
        minNarKcalPerKg: 5_500,
        maxSulfurPct: 1,
        maxAshPct: 15,
        maxTotalMoisturePct: 20,
        volatileMatterRangePct: [25, 35],
        hgiRange: [45, 65],
        minAshFusionDtC: 1_250,
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.ashFusionRisk).toBe("medium");
    expect(result.score).toBeGreaterThan(80);
    expect(Object.keys(result.weights)).not.toContain("dt");
  });

  it("compares domestic and imported coal on full unit-heat cost", () => {
    const result = compareDomesticAndImported({
      domestic: {
        minePriceCnyPerMt: 600,
        railFreightCnyPerMt: 50,
        coastalFreightCnyPerMt: 35,
        portChargesCnyPerMt: 15,
        narKcalPerKg: 5_500,
      },
      imported: {
        fobUsdPerMt: 70,
        oceanFreightUsdPerMt: 12,
        exchangeRateCnyPerUsd: 7.2,
        portChargesCnyPerMt: 25,
        shortHaulCnyPerMt: 15,
        inspectionCnyPerMt: 3,
        annualFinanceRate: 0.05,
        financingDays: 45,
        lcFeeRate: 0.001,
        vatRecoveryDays: 30,
        narKcalPerKg: 5_000,
      },
    });

    expect(result.domestic.unitHeatCostCnyPerMillionKcal).toBeCloseTo(700 / 5.5, 5);
    expect(result.imported.financeCostCnyPerMt).toBeGreaterThan(0);
    expect(result.spreadDomesticMinusImportedCnyPerMillionKcal).toBeCloseTo(
      result.domestic.unitHeatCostCnyPerMillionKcal - result.imported.unitHeatCostCnyPerMillionKcal,
      6,
    );
    expect(result.vatTreatment).toContain("excluded");
  });

  it("uses unit-heat cost, not tonne price, for inversion", () => {
    const result = compareDomesticAndImported({
      domestic: { minePriceCnyPerMt: 620, narKcalPerKg: 6_000 },
      imported: {
        fobUsdPerMt: 70,
        oceanFreightUsdPerMt: 10,
        exchangeRateCnyPerUsd: 7,
        narKcalPerKg: 4_000,
      },
    });

    expect(result.lowerCostSource).toBe("domestic");
  });

  it("recommends non-zero replenishment in the normal coverage band", () => {
    const result = recommendInventoryPosition({
      inventoryMt: 27_000,
      inboundConfirmedMt: 3_000,
      dailyConsumptionMt: 1_000,
      targetDays: 35,
    });

    expect(result.status).toBe("normal");
    expect(result.coverageDays).toBe(30);
    expect(result.recommendedPurchaseMt).toBe(5_000);
  });

  it("raises and normalizes compliance weight for imported suppliers", () => {
    const result = scoreSuppliers({
      suppliers: [
        {
          supplierId: "domestic-a",
          qualityScore: 85,
          landedCostCnyPerMillionKcal: 130,
          deliveryScore: 90,
          complianceScore: 90,
        },
        {
          supplierId: "import-b",
          qualityScore: 90,
          landedCostCnyPerMillionKcal: 128,
          deliveryScore: 85,
          complianceScore: 70,
          importedCoal: true,
        },
      ],
      importedComplianceWeight: 0.2,
    });

    const imported = result.suppliers.find((supplier) => supplier.supplierId === "import-b");
    expect(imported?.appliedWeights.compliance).toBe(0.2);
    expect(Object.values(imported?.appliedWeights ?? {}).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(imported?.priceScore).toBeGreaterThanOrEqual(0);
  });

  it("rejects invalid units, ranges, and weights", () => {
    expect(() => recommendInventoryPosition({ inventoryMt: 100, dailyConsumptionMt: 0 }))
      .toThrow(SourcingValidationError);
    expect(() => matchCoalQuality({
      coal: { narKcalPerKg: 5_000, sulfurPct: 0.5, ashPct: 10, totalMoisturePct: 10 },
      requirements: {
        minNarKcalPerKg: 5_000,
        maxSulfurPct: 1,
        maxAshPct: 15,
        maxTotalMoisturePct: 20,
      },
      weights: { heat: 1, sulfur: 1, ash: 0, moisture: 0, volatile: 0, hgi: 0 },
    })).toThrow("sum to 1.0");
  });
});
