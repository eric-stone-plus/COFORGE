import { NextResponse } from "next/server";
import {
  isRequestBodyError,
  readBoundedJson,
  STANDARD_JSON_BODY_LIMIT,
} from "@/lib/bounded-json";
import { queryPublicDb } from "@/lib/db";
import { enforceApiRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "analyst",
    json: true,
    maxBodyBytes: STANDARD_JSON_BODY_LIMIT,
    rateLimit: { bucket: "query", limit: 30, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  let body: unknown;

  try {
    body = await readBoundedJson(request, STANDARD_JSON_BODY_LIMIT);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        rows: [],
        error: {
          code: "QUERY_INVALID_REQUEST",
          message: isRequestBodyError(error) ? error.message : "Invalid JSON body",
        },
        executedSql: null,
        meta: { queryId: "unavailable", source: "api", durationMs: 0 },
      },
      { status: isRequestBodyError(error) ? error.status : 400 },
    );
  }

  const sql = typeof body === "object" && body !== null && "sql" in body ? body.sql : undefined;

  if (typeof sql !== "string" || sql.trim().length === 0) {
    return NextResponse.json(
      {
        ok: false,
        rows: [],
        error: { code: "QUERY_INVALID_REQUEST", message: "Request body must include a non-empty sql string" },
        executedSql: null,
        meta: { queryId: "unavailable", source: "api", durationMs: 0 },
      },
      { status: 400 },
    );
  }

  try {
    const result = await queryPublicDb(sql, { source: "api" });
    if (result.ok) return NextResponse.json(result);

    const status = result.error.code === "QUERY_BUSY" || result.error.code === "QUERY_PROCESS_ERROR"
      ? 503
      : result.error.code === "QUERY_TIMEOUT"
        ? 504
        : result.error.code === "QUERY_REJECTED"
          ? 400
          : result.error.code === "QUERY_AUDIT_ERROR"
            ? 500
            : result.error.code === "QUERY_CELL_LIMIT" || result.error.code === "QUERY_RESPONSE_LIMIT"
              ? 413
              : 422;
    return NextResponse.json(result, { status });
  } catch {
    return NextResponse.json({
      ok: false,
      rows: [],
      error: { code: "QUERY_INTERNAL_ERROR", message: "The query service could not complete the request" },
      executedSql: null,
      meta: { queryId: "unavailable", source: "api", durationMs: 0 },
    }, { status: 500 });
  }
}
