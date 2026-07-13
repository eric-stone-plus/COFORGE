import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: () => {
    throw new Error("database failed at /Users/private/company.db");
  },
}));
vi.mock("@/lib/local-settings", () => ({ getPublicSettings: vi.fn() }));
vi.mock("@/lib/request-security", async () => import("../src/lib/request-security"));

describe("health API", () => {
  it("returns a stable failure without exposing internal exception details", async () => {
    const { GET } = await import("../src/app/api/health/route");
    const response = await GET(new Request("http://localhost/api/health", {
      headers: { host: "localhost" },
    }));
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ status: "error", error: "Service unavailable" });
    expect(JSON.stringify(payload)).not.toContain("/Users/");
  });
});
