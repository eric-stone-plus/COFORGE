import { NextResponse } from "next/server";
import { DomainValidationError } from "../../../lib/business/domain-utils";
import {
  BUSINESS_JSON_BODY_LIMIT,
  isRequestBodyError,
  readBoundedJson,
} from "../../../lib/bounded-json";
import { enforceApiRequest } from "../../../lib/request-security";

const NO_STORE = { "Cache-Control": "no-store" };
export const BUSINESS_JSON_RESPONSE_LIMIT = 2 * 1024 * 1024;

export function businessSuccessResponse(data: unknown) {
  const body = JSON.stringify({ ok: true, data });
  if (Buffer.byteLength(body, "utf8") > BUSINESS_JSON_RESPONSE_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error: "Calculation result is too large; reduce the request scope.",
        code: "BUSINESS_RESPONSE_TOO_LARGE",
      },
      { status: 422, headers: NO_STORE },
    );
  }
  return new NextResponse(body, {
    headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function createBusinessPost(execute: (value: unknown) => unknown, label: string) {
  return async function POST(request: Request) {
    try {
      const rejected = enforceApiRequest(request, {
        minimumRole: "analyst",
        json: true,
        maxBodyBytes: BUSINESS_JSON_BODY_LIMIT,
        rateLimit: {
          bucket: `business-${label.toLowerCase()}`,
          limit: 60,
          windowMs: 60_000,
        },
      });
      if (rejected) return rejected;

      const body = await readBoundedJson(request, BUSINESS_JSON_BODY_LIMIT);
      return businessSuccessResponse(execute(body));
    } catch (error) {
      if (isRequestBodyError(error)) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: error.status, headers: NO_STORE },
        );
      }
      if (error instanceof DomainValidationError) {
        return NextResponse.json(
          { ok: false, error: error.message, code: error.code, domain: error.domain },
          { status: 400, headers: NO_STORE },
        );
      }
      console.error(`${label} API failed`, error);
      return NextResponse.json(
        { ok: false, error: `${label} calculation failed.` },
        { status: 500, headers: NO_STORE },
      );
    }
  };
}
