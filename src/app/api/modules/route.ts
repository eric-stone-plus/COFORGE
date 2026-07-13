import { NextResponse } from "next/server";
import { dashboardSummary, getAllModuleSummaries } from "@/lib/co-modules";
import { enforceApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "analyst",
    rateLimit: { bucket: "modules", limit: 120, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  try {
    return NextResponse.json(
      { modules: getAllModuleSummaries(), dashboard: dashboardSummary() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Module dashboard failed", error);
    return NextResponse.json(
      {
        modules: [],
        dashboard: null,
        error: "Dashboard data is unavailable.",
        generatedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
