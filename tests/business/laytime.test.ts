import { describe, expect, it } from "vitest";
import { calculateLaytime, MAX_LAYTIME_EVENTS } from "../../src/lib/business/laytime";

describe("laytime engine", () => {
  it("unions overlapping SOF deductions and reconciles strict/concession claims", () => {
    const result = calculateLaytime({
      laytimeStart: "2026-01-01T00:00:00Z",
      operationsComplete: "2026-01-05T00:00:00Z",
      allowedHours: 60,
      demurrageRateUsdPerDay: 24_000,
      despatchRateUsdPerDay: 12_000,
      events: [
        {
          id: "weather",
          start: "2026-01-01T12:00:00Z",
          end: "2026-01-02T00:00:00Z",
          reason: "Synthetic weather stoppage",
          strictTreatment: "DEDUCT",
        },
        {
          id: "overlap",
          start: "2026-01-01T18:00:00Z",
          end: "2026-01-02T06:00:00Z",
          reason: "Synthetic overlapping stoppage",
          strictTreatment: "DEDUCT",
        },
        {
          id: "commercial",
          start: "2026-01-02T12:00:00Z",
          end: "2026-01-02T18:00:00Z",
          reason: "Commercial concession only",
          strictTreatment: "COUNT",
          concessionTreatment: "DEDUCT",
        },
      ],
      counterpartyClaim: { usedHours: 80, amountUsd: 20_000 },
    });

    expect(result.strict.deductedHours).toBe(18);
    expect(result.strict.usedHours).toBe(78);
    expect(result.strict.settlementAmountUsd).toBe(18_000);
    expect(result.concession.deductedHours).toBe(24);
    expect(result.concession.usedHours).toBe(72);
    expect(result.concession.settlementAmountUsd).toBe(12_000);
    expect(result.difference).toEqual({ usedHours: -6, settlementAmountUsd: -6_000 });
    expect(result.reconciliation?.strictUsedHoursDelta).toBe(-2);
  });

  it("counts a deduction after demurrage in strict mode but allows concession override", () => {
    const result = calculateLaytime({
      laytimeStart: "2026-02-01T00:00:00+08:00",
      operationsComplete: "2026-02-04T00:00:00+08:00",
      allowedHours: 24,
      demurrageRateUsdPerDay: 24_000,
      events: [{
        id: "rain-after-demurrage",
        start: "2026-02-03T00:00:00+08:00",
        end: "2026-02-03T12:00:00+08:00",
        reason: "Synthetic rain",
        strictTreatment: "DEDUCT",
        concessionTreatment: "DEDUCT",
      }],
    });

    expect(result.strict.deductedHours).toBe(0);
    expect(result.strict.usedHours).toBe(72);
    expect(result.concession.deductedHours).toBe(12);
    expect(result.concession.usedHours).toBe(60);
    expect(result.window.laytimeStartUtc).toBe("2026-01-31T16:00:00.000Z");
  });

  it("rejects malformed timestamps, duplicate ids, and out-of-window evidence", () => {
    const base = {
      laytimeStart: "2026-01-01T00:00:00Z",
      operationsComplete: "2026-01-02T00:00:00Z",
      allowedHours: 24,
      demurrageRateUsdPerDay: 10_000,
      events: [],
    };
    expect(() => calculateLaytime({ ...base, laytimeStart: "2026-02-30T00:00:00Z" }))
      .toThrow("valid calendar");
    expect(() => calculateLaytime({ ...base, events: [
      { id: "x", start: "2026-01-01T01:00:00Z", end: "2026-01-01T02:00:00Z", reason: "a", strictTreatment: "COUNT" as const },
      { id: "x", start: "2026-01-01T02:00:00Z", end: "2026-01-01T03:00:00Z", reason: "b", strictTreatment: "COUNT" as const },
    ] })).toThrow("duplicate id");
  });

  it("bounds event count and overlapping timeline detail", () => {
    const base = {
      laytimeStart: "2026-01-01T00:00:00Z",
      operationsComplete: "2026-12-31T00:00:00Z",
      allowedHours: 24,
      demurrageRateUsdPerDay: 10_000,
    };
    const tooMany = Array.from({ length: MAX_LAYTIME_EVENTS + 1 }, (_, index) => ({
      id: `event-${index}`,
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-02T00:00:00Z",
      reason: "Synthetic event",
      strictTreatment: "DEDUCT" as const,
    }));
    expect(() => calculateLaytime({ ...base, events: tooMany })).toThrow(/at most/);

    const pathologicalOverlap = Array.from({ length: 300 }, (_, index) => ({
      id: `event-${index}`,
      start: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      end: "2026-12-30T00:00:00Z",
      reason: "Synthetic overlapping event",
      strictTreatment: "DEDUCT" as const,
    }));
    expect(() => calculateLaytime({ ...base, events: pathologicalOverlap }))
      .toThrow(/too much overlapping timeline detail/);
  });
});
