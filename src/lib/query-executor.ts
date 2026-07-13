import { createHash, randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { dirname } from "path";
import { appendQueryAuditEvent } from "./query-audit";
import type {
  QueryEnvelope,
  QueryExecutionOptions,
  QueryFailure,
  QueryLimits,
  QueryRow,
  QuerySource,
} from "./query-types";
import type { GuardedSql } from "./sql-guard";

declare const __non_webpack_require__: NodeRequire;
const DATABASE_PACKAGE = process.env.COFORGE_DATABASE_PACKAGE || "better-sqlite3";

export const DEFAULT_QUERY_TIMEOUT_MS = 2_000;
export const DEFAULT_MAX_QUERY_ROWS = 500;
export const DEFAULT_MAX_QUERY_COLUMNS = 64;
export const DEFAULT_MAX_QUERY_CELL_BYTES = 64 * 1024;
export const DEFAULT_MAX_QUERY_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_QUERIES = 4;
export const DEFAULT_MAX_QUEUED_QUERIES = 32;

const ERROR_MESSAGES: Record<string, string> = {
  QUERY_TIMEOUT: "The query exceeded the execution time limit",
  QUERY_BUSY: "The query service is at capacity; retry shortly",
  QUERY_PROCESS_ERROR: "The isolated query process failed",
  QUERY_EXECUTION_ERROR: "The isolated query process could not execute the statement",
  QUERY_AUDIT_ERROR: "The query audit event could not be persisted",
};

const QUERY_WORKER_SOURCE = String.raw`
  "use strict";

  function byteLength(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }

  function normalizeCell(value, maxCellBytes) {
    let normalized;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      normalized = typeof value === "number" && !Number.isFinite(value) ? null : value;
    } else if (typeof value === "bigint") {
      normalized = value.toString();
    } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      if (value.byteLength > maxCellBytes) throw new Error("QUERY_CELL_LIMIT");
      normalized = Buffer.from(value).toString("base64");
    } else {
      normalized = String(value);
    }
    if (byteLength(normalized) > maxCellBytes) throw new Error("QUERY_CELL_LIMIT");
    return normalized;
  }

  function run() {
    let db;
    try {
      const { dbPath, sql, limits, databaseModulePath } = JSON.parse(input);
      const Database = require(databaseModulePath);
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      const statement = db.prepare(sql);
      const columnCount = statement.columns().length;
      if (columnCount > limits.maxColumns) throw new Error("QUERY_COLUMN_LIMIT");

      const rows = [];
      let responseBytes = 2;
      for (const rawRow of statement.iterate()) {
        const row = {};
        for (const [column, value] of Object.entries(rawRow)) {
          row[column] = normalizeCell(value, limits.maxCellBytes);
        }
        const rowBytes = byteLength(row) + (rows.length ? 1 : 0);
        if (responseBytes + rowBytes > limits.maxResponseBytes) throw new Error("QUERY_RESPONSE_LIMIT");
        rows.push(row);
        responseBytes += rowBytes;
        if (rows.length >= limits.maxRows) break;
      }
      process.stdout.write(JSON.stringify({ ok: true, rows, columnCount, responseBytes }));
    } catch (error) {
      const code = error instanceof Error && /^QUERY_[A-Z_]+$/.test(error.message)
        ? error.message
        : "QUERY_EXECUTION_ERROR";
      const messages = {
        QUERY_CELL_LIMIT: "A query cell exceeds the allowed byte limit",
        QUERY_COLUMN_LIMIT: "The query returned too many columns",
        QUERY_RESPONSE_LIMIT: "The query response exceeds the allowed byte limit",
        QUERY_EXECUTION_ERROR: "The isolated query worker could not execute the statement",
      };
      process.stdout.write(JSON.stringify({ ok: false, code, message: messages[code] || messages.QUERY_EXECUTION_ERROR }));
    } finally {
      if (db) db.close();
    }
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", run);
`;

export class QueryExecutionError extends Error {
  constructor(readonly code: string, message = ERROR_MESSAGES[code] ?? "Query execution failed") {
    super(message);
    this.name = "QueryExecutionError";
  }
}

type WorkerMessage =
  | { ok: true; rows: QueryRow[]; columnCount: number; responseBytes: number }
  | { ok: false; code: string; message: string };

type QueueEntry<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer?: NodeJS.Timeout;
};

export class QuerySemaphore {
  private active = 0;
  private readonly queue: QueueEntry<unknown>[] = [];

  constructor(private readonly concurrency: number, private readonly maxQueued: number) {}

  execute<T>(run: () => Promise<T>, queueTimeoutMs?: number): Promise<T> {
    if (this.active < this.concurrency) return this.start(run);
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new QueryExecutionError("QUERY_BUSY"));
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<unknown> = {
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (queueTimeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          reject(new QueryExecutionError("QUERY_TIMEOUT"));
        }, Math.max(1, queueTimeoutMs));
        entry.timer.unref();
      }
      this.queue.push(entry);
    });
  }

  private start<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    return Promise.resolve().then(run).finally(() => {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        this.start(next.run).then(next.resolve, next.reject);
      }
    });
  }
}

const semaphore = new QuerySemaphore(
  positiveInteger(process.env.COFORGE_QUERY_CONCURRENCY, DEFAULT_MAX_CONCURRENT_QUERIES),
  positiveInteger(process.env.COFORGE_QUERY_QUEUE_LIMIT, DEFAULT_MAX_QUEUED_QUERIES),
);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value!)), maximum);
}

export function normalizeQueryLimits(options: QueryExecutionOptions = {}): QueryLimits {
  return {
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_QUERY_TIMEOUT_MS, 30_000),
    maxRows: boundedInteger(options.maxRows, DEFAULT_MAX_QUERY_ROWS, DEFAULT_MAX_QUERY_ROWS),
    maxColumns: boundedInteger(options.maxColumns, DEFAULT_MAX_QUERY_COLUMNS, DEFAULT_MAX_QUERY_COLUMNS),
    maxCellBytes: boundedInteger(options.maxCellBytes, DEFAULT_MAX_QUERY_CELL_BYTES, DEFAULT_MAX_QUERY_CELL_BYTES),
    maxResponseBytes: boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_QUERY_RESPONSE_BYTES,
      DEFAULT_MAX_QUERY_RESPONSE_BYTES,
    ),
  };
}

function terminate(child: ChildProcess) {
  if (!child.killed) child.kill("SIGKILL");
}

function runWorker(dbPath: string, guarded: GuardedSql, limits: QueryLimits): Promise<Extract<WorkerMessage, { ok: true }>> {
  // Keep runtime resolution out of the server bundle so the worker receives a real filesystem path.
  const runtimeRequire = typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : createRequire(__filename);
  const databaseEntryPath = runtimeRequire.resolve(DATABASE_PACKAGE);
  const databaseModulePath = dirname(dirname(databaseEntryPath));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=64", "-e", QUERY_WORKER_SOURCE], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" },
    });
    let settled = false;
    let stdout = "";
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      terminate(child);
      finish(() => reject(new QueryExecutionError("QUERY_TIMEOUT")));
    }, limits.timeoutMs);
    timer.unref();

    child.once("error", () => finish(() => reject(new QueryExecutionError("QUERY_PROCESS_ERROR"))));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > limits.maxResponseBytes + 16 * 1024) {
        terminate(child);
        finish(() => reject(new QueryExecutionError("QUERY_RESPONSE_LIMIT")));
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        try {
          const message = JSON.parse(stdout) as WorkerMessage;
          if (message.ok) finish(() => resolve(message));
          else finish(() => reject(new QueryExecutionError(message.code, message.message)));
        } catch {
          finish(() => reject(new QueryExecutionError(
            "QUERY_PROCESS_ERROR",
            `The isolated query process exited unexpectedly (${code})`,
          )));
        }
      }
    });
    child.stdin.end(JSON.stringify({ dbPath, sql: guarded.executedSql, limits, databaseModulePath }));
  });
}

function failure(queryId: string, source: QuerySource, startedAt: number, error: unknown): QueryFailure {
  const known = error instanceof QueryExecutionError;
  return {
    ok: false,
    rows: [],
    error: {
      code: known ? error.code : "QUERY_EXECUTION_ERROR",
      message: known ? error.message : ERROR_MESSAGES.QUERY_EXECUTION_ERROR,
    },
    executedSql: null,
    meta: { queryId, source, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 },
  };
}

export async function executeGuardedQuery(
  dbPath: string,
  guarded: GuardedSql,
  options: QueryExecutionOptions = {},
): Promise<QueryEnvelope> {
  const queryId = randomUUID();
  const source = options.source ?? "internal";
  const limits = normalizeQueryLimits(options);
  const startedAt = performance.now();

  let result: Extract<WorkerMessage, { ok: true }>;
  try {
    result = await semaphore.execute(() => {
      const remainingMs = limits.timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) throw new QueryExecutionError("QUERY_TIMEOUT");
      return runWorker(dbPath, guarded, { ...limits, timeoutMs: remainingMs });
    }, limits.timeoutMs);
  } catch (error) {
    const envelope = failure(queryId, source, startedAt, error);
    try {
      const auditEvent = await appendQueryAuditEvent({
        queryId,
        source,
        outcome: envelope.error.code === "QUERY_TIMEOUT" ? "timeout" : "failed",
        sql: guarded.executedSql,
        tables: guarded.tables,
        durationMs: envelope.meta.durationMs,
        errorCode: envelope.error.code,
      });
      envelope.meta.auditEventId = auditEvent.eventId;
    } catch {
      envelope.error = {
        code: "QUERY_AUDIT_ERROR",
        message: ERROR_MESSAGES.QUERY_AUDIT_ERROR,
      };
    }
    return envelope;
  }

  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  const resultHash = createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
  let auditEventId: string;
  try {
    const auditEvent = await appendQueryAuditEvent({
      queryId,
      source,
      outcome: "success",
      sql: guarded.executedSql,
      tables: guarded.tables,
      durationMs,
      meta: { rowCount: result.rows.length, responseBytes: result.responseBytes, resultHash },
    });
    auditEventId = auditEvent.eventId;
  } catch {
    return failure(queryId, source, startedAt, new QueryExecutionError("QUERY_AUDIT_ERROR"));
  }

  return {
    ok: true,
    rows: result.rows,
    error: null,
    executedSql: guarded.executedSql,
    meta: {
      queryId,
      auditEventId,
      source,
      tables: guarded.tables,
      rowCount: result.rows.length,
      columnCount: result.columnCount,
      responseBytes: result.responseBytes,
      resultHash,
      durationMs,
      limit: guarded.limit,
      truncated: guarded.limit > 0 && result.rows.length >= Math.min(guarded.limit, limits.maxRows),
    },
  };
}
