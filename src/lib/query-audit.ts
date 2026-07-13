import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { QuerySource } from "./query-types";

export type QueryAuditEvent = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly queryId: string;
  readonly source: QuerySource;
  readonly outcome: "success" | "rejected" | "timeout" | "failed";
  readonly sqlHash: string;
  readonly tables: readonly string[];
  readonly durationMs: number;
  readonly rowCount?: number;
  readonly responseBytes?: number;
  readonly resultHash?: string;
  readonly errorCode?: string;
};

export type QueryAuditInput = {
  queryId: string;
  source: QuerySource;
  outcome: QueryAuditEvent["outcome"];
  sql: string;
  tables?: string[];
  durationMs: number;
  meta?: { rowCount: number; responseBytes: number; resultHash: string };
  errorCode?: string;
};

const AUDIT_FILE_MODE = 0o600;
let appendChain: Promise<void> = Promise.resolve();

export function resolveQueryAuditPath() {
  const configured = process.env.COFORGE_QUERY_AUDIT_PATH?.trim();
  return configured
    ? resolve(configured)
    : join(process.env.COFORGE_CONFIG_DIR || join(homedir(), ".coforge"), "audit", "query-events.jsonl");
}

export function redactSqlForAudit(sql: string) {
  return createHash("sha256").update(sql).digest("hex");
}

export function createQueryAuditEvent(input: QueryAuditInput): QueryAuditEvent {
  return Object.freeze({
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    queryId: input.queryId,
    source: input.source,
    outcome: input.outcome,
    sqlHash: redactSqlForAudit(input.sql),
    tables: Object.freeze([...new Set(input.tables ?? [])].sort()),
    durationMs: input.durationMs,
    ...(input.meta ? {
      rowCount: input.meta.rowCount,
      responseBytes: input.meta.responseBytes,
      resultHash: input.meta.resultHash,
    } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

async function appendEvent(path: string, event: QueryAuditEvent) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", AUDIT_FILE_MODE);
  try {
    await handle.chmod(AUDIT_FILE_MODE);
    await handle.appendFile(`${JSON.stringify(event)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function appendQueryAuditEvent(input: QueryAuditInput): Promise<QueryAuditEvent> {
  const path = resolveQueryAuditPath();
  const event = createQueryAuditEvent(input);
  const pending = appendChain.then(async () => {
    await appendEvent(path, event);
    return event;
  });
  appendChain = pending.then(() => undefined).catch((error) => {
    console.error("Unable to append query audit event", error instanceof Error ? error.message : "unknown error");
  });
  return pending;
}

export async function readQueryAuditEvents(path = resolveQueryAuditPath()): Promise<QueryAuditEvent[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents.split("\n").filter(Boolean).map((line) => {
      const parsed = JSON.parse(line) as QueryAuditEvent;
      return Object.freeze({ ...parsed, tables: Object.freeze([...parsed.tables]) });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
