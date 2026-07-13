import { NextResponse } from "next/server";
import { publicSchemaPayload } from "@/lib/data-catalog";
import { enforceApiRequest } from "@/lib/request-security";

export async function GET(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "analyst",
    rateLimit: { bucket: "schema", limit: 60, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  return NextResponse.json(publicSchemaPayload());
}
