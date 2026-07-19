import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "net";
import { NextResponse } from "next/server";
import {
  assertDeclaredBodyWithinLimit,
  isRequestBodyError,
} from "./bounded-json";

export type ApiRole = "anonymous" | "analyst" | "admin" | "desktop";

export type RequestPolicy = {
  minimumRole?: Exclude<ApiRole, "desktop">;
  json?: boolean;
  maxBodyBytes?: number;
  allowNonBrowser?: boolean;
  rateLimit?: {
    bucket: string;
    limit: number;
    windowMs: number;
  };
};

type RateBucket = { count: number; resetAt: number };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const roleRank: Record<ApiRole, number> = { anonymous: 0, analyst: 1, admin: 2, desktop: 3 };
const rateBuckets = new Map<string, RateBucket>();

function splitList(value: string | undefined) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function configuredPublicOrigins() {
  return new Set([
    ...splitList(process.env.COFORGE_ALLOWED_ORIGINS),
    ...splitList(process.env.NEXT_PUBLIC_APP_URL),
  ].flatMap((value) => {
    try {
      return [new URL(value).origin];
    } catch {
      return [];
    }
  }));
}

function normalizedHost(host: string) {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function firstForwarded(value: string | null) {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

function trustedProxyHeaders() {
  return process.env.COFORGE_TRUST_PROXY === "1";
}

function clientKey(request: Request) {
  const bearer = bearerToken(request);
  const authenticatedBearer = constantTimeEqual(bearer, process.env.COFORGE_ADMIN_TOKEN)
    || constantTimeEqual(bearer, process.env.COFORGE_ANALYST_TOKEN);
  // Without a trusted proxy the only client signal is the Host header, which
  // the client controls: it cannot isolate abusers and turns the limit into a
  // shared bucket. Use one honest global bucket instead; per-IP limiting
  // requires COFORGE_TRUST_PROXY=1 behind a header-sanitizing proxy.
  const identity = authenticatedBearer
    ? `token:${bearer}`
    : trustedProxyHeaders()
      ? `ip:${firstForwarded(request.headers.get("x-forwarded-for")) || request.headers.get("x-real-ip")?.trim() || "unknown"}`
      : "global";
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function constantTimeEqual(actual: string, expected: string | undefined) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isDesktopRequest(request: Request) {
  if (process.env.COFORGE_DESKTOP !== "1") return false;
  const capability = process.env.COFORGE_DESKTOP_CAPABILITY;
  const actual = request.headers.get("x-coforge-capability") ?? "";
  if (!constantTimeEqual(actual, capability)) return false;

  const host = normalizedHost(request.headers.get("host") ?? "");
  if (!LOOPBACK_HOSTS.has(host)) return false;

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
      if (url.host !== request.headers.get("host")) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function resolveRequestRole(request: Request): ApiRole {
  if (isDesktopRequest(request)) return "desktop";

  const token = bearerToken(request);
  if (constantTimeEqual(token, process.env.COFORGE_ADMIN_TOKEN)) return "admin";
  if (constantTimeEqual(token, process.env.COFORGE_ANALYST_TOKEN)) return "analyst";
  return process.env.COFORGE_DEMO_ANONYMOUS === "0" ? "anonymous" : "analyst";
}

export function isTrustedRequestOrigin(request: Request) {
  if (isDesktopRequest(request)) return true;
  const origin = request.headers.get("origin");
  const requestURL = new URL(request.url);
  const forwardedHost = trustedProxyHeaders() ? firstForwarded(request.headers.get("x-forwarded-host")) : "";
  const forwardedProto = trustedProxyHeaders() ? firstForwarded(request.headers.get("x-forwarded-proto")) : "";
  const directHost = request.headers.get("host")?.trim() ?? "";
  const originHost = forwardedHost || directHost;
  const originProtocol = forwardedHost
    ? forwardedProto || requestURL.protocol.slice(0, -1)
    : requestURL.protocol.slice(0, -1);
  const requestOrigin = originHost ? `${originProtocol}://${originHost}` : requestURL.origin;
  if (!origin) {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none") return true;
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        return refererOrigin === requestOrigin || configuredPublicOrigins().has(refererOrigin);
      } catch {
        return false;
      }
    }
    return Boolean(bearerToken(request));
  }

  try {
    const originURL = new URL(origin);
    return originURL.origin === requestOrigin || configuredPublicOrigins().has(originURL.origin);
  } catch {
    return false;
  }
}

function checkRateLimit(request: Request, policy: NonNullable<RequestPolicy["rateLimit"]>) {
  const now = Date.now();
  const key = `${policy.bucket}:${clientKey(request)}`;
  const current = rateBuckets.get(key);

  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }

  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, remaining: policy.limit - 1, resetAt: now + policy.windowMs };
  }

  if (current.count >= policy.limit) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }

  current.count += 1;
  return { allowed: true, remaining: policy.limit - current.count, resetAt: current.resetAt };
}

export function enforceApiRequest(request: Request, policy: RequestPolicy = {}) {
  if (process.env.COFORGE_DESKTOP === "1" && !isDesktopRequest(request)) {
    return NextResponse.json({ error: "Desktop capability required" }, { status: 401 });
  }

  const hasBrowserContext = Boolean(request.headers.get("origin") || request.headers.get("sec-fetch-site"));
  if ((!policy.allowNonBrowser || hasBrowserContext) && !isTrustedRequestOrigin(request)) {
    return NextResponse.json({ error: "Untrusted request origin" }, { status: 403 });
  }

  if (policy.json && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  if (policy.maxBodyBytes !== undefined) {
    try {
      assertDeclaredBodyWithinLimit(request, policy.maxBodyBytes);
    } catch (error) {
      if (isRequestBodyError(error)) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  if (bearerToken(request) && resolveRequestRole(request) === (process.env.COFORGE_DEMO_ANONYMOUS === "0" ? "anonymous" : "analyst")
    && !constantTimeEqual(bearerToken(request), process.env.COFORGE_ANALYST_TOKEN)
    && !constantTimeEqual(bearerToken(request), process.env.COFORGE_ADMIN_TOKEN)) {
    return NextResponse.json({ error: "Invalid bearer token" }, { status: 401 });
  }

  const role = resolveRequestRole(request);
  const minimum = policy.minimumRole ?? "anonymous";
  if (roleRank[role] < roleRank[minimum]) {
    return NextResponse.json({ error: "Insufficient API role" }, { status: 403 });
  }

  if (policy.rateLimit) {
    const result = checkRateLimit(request, policy.rateLimit);
    if (!result.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
            "X-RateLimit-Limit": String(policy.rateLimit.limit),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  }

  return null;
}

export function enforceDesktopCapability(request: Request) {
  if (process.env.COFORGE_DESKTOP !== "1" || isDesktopRequest(request)) return null;
  return NextResponse.json({ error: "Desktop capability required" }, { status: 401 });
}

export function resetRateLimitsForTests() {
  rateBuckets.clear();
}

export function isLoopbackAddress(value: string) {
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return LOOPBACK_HOSTS.has(normalized.toLowerCase()) || (isIP(normalized) === 4 && normalized.startsWith("127."));
}
