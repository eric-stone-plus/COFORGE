import { describe, expect, it } from "vitest";
import { MAX_SWAP_EVALUATIONS, rankCoalSwaps } from "../../src/lib/business/coswap";

describe("COSWAP ranking", () => {
  it("filters by each delayed shipment's window, port, quantity, and quality then ranks independently", () => {
    const result = rankCoalSwaps({
      delayedShipments: [
        {
          id: "delay-a",
          deliveryWindowStart: "2026-03-01T00:00:00Z",
          deliveryWindowEnd: "2026-03-05T00:00:00Z",
          allowedPorts: ["Port-A"],
          requiredQuantityMt: 50_000,
          quantityTolerancePct: 0.05,
          originalCostUsdPerMt: 75,
          qualityRequirements: { minNarKcalPerKg: 5_000, maxSulfurPct: 0.8, maxAshPct: 12 },
        },
        {
          id: "delay-b",
          deliveryWindowStart: "2026-03-10T00:00:00Z",
          deliveryWindowEnd: "2026-03-12T00:00:00Z",
          allowedPorts: ["PORT-B"],
          requiredQuantityMt: 60_000,
          quantityTolerancePct: 0,
        },
      ],
      candidates: [
        { id: "cheap", deliveryTime: "2026-03-03T00:00:00Z", port: "port-a", quantityMt: 50_000, costUsdPerMt: 70, reliabilityScore: 80, narKcalPerKg: 5_100, sulfurPct: 0.6, ashPct: 10 },
        { id: "reliable", deliveryTime: "2026-03-03T00:00:00Z", port: "PORT-A", quantityMt: 50_000, costUsdPerMt: 72, reliabilityScore: 100, narKcalPerKg: 5_200, sulfurPct: 0.5, ashPct: 9 },
        { id: "bad-quality", deliveryTime: "2026-03-03T00:00:00Z", port: "PORT-A", quantityMt: 50_000, costUsdPerMt: 65, narKcalPerKg: 4_500, sulfurPct: 0.5, ashPct: 9 },
        { id: "for-b", deliveryTime: "2026-03-11T00:00:00Z", port: "port-b", quantityMt: 60_000, costUsdPerMt: 68 },
      ],
    });

    const a = result.results.find((row) => row.delayedShipmentId === "delay-a");
    const b = result.results.find((row) => row.delayedShipmentId === "delay-b");
    expect(a?.eligibleCandidateCount).toBe(2);
    expect(a?.candidateEvaluations.filter((row) => row.rank !== null).map((row) => row.candidateId)).toEqual(["cheap", "reliable"]);
    expect(a?.candidateEvaluations.find((row) => row.candidateId === "bad-quality")?.disqualificationReasons)
      .toContain("HEAT_BELOW_MINIMUM");
    expect(a?.candidateEvaluations.find((row) => row.candidateId === "for-b")?.disqualificationReasons)
      .toEqual(expect.arrayContaining(["OUTSIDE_DELIVERY_WINDOW", "PORT_NOT_ALLOWED", "QUANTITY_OUTSIDE_TOLERANCE", "QUALITY_DATA_MISSING"]));
    expect(b?.eligibleCandidateCount).toBe(1);
    expect(b?.candidateEvaluations[0].candidateId).toBe("for-b");
  });

  it("treats window boundaries as inclusive and rejects duplicate candidates", () => {
    const input = {
      delayedShipments: [{
        id: "d",
        deliveryWindowStart: "2026-04-01T00:00:00Z",
        deliveryWindowEnd: "2026-04-01T00:00:00Z",
        allowedPorts: ["X"],
        requiredQuantityMt: 1_000,
        quantityTolerancePct: 0,
      }],
      candidates: [{ id: "c", deliveryTime: "2026-04-01T00:00:00Z", port: "x", quantityMt: 1_000, costUsdPerMt: 1 }],
    };
    expect(rankCoalSwaps(input).results[0].eligibleCandidateCount).toBe(1);
    expect(() => rankCoalSwaps({ ...input, candidates: [input.candidates[0], input.candidates[0]] }))
      .toThrow("duplicate id");
  });

  it("bounds the delayed-shipment and candidate cross product", () => {
    const delayedShipments = Array.from({ length: 9 }, (_, index) => ({
      id: `d-${index}`,
      deliveryWindowStart: "2026-04-01T00:00:00Z",
      deliveryWindowEnd: "2026-04-02T00:00:00Z",
      allowedPorts: ["X"],
      requiredQuantityMt: 1_000,
    }));
    const candidates = Array.from({ length: Math.floor(MAX_SWAP_EVALUATIONS / 9) + 1 }, (_, index) => ({
      id: `c-${index}`,
      deliveryTime: "2026-04-01T12:00:00Z",
      port: "X",
      quantityMt: 1_000,
      costUsdPerMt: 1,
    }));
    expect(() => rankCoalSwaps({ delayedShipments, candidates }))
      .toThrow(`must not exceed ${MAX_SWAP_EVALUATIONS} evaluations`);
  });
});
