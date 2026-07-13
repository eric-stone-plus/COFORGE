import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RequestBodyError,
  readBoundedJson,
  STANDARD_JSON_BODY_LIMIT,
} from "../src/lib/bounded-json";
import { enforceApiRequest, resetRateLimitsForTests, resolveRequestRole } from "../src/lib/request-security";

const env = { ...process.env };

function request(headers: Record<string, string> = {}) {
  return new Request("https://demo.example/api/query", { method: "POST", headers });
}

beforeEach(() => {
  process.env = { ...env, NODE_ENV: "production", COFORGE_ALLOWED_ORIGINS: "https://demo.example" };
  resetRateLimitsForTests();
});

afterEach(() => {
  process.env = { ...env };
});

describe("API request boundary", () => {
  it("allows the hosted anonymous analyst only from the configured origin", () => {
    process.env.COFORGE_DEMO_ANONYMOUS = "1";
    const allowed = request({ origin: "https://demo.example", "content-type": "application/json" });
    expect(resolveRequestRole(allowed)).toBe("analyst");
    expect(enforceApiRequest(allowed, { minimumRole: "analyst", json: true })).toBeNull();

    const rejected = request({ origin: "https://attacker.example", "content-type": "application/json" });
    expect(enforceApiRequest(rejected, { minimumRole: "analyst", json: true })?.status).toBe(403);
  });

  it("accepts a same-origin Referer when the browser omits Origin headers", () => {
    process.env.COFORGE_DEMO_ANONYMOUS = "1";
    const sameOrigin = request({ referer: "https://demo.example/", "content-type": "application/json" });
    expect(enforceApiRequest(sameOrigin, { minimumRole: "analyst", json: true })).toBeNull();

    const crossOrigin = request({ referer: "https://attacker.example/", "content-type": "application/json" });
    expect(enforceApiRequest(crossOrigin, { minimumRole: "analyst", json: true })?.status).toBe(403);
  });

  it("uses the direct Host when Next exposes a different internal request URL", () => {
    const frameworkProxy = new Request("http://localhost:3000/api/query", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3127",
        referer: "http://127.0.0.1:3127/",
        "content-type": "application/json",
      },
    });
    expect(enforceApiRequest(frameworkProxy, { minimumRole: "analyst", json: true })).toBeNull();
  });

  it("requires the admin bearer token and JSON for settings writes", () => {
    process.env.COFORGE_ADMIN_TOKEN = "admin-secret";
    const analyst = request({ origin: "https://demo.example", "content-type": "application/json" });
    expect(enforceApiRequest(analyst, { minimumRole: "admin", json: true })?.status).toBe(403);

    const wrongType = request({ origin: "https://demo.example", authorization: "Bearer admin-secret" });
    expect(enforceApiRequest(wrongType, { minimumRole: "admin", json: true })?.status).toBe(415);
  });

  it("rejects a declared body that exceeds the route limit before reading it", async () => {
    const oversized = request({
      origin: "https://demo.example",
      "content-type": "application/json",
      "content-length": String(STANDARD_JSON_BODY_LIMIT + 1),
    });
    const response = enforceApiRequest(oversized, {
      minimumRole: "analyst",
      json: true,
      maxBodyBytes: STANDARD_JSON_BODY_LIMIT,
    });

    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({ error: "Request body is too large." });
  });

  it("rejects chunked bodies when their streamed byte count crosses the limit", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"value":"'), new Uint8Array(12).fill(97), encoder.encode('"}')];
    const chunked = new Request("https://demo.example/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedJson(chunked, 16)).rejects.toMatchObject({
      code: "BODY_TOO_LARGE",
      status: 413,
    } satisfies Partial<RequestBodyError>);
  });

  it("parses a normal streamed JSON body and maps malformed JSON to 400", async () => {
    const valid = new Request("https://demo.example/api/query", {
      method: "POST",
      body: new Blob(['{"sql":', '"SELECT 1"}']).stream(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedJson(valid, 64)).resolves.toEqual({ sql: "SELECT 1" });

    const invalid = new Request("https://demo.example/api/query", {
      method: "POST",
      body: "{not-json",
    });
    await expect(readBoundedJson(invalid, 64)).rejects.toMatchObject({
      code: "INVALID_JSON",
      status: 400,
    } satisfies Partial<RequestBodyError>);
  });

  it("requires the per-process capability and loopback Host in desktop mode", () => {
    process.env.COFORGE_DESKTOP = "1";
    process.env.COFORGE_DESKTOP_CAPABILITY = "desktop-secret";
    const missing = new Request("http://127.0.0.1:18100/api/query", {
      method: "POST",
      headers: { host: "127.0.0.1:18100", origin: "http://127.0.0.1:18100", "content-type": "application/json" },
    });
    expect(enforceApiRequest(missing, { minimumRole: "analyst", json: true })?.status).toBe(401);

    const allowed = new Request("http://127.0.0.1:18100/api/query", {
      method: "POST",
      headers: {
        host: "127.0.0.1:18100",
        origin: "http://127.0.0.1:18100",
        "content-type": "application/json",
        "x-coforge-capability": "desktop-secret",
      },
    });
    expect(enforceApiRequest(allowed, { minimumRole: "analyst", json: true })).toBeNull();
  });

  it("does not grant development admin access from a spoofed loopback Host", () => {
    process.env = { ...process.env, NODE_ENV: "development", COFORGE_DEMO_ANONYMOUS: "0" };
    const spoofed = new Request("http://192.168.1.20:3000/api/settings", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://192.168.1.20:3000",
        "content-type": "application/json",
      },
    });

    expect(resolveRequestRole(spoofed)).toBe("anonymous");
    expect(enforceApiRequest(spoofed, { minimumRole: "admin", json: true })?.status).toBe(403);
  });

  it("limits repeated requests per client and bucket", () => {
    const input = request({ origin: "https://demo.example", "content-type": "application/json", "x-forwarded-for": "203.0.113.8" });
    const policy = { minimumRole: "analyst" as const, json: true, rateLimit: { bucket: "test", limit: 2, windowMs: 60_000 } };
    expect(enforceApiRequest(input, policy)).toBeNull();
    expect(enforceApiRequest(input, policy)).toBeNull();
    expect(enforceApiRequest(input, policy)?.status).toBe(429);
  });

  it("ignores spoofed proxy headers unless trusted proxy mode is explicit", () => {
    const policy = { minimumRole: "analyst" as const, json: true, rateLimit: { bucket: "spoof", limit: 2, windowMs: 60_000 } };
    const first = request({
      origin: "https://demo.example",
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.1",
    });
    const spoofed = request({
      origin: "https://demo.example",
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.2",
    });
    expect(enforceApiRequest(first, policy)).toBeNull();
    expect(enforceApiRequest(spoofed, policy)).toBeNull();
    expect(enforceApiRequest(spoofed, policy)?.status).toBe(429);

    const forgedOrigin = request({
      origin: "https://attacker.example",
      "content-type": "application/json",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    });
    expect(enforceApiRequest(forgedOrigin, { minimumRole: "analyst", json: true })?.status).toBe(403);
  });

  it("honors forwarding headers only behind an explicitly trusted proxy", () => {
    process.env.COFORGE_TRUST_PROXY = "1";
    const forwarded = request({
      origin: "https://public.example",
      "content-type": "application/json",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    });
    expect(enforceApiRequest(forwarded, { minimumRole: "analyst", json: true })).toBeNull();
  });

  it("rejects rotating invalid bearer tokens instead of granting fresh anonymous buckets", () => {
    process.env.COFORGE_DEMO_ANONYMOUS = "1";
    const policy = { minimumRole: "analyst" as const, json: true, rateLimit: { bucket: "invalid-token", limit: 1, windowMs: 60_000 } };
    for (const token of ["random-1", "random-2", "random-3"]) {
      const response = enforceApiRequest(request({
        origin: "https://demo.example",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      }), policy);
      expect(response?.status).toBe(401);
    }
  });

  it("keeps separate buckets for distinct valid analyst and admin credentials", () => {
    process.env.COFORGE_ANALYST_TOKEN = "analyst-secret";
    process.env.COFORGE_ADMIN_TOKEN = "admin-secret";
    const policy = { minimumRole: "analyst" as const, json: true, rateLimit: { bucket: "valid-token", limit: 1, windowMs: 60_000 } };
    const analyst = request({ origin: "https://demo.example", "content-type": "application/json", authorization: "Bearer analyst-secret" });
    const admin = request({ origin: "https://demo.example", "content-type": "application/json", authorization: "Bearer admin-secret" });
    expect(enforceApiRequest(analyst, policy)).toBeNull();
    expect(enforceApiRequest(admin, policy)).toBeNull();
    expect(enforceApiRequest(analyst, policy)?.status).toBe(429);
    expect(enforceApiRequest(admin, policy)?.status).toBe(429);
  });

  it("allows an originless health probe without weakening browser origin checks", () => {
    const probe = request();
    expect(enforceApiRequest(probe, { minimumRole: "anonymous", allowNonBrowser: true })).toBeNull();

    const browser = request({ origin: "https://attacker.example" });
    expect(enforceApiRequest(browser, { minimumRole: "anonymous", allowNonBrowser: true })?.status).toBe(403);
  });
});
