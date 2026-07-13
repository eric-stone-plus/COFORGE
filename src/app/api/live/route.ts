import { NextResponse } from "next/server";
import { enforceDesktopCapability } from "../../../lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness avoids database, filesystem, role, and rate-limit dependencies.
export async function GET(request: Request) {
  const rejected = enforceDesktopCapability(request);
  if (rejected) return rejected;
  return NextResponse.json(
    { status: "live" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
