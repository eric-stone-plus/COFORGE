import { NextResponse } from "next/server";
import {
  isRequestBodyError,
  readBoundedJson,
  STANDARD_JSON_BODY_LIMIT,
} from "@/lib/bounded-json";
import { getTokenUsageSnapshot, isSettingsWritable, resetTokenUsage, updateTokenPlan } from "@/lib/local-settings";
import { enforceApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "analyst",
    rateLimit: { bucket: "token-read", limit: 60, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  return NextResponse.json(getTokenUsageSnapshot(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const rejected = enforceApiRequest(request, {
      minimumRole: "admin",
      json: true,
      maxBodyBytes: STANDARD_JSON_BODY_LIMIT,
      rateLimit: { bucket: "token-write", limit: 10, windowMs: 60_000 },
    });
    if (rejected) return rejected;

    if (!isSettingsWritable()) {
      return NextResponse.json(
        { error: "Token plan is writable only in the local desktop app." },
        { status: 403 },
      );
    }

    const body = (await readBoundedJson(request, STANDARD_JSON_BODY_LIMIT)) as { monthlyBudget?: unknown; reset?: unknown };

    if (body.reset === true) {
      return NextResponse.json(resetTokenUsage(), {
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json(updateTokenPlan(body.monthlyBudget), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isRequestBodyError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Invalid token usage payload" }, { status: 400 });
  }
}
