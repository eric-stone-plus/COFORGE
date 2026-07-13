import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { guardReadOnlySql } from "./sql-guard";
import { executeGuardedQuery } from "./query-executor";
import { appendQueryAuditEvent } from "./query-audit";
import type { QueryEnvelope, QueryExecutionOptions } from "./query-types";

let db: Database.Database | null = null;

export function resolveDbPath() {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolve(configured);

  const candidates = [
    join(process.cwd(), "data", "coal-demo.db"),
    join(process.cwd(), "..", "data", "coal-demo.db"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = resolveDbPath();
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  return db;
}

export function queryDb(sql: string): Record<string, unknown>[] {
  return getDb().prepare(sql).all() as Record<string, unknown>[];
}

export async function queryPublicDb(
  sql: string,
  options: QueryExecutionOptions = {},
): Promise<QueryEnvelope> {
  const source = options.source ?? "internal";
  const startedAt = performance.now();
  try {
    const guarded = guardReadOnlySql(sql, { maxRows: options.maxRows });
    return executeGuardedQuery(resolveDbPath(), guarded, { ...options, source });
  } catch (error) {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const queryId = randomUUID();
    const message = error instanceof Error ? error.message : "The SQL query was rejected";
    let auditEventId: string | undefined;
    try {
      const auditEvent = await appendQueryAuditEvent({
        queryId,
        source,
        outcome: "rejected",
        sql,
        durationMs,
        errorCode: "QUERY_REJECTED",
      });
      auditEventId = auditEvent.eventId;
    } catch {
      return {
        ok: false,
        rows: [],
        error: { code: "QUERY_AUDIT_ERROR", message: "The query audit event could not be persisted" },
        executedSql: null,
        meta: { queryId, source, durationMs },
      };
    }
    return {
      ok: false,
      rows: [],
      error: { code: "QUERY_REJECTED", message },
      executedSql: null,
      meta: { queryId, auditEventId, source, durationMs },
    };
  }
}
