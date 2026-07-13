import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  assertTokenBudgetAvailable,
  closeTokenLedgerForTests,
  getTokenLedgerSnapshot,
  releaseTokenReservation,
  reserveTokenBudget,
  settleTokenReservation,
} from "../src/lib/token-ledger";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "coforge-token-ledger-"));
  process.env.COFORGE_TOKEN_LEDGER_PATH = path.join(directory, "ledger.sqlite");
});

afterEach(() => {
  closeTokenLedgerForTests();
  delete process.env.COFORGE_TOKEN_LEDGER_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe("atomic token ledger", () => {
  it("checks budget availability without inventing a provider usage reservation", () => {
    const id = reserveTokenBudget(100, 100);
    expect(() => assertTokenBudgetAvailable(100)).toThrow(/budget exhausted/);
    releaseTokenReservation(id);
    expect(() => assertTokenBudgetAvailable(100)).not.toThrow();
    expect(getTokenLedgerSnapshot().reservedTokens).toBe(0);
  });

  it("reserves before provider work and refuses overbooking", () => {
    const first = reserveTokenBudget(70, 100);
    expect(getTokenLedgerSnapshot().reservedTokens).toBe(70);
    expect(() => reserveTokenBudget(31, 100)).toThrow(/budget exhausted/);
    releaseTokenReservation(first);
    expect(getTokenLedgerSnapshot().reservedTokens).toBe(0);
  });

  it("settles actual usage once and clears the reservation", () => {
    const id = reserveTokenBudget(80, 100);
    settleTokenReservation(id, { promptTokens: 20, completionTokens: 30, totalTokens: 50 });
    const snapshot = getTokenLedgerSnapshot();
    expect(snapshot).toMatchObject({ promptTokens: 20, completionTokens: 30, totalTokens: 50, requestCount: 1, reservedTokens: 0 });
    expect(() => settleTokenReservation(id, { totalTokens: 5 })).toThrow(/not found/);
  });

  it("records provider-reported overrun exactly and blocks future reservations", () => {
    const id = reserveTokenBudget(80, 100);
    settleTokenReservation(id, { totalTokens: 150 });
    expect(getTokenLedgerSnapshot()).toMatchObject({
      totalTokens: 150,
      reservedTokens: 0,
      reservationOverrunTokens: 70,
    });
    expect(() => reserveTokenBudget(1, 100)).toThrow(/budget exhausted/);
  });

  it("keeps concurrent settlements within the budget snapshot", () => {
    const first = reserveTokenBudget(40, 100);
    const second = reserveTokenBudget(60, 100);
    settleTokenReservation(first, { totalTokens: 40 });
    settleTokenReservation(second, { totalTokens: 60 });
    expect(getTokenLedgerSnapshot()).toMatchObject({ totalTokens: 100, reservedTokens: 0 });
  });
});
