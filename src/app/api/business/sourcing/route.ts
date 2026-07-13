import { NextResponse } from "next/server";
import {
  executeSourcingRequest,
  SourcingValidationError,
} from "../../../../lib/business/sourcing";
import {
  BUSINESS_JSON_BODY_LIMIT,
  isRequestBodyError,
  readBoundedJson,
} from "../../../../lib/bounded-json";
import { enforceApiRequest } from "../../../../lib/request-security";
import { businessSuccessResponse } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const rejected = enforceApiRequest(request, {
      minimumRole: "analyst",
      json: true,
      maxBodyBytes: BUSINESS_JSON_BODY_LIMIT,
      rateLimit: { bucket: "business-sourcing", limit: 60, windowMs: 60_000 },
    });
    if (rejected) return rejected;

    const body = await readBoundedJson(request, BUSINESS_JSON_BODY_LIMIT);
    return businessSuccessResponse(executeSourcingRequest(body));
  } catch (error) {
    if (isRequestBodyError(error)) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status, headers: NO_STORE },
      );
    }
    if (error instanceof SourcingValidationError) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("Sourcing API failed", error);
    return NextResponse.json(
      { ok: false, error: "Sourcing calculation failed." },
      { status: 500, headers: NO_STORE },
    );
  }
}
