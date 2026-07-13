import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitsForTests } from "../../src/lib/request-security";
import { POST as biddingPost } from "../../src/app/api/business/bidding/route";
import { POST as sourcingPost } from "../../src/app/api/business/sourcing/route";
import { POST as freightPost } from "../../src/app/api/business/freight/route";
import { POST as laytimePost } from "../../src/app/api/business/laytime/route";
import { POST as blendingPost } from "../../src/app/api/business/blending/route";
import { POST as coswapPost } from "../../src/app/api/business/coswap/route";
import { POST as inventoryPost } from "../../src/app/api/business/inventory/route";
import {
  BUSINESS_JSON_RESPONSE_LIMIT,
  createBusinessPost,
} from "../../src/app/api/business/_shared";

function request(body: unknown): Request {
  return new Request("http://localhost/api/business/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv, NODE_ENV: "test" };
  delete process.env.COFORGE_DESKTOP;
  resetRateLimitsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
});

describe("domain API routes", () => {
  it.each([
    ["freight", freightPost, {
      operation: "voyage-cost",
      input: {
        cargoMt: 10_000,
        seaDistanceNm: 240,
        ladenSpeedKnots: 10,
        portDays: 1,
        ladenConsumptionMtPerDay: 20,
        portConsumptionMtPerDay: 3,
        vlsfoPriceUsdPerMt: 600,
      },
    }],
    ["laytime", laytimePost, {
      operation: "calculate",
      input: {
        laytimeStart: "2026-01-01T00:00:00Z",
        operationsComplete: "2026-01-02T00:00:00Z",
        allowedHours: 24,
        demurrageRateUsdPerDay: 10_000,
        events: [],
      },
    }],
    ["blending", blendingPost, {
      operation: "optimize",
      input: {
        sources: [{ id: "s", availableMt: 100, costUsdPerMt: 1, narKcalPerKg: 5_000, sulfurPct: 0.5, ashPct: 10, totalMoisturePct: 12 }],
        requirements: { targetMt: 100, stepMt: 10, minNarKcalPerKg: 5_000, maxSulfurPct: 0.5, maxAshPct: 10, maxTotalMoisturePct: 12 },
      },
    }],
    ["coswap", coswapPost, {
      operation: "rank-swaps",
      input: {
        delayedShipments: [{ id: "d", deliveryWindowStart: "2026-01-01T00:00:00Z", deliveryWindowEnd: "2026-01-02T00:00:00Z", allowedPorts: ["p"], requiredQuantityMt: 1_000 }],
        candidates: [{ id: "c", deliveryTime: "2026-01-01T12:00:00Z", port: "P", quantityMt: 1_000, costUsdPerMt: 1 }],
      },
    }],
    ["inventory", inventoryPost, {
      operation: "rolling-plan",
      input: {
        initialInventoryMt: 0,
        stepMt: 10,
        defaultStorageCapacityMt: 100,
        periods: [{ id: "p", demandMt: 10, purchaseCostUsdPerMt: 1, maxPurchaseMt: 10 }],
      },
    }],
  ] as const)("returns a no-store success envelope for %s", async (_name, handler, body) => {
    const response = await handler(request(body));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.ok).toBe(true);
    expect(payload.data.metadata.version).toMatch(/v1\.0\.0$/);
  });

  it("maps domain validation errors to a structured 400", async () => {
    const response = await freightPost(request({ operation: "voyage-cost", input: {} }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "DOMAIN_VALIDATION_ERROR",
      domain: "freight",
    });
  });

  it("maps malformed JSON to 400 without exposing internals", async () => {
    const response = await laytimePost(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: "{not-json",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Invalid JSON payload." });
  });

  it("rejects oversized business results before sending a response", async () => {
    const oversizedPost = createBusinessPost(
      () => "x".repeat(BUSINESS_JSON_RESPONSE_LIMIT),
      "OversizedTest",
    );
    const response = await oversizedPost(request({}));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "BUSINESS_RESPONSE_TOO_LARGE",
    });
  });

  it.each([
    ["bidding", biddingPost, { operation: "calculate", input: {} }],
    ["sourcing", sourcingPost, { operation: "trade_economics", input: {} }],
    ["shared", freightPost, { operation: "voyage-cost", input: {} }],
  ] as const)("enforces JSON request boundaries for %s", async (_name, handler, body) => {
    const response = await handler(new Request("http://localhost/api/business/test", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  it.each([
    ["bidding", biddingPost, { operation: "calculate", input: {} }],
    ["sourcing", sourcingPost, { operation: "trade_economics", input: {} }],
    ["shared", freightPost, { operation: "voyage-cost", input: {} }],
  ] as const)("requires analyst access for hosted %s requests", async (_name, handler, body) => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.COFORGE_DEMO_ANONYMOUS = "0";
    process.env.COFORGE_ALLOWED_ORIGINS = "https://coforge.example";
    const response = await handler(new Request("https://coforge.example/api/business/test", {
      method: "POST",
      headers: { Origin: "https://coforge.example", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Insufficient API role" });
  });
});
