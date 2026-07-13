import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

export type TokenUsageInput = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestCount?: number;
};

export type TokenLedgerSnapshot = {
  period: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  reservedTokens: number;
  reservationOverrunTokens: number;
  updatedAt: string;
};

const DEFAULT_BUDGET = 100_000;
const RESERVATION_TTL_MS = 10 * 60_000;
let ledger: Database.Database | null = null;
let ledgerPath = "";

function configDir() {
  return process.env.COFORGE_CONFIG_DIR || path.join(os.homedir(), ".coforge");
}

export function resolveTokenLedgerPath() {
  return process.env.COFORGE_TOKEN_LEDGER_PATH || path.join(configDir(), "token-ledger.sqlite");
}

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function positiveInt(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function getLedger() {
  const requestedPath = resolveTokenLedgerPath();
  if (ledger && requestedPath === ledgerPath) return ledger;
  ledger?.close();
  mkdirSync(path.dirname(requestedPath), { recursive: true, mode: 0o700 });
  ledger = new Database(requestedPath);
  ledgerPath = requestedPath;
  ledger.pragma("journal_mode = WAL");
  ledger.pragma("busy_timeout = 5000");
  ledger.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      period TEXT PRIMARY KEY,
      prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
      request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_reservations (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
      monthly_budget INTEGER NOT NULL CHECK (monthly_budget > 0),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_reservations_period_idx ON token_reservations(period);
  `);
  const reservationColumns = ledger.prepare("PRAGMA table_info(token_reservations)").all() as Array<{ name: string }>;
  if (!reservationColumns.some((column) => column.name === "monthly_budget")) {
    ledger.exec(`
      ALTER TABLE token_reservations ADD COLUMN monthly_budget INTEGER NOT NULL DEFAULT ${DEFAULT_BUDGET};
    `);
  }
  return ledger;
}

function cleanupExpired(db: Database.Database, period: string) {
  db.prepare("DELETE FROM token_reservations WHERE period != ? OR created_at < ?")
    .run(period, Date.now() - RESERVATION_TTL_MS);
}

function normalizedUsage(input: TokenUsageInput) {
  const promptTokens = positiveInt(input.promptTokens);
  const completionTokens = positiveInt(input.completionTokens);
  const totalTokens = positiveInt(input.totalTokens, promptTokens + completionTokens);
  const requestCount = totalTokens ? positiveInt(input.requestCount, 1) : 0;
  return { promptTokens, completionTokens, totalTokens, requestCount };
}

export function migrateLegacyTokenUsage(input: TokenUsageInput & { period?: string }) {
  const db = getLedger();
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM token_meta WHERE key = 'legacy_usage_migrated'").get()) return;
    const usage = normalizedUsage(input);
    if (usage.totalTokens && input.period === currentPeriod()) {
      db.prepare(`
        INSERT INTO token_usage(period, prompt_tokens, completion_tokens, total_tokens, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(period) DO NOTHING
      `).run(currentPeriod(), usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.requestCount, new Date().toISOString());
    }
    db.prepare("INSERT INTO token_meta(key, value) VALUES ('legacy_usage_migrated', ?)")
      .run(new Date().toISOString());
  }).immediate();
}

export function getTokenLedgerSnapshot(): TokenLedgerSnapshot {
  const db = getLedger();
  const period = currentPeriod();
  cleanupExpired(db, period);
  const usage = db.prepare(`
    SELECT prompt_tokens, completion_tokens, total_tokens, request_count, updated_at
    FROM token_usage WHERE period = ?
  `).get(period) as {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    request_count: number;
    updated_at: string;
  } | undefined;
  const reserved = db.prepare("SELECT COALESCE(SUM(reserved_tokens), 0) AS value FROM token_reservations WHERE period = ?")
    .get(period) as { value: number };
  const reservationOverrun = db.prepare("SELECT value FROM token_meta WHERE key = ?")
    .get(`reservation_overrun_tokens:${period}`) as { value: string } | undefined;
  return {
    period,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    requestCount: usage?.request_count ?? 0,
    reservedTokens: reserved.value,
    reservationOverrunTokens: positiveInt(reservationOverrun?.value),
    updatedAt: usage?.updated_at ?? new Date().toISOString(),
  };
}

export function assertTokenBudgetAvailable(monthlyBudget = DEFAULT_BUDGET): void {
  const budget = positiveInt(monthlyBudget, DEFAULT_BUDGET);
  const db = getLedger();
  db.transaction(() => {
    const period = currentPeriod();
    cleanupExpired(db, period);
    const usage = db.prepare("SELECT total_tokens FROM token_usage WHERE period = ?")
      .get(period) as { total_tokens: number } | undefined;
    const reserved = db.prepare("SELECT COALESCE(SUM(reserved_tokens), 0) AS value FROM token_reservations WHERE period = ?")
      .get(period) as { value: number };
    if ((usage?.total_tokens ?? 0) + reserved.value >= budget) {
      throw new Error(`Token budget exhausted for ${period}`);
    }
  }).immediate();
}

export function reserveTokenBudget(maxTokens: number, monthlyBudget = DEFAULT_BUDGET) {
  const requested = positiveInt(maxTokens);
  const budget = positiveInt(monthlyBudget, DEFAULT_BUDGET);
  if (!requested) throw new Error("Token reservation must be positive");

  const db = getLedger();
  return db.transaction(() => {
    const period = currentPeriod();
    cleanupExpired(db, period);
    const usage = db.prepare("SELECT total_tokens FROM token_usage WHERE period = ?")
      .get(period) as { total_tokens: number } | undefined;
    const reserved = db.prepare("SELECT COALESCE(SUM(reserved_tokens), 0) AS value FROM token_reservations WHERE period = ?")
      .get(period) as { value: number };
    if ((usage?.total_tokens ?? 0) + reserved.value + requested > budget) {
      throw new Error(`Token budget exhausted for ${period}`);
    }
    const id = randomUUID();
    db.prepare("INSERT INTO token_reservations(id, period, reserved_tokens, monthly_budget, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, period, requested, budget, Date.now());
    return id;
  }).immediate();
}

export function settleTokenReservation(id: string, input: TokenUsageInput) {
  const usage = normalizedUsage(input);
  if (!id) throw new Error("Token reservation id is required");
  const db = getLedger();
  db.transaction(() => {
    const reservation = db.prepare(`
      SELECT period, reserved_tokens, monthly_budget
      FROM token_reservations WHERE id = ?
    `).get(id) as { period: string; reserved_tokens: number; monthly_budget: number } | undefined;
    if (!reservation) throw new Error("Token reservation was not found");
    if (usage.totalTokens > reservation.reserved_tokens) {
      const excess = usage.totalTokens - reservation.reserved_tokens;
      db.prepare(`
        INSERT INTO token_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value
      `).run(`reservation_overrun_tokens:${reservation.period}`, excess);
    }
    // Provider usage is authoritative after a call completes. Record it exactly,
    // flag any reservation overrun, and let future reservations enforce the cap.
    db.prepare("DELETE FROM token_reservations WHERE id = ?").run(id);
    if (!usage.totalTokens) return;
    db.prepare(`
      INSERT INTO token_usage(period, prompt_tokens, completion_tokens, total_tokens, request_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(period) DO UPDATE SET
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + excluded.request_count,
        updated_at = excluded.updated_at
    `).run(
      reservation.period,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.requestCount,
      new Date().toISOString(),
    );
  }).immediate();
}

export function releaseTokenReservation(id: string) {
  if (!id) return;
  getLedger().prepare("DELETE FROM token_reservations WHERE id = ?").run(id);
}

export function recordTokenUsageAtomic(input: TokenUsageInput) {
  const usage = normalizedUsage(input);
  if (!usage.totalTokens) return;
  const reservation = reserveTokenBudget(usage.totalTokens, Number.MAX_SAFE_INTEGER);
  settleTokenReservation(reservation, usage);
}

export function resetTokenLedger() {
  const db = getLedger();
  db.transaction(() => {
    const period = currentPeriod();
    db.prepare("DELETE FROM token_reservations WHERE period = ?").run(period);
    db.prepare("DELETE FROM token_usage WHERE period = ?").run(period);
    db.prepare("DELETE FROM token_meta WHERE key = ?").run(`reservation_overrun_tokens:${period}`);
  }).immediate();
  return getTokenLedgerSnapshot();
}

export function closeTokenLedgerForTests() {
  ledger?.close();
  ledger = null;
  ledgerPath = "";
}
