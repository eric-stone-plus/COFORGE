import { describe, expect, it } from "vitest";
import {
  analyzeBidSensitivity,
  analyzeVesselTypeBetas,
  BiddingValidationError,
  calculateLandedCost,
  compareBidSources,
  findFreightBreakEven,
  freightProfitWarnings,
  normalizePriceByHeat,
  type LandedCostInput,
} from "../../src/lib/business/bidding";

const BASE_INPUT: LandedCostInput = {
  incoterm: "FOB",
  priceUsdPerMt: 60,
  quantityMt: 50_000,
  narKcalPerKg: 5_000,
  freight: { rateUsdPerMt: 10 },
  exchangeRateCnyPerUsd: 7,
  insuranceRate: 0.002,
  insuranceMarkupRate: 0.1,
  destinationPortChargesUsdPerMt: 1,
  importDutyRate: 0,
  vatRate: 0.13,
  domesticCosts: { roadFreightCnyPerMt: 20 },
};

describe("bidding engine", () => {
  it("derives FOB, CFR, CIF, and DES from an FOB quote", () => {
    const result = calculateLandedCost(BASE_INPUT);

    expect(result.incotermsUsdPerMt.fob).toBe(60);
    expect(result.incotermsUsdPerMt.cfr).toBe(70);
    expect(result.incotermsUsdPerMt.cif).toBeCloseTo(70 / 0.9978, 6);
    expect(result.incotermsUsdPerMt.des).toBeCloseTo(70 / 0.9978 + 1, 6);
    expect(result.plantCostCnyPerMt).toBeGreaterThan(result.cifCnyPerMt);
    expect(result.cashOutlayCnyPerMt - result.plantCostCnyPerMt).toBeCloseTo(result.vatCnyPerMt, 6);
    expect(result.vatTreatment).toContain("excluded");
  });

  it("treats recoverable VAT as funding exposure rather than economic cost", () => {
    const withoutVat = calculateLandedCost({ ...BASE_INPUT, vatRate: 0 });
    const withVat = calculateLandedCost({ ...BASE_INPUT, vatRate: 0.13 });

    expect(withVat.plantCostCnyPerMt).toBe(withoutVat.plantCostCnyPerMt);
    expect(withVat.cashOutlayCnyPerMt).toBeGreaterThan(withoutVat.cashOutlayCnyPerMt);
  });

  it.each<"CFR" | "CIF" | "DES">(["CFR", "CIF", "DES"])("round-trips a %s input quote", (incoterm) => {
    const fromFob = calculateLandedCost(BASE_INPUT);
    const quotedPrice = fromFob.incotermsUsdPerMt[incoterm.toLowerCase() as "cfr" | "cif" | "des"];
    const result = calculateLandedCost({ ...BASE_INPUT, incoterm, priceUsdPerMt: quotedPrice });

    expect(result.incotermsUsdPerMt.fob).toBeCloseTo(60, 4);
    expect(result.incotermsUsdPerMt.cfr).toBeCloseTo(70, 4);
  });

  it("allocates lump-sum freight per tonne", () => {
    const result = calculateLandedCost({
      ...BASE_INPUT,
      freight: { lumpSumUsd: 500_000 },
    });
    expect(result.freightUsdPerMt).toBe(10);
  });

  it("normalizes coal prices to a target heat basis", () => {
    expect(normalizePriceByHeat(600, 5_000, 5_500)).toBe(660);
  });

  it("compares multiple sources by heat-normalized plant cost", () => {
    const comparison = compareBidSources({
      targetNarKcalPerKg: 5_500,
      sources: [
        { id: "source-a", landedCost: BASE_INPUT },
        {
          id: "source-b",
          landedCost: { ...BASE_INPUT, priceUsdPerMt: 63, narKcalPerKg: 5_500 },
        },
      ],
    });

    expect(comparison.sources).toHaveLength(2);
    expect(comparison.sources[0].spreadVsBestCnyPerMt).toBe(0);
    expect(comparison.sources[1].spreadVsBestCnyPerMt).toBeGreaterThanOrEqual(0);
  });

  it("builds a bid sensitivity matrix with dynamic taxes", () => {
    const result = analyzeBidSensitivity({
      base: { ...BASE_INPUT, sellingPriceCnyPerMt: 700 },
      coalPriceChangesPct: [-10, 0, 10],
      freightChangesPct: [0, 20],
      exchangeRateChangesPct: [0],
    });

    expect(result.scenarioCount).toBe(6);
    const cheap = result.scenarios.find((row) => row.coalPriceChangePct === -10 && row.freightChangePct === 0);
    const expensive = result.scenarios.find((row) => row.coalPriceChangePct === 10 && row.freightChangePct === 20);
    expect(cheap?.plantCostCnyPerMt).toBeLessThan(expensive?.plantCostCnyPerMt as number);
  });

  it("finds the freight break-even point by binary search", () => {
    const result = findFreightBreakEven({
      base: BASE_INPUT,
      sellingPriceCnyPerMt: 700,
      operatingCostCnyPerMt: 20,
    });

    expect(result.status).toBe("ok");
    expect(result.breakEvenFreightUsdPerMt).toBeGreaterThan(BASE_INPUT.freight?.rateUsdPerMt as number);
  });

  it("returns critical, surge, and volatility warnings", () => {
    const result = freightProfitWarnings({
      currentFreightUsdPerMt: 10,
      predictedFreightUsdPerMt: 28,
      breakEvenFreightUsdPerMt: 29,
      volatilityPct: 20,
    });
    expect(result.alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining(["BREAKEVEN_NEAR", "FREIGHT_SURGE", "HIGH_VOLATILITY"]),
    );
  });

  it("estimates vessel-type beta from percentage returns", () => {
    const result = analyzeVesselTypeBetas({
      series: [{
        vesselType: "Type-A",
        observations: [
          { indexLevel: 100, freightUsdPerMt: 10 },
          { indexLevel: 110, freightUsdPerMt: 12 },
          { indexLevel: 99, freightUsdPerMt: 9.6 },
          { indexLevel: 118.8, freightUsdPerMt: 13.44 },
        ],
      }],
    });
    expect(result.vesselTypes[0].beta).toBeGreaterThan(1);
    expect(result.vesselTypes[0].correlation).toBeGreaterThan(0.9);
  });

  it("rejects non-finite and ambiguous freight inputs", () => {
    expect(() => calculateLandedCost({ ...BASE_INPUT, priceUsdPerMt: Number.NaN }))
      .toThrow(BiddingValidationError);
    expect(() => calculateLandedCost({
      ...BASE_INPUT,
      freight: { rateUsdPerMt: 10, lumpSumUsd: 500_000 } as never,
    })).toThrow("exactly one");
  });
});
