import { NextResponse } from "next/server";
import {
  isRequestBodyError,
  readBoundedJson,
  STANDARD_JSON_BODY_LIMIT,
} from "@/lib/bounded-json";
import { getPublicSettings, isSettingsWritable, updateLocalSettings, type LocalSettingsUpdate } from "@/lib/local-settings";
import { enforceApiRequest } from "@/lib/request-security";
import { isCredentialStoreError } from "@/lib/credential-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "analyst",
    rateLimit: { bucket: "settings-read", limit: 60, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  try {
    return NextResponse.json(getPublicSettings(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isCredentialStoreError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Settings are temporarily unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(request: Request) {
  try {
    const rejected = enforceApiRequest(request, {
      minimumRole: "admin",
      json: true,
      maxBodyBytes: STANDARD_JSON_BODY_LIMIT,
      rateLimit: { bucket: "settings-write", limit: 20, windowMs: 60_000 },
    });
    if (rejected) return rejected;

    if (!isSettingsWritable()) {
      return NextResponse.json(
        { error: "Settings are writable only in the local desktop app." },
        { status: 403 },
      );
    }

    const body = await readBoundedJson(request, STANDARD_JSON_BODY_LIMIT) as LocalSettingsUpdate;
    return NextResponse.json(updateLocalSettings(body), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isRequestBodyError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isCredentialStoreError(error)) {
      const status = error.code === "CREDENTIAL_INVALID" ? 400 : 503;
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: "Invalid settings payload" }, { status: 400 });
  }
}
