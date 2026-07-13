import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getPublicSettings } from "@/lib/local-settings";
import { enforceApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "anonymous",
    allowNonBrowser: true,
    rateLimit: { bucket: "health", limit: 120, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  try {
    getDb().prepare("SELECT 1").get();
    const settings = getPublicSettings();
    return NextResponse.json(
      {
        status: "ok",
        db: "ready",
        mode: settings.mode,
        providerConfigured: settings.provider.configured,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        status: "error",
        error: "Service unavailable",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
