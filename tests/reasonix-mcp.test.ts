import { PassThrough } from "stream";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCoforgeMcpRequest, MCP_MAX_FRAME_BYTES, mcpContextFromEnvironment, NdjsonFrameDecoder } from "../src/lib/reasonix/mcp-server";
import { COFORGE_MCP_TOOLS, callCoforgeMcpTool, listCoforgeMcpTools } from "../src/lib/reasonix/mcp-tools";
import { resetMcpAuditQueueForTests } from "../src/lib/reasonix/mcp-audit";

function context() {
  return { role: "desktop" as const, auditPath: process.env.COFORGE_MCP_AUDIT_PATH! };
}
const originalEnv = { ...process.env };
let tempDir = "";

beforeEach(async () => {
  resetMcpAuditQueueForTests();
  process.env = { ...originalEnv };
  tempDir = await mkdtemp(join(tmpdir(), "coforge-mcp-audit-"));
  process.env.COFORGE_MCP_AUDIT_PATH = join(tempDir, "audit", "mcp-events.jsonl");
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await rm(tempDir, { recursive: true, force: true });
});

describe("COFORGE MCP protocol", () => {
  it("implements initialize and advertises only the nine first-party read-only tools", async () => {
    const initialized = await handleCoforgeMcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" },
    }, context());
    expect(initialized).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "coforge" },
      },
    });

    const listed = await handleCoforgeMcpRequest({ jsonrpc: "2.0", id: "list", method: "tools/list" }, context());
    const result = listed && "result" in listed ? listed.result as { tools: ReturnType<typeof listCoforgeMcpTools> } : null;
    expect(result?.tools.map((tool) => tool.name)).toEqual([
      "schema", "query", "bidding", "sourcing", "freight", "laytime", "inventory", "blending", "coswap",
    ]);
    expect(result?.tools.every((tool) => (
      tool.annotations.readOnlyHint
      && tool.annotations.destructiveHint === false
      && tool.annotations.openWorldHint === false
      && tool.inputSchema.additionalProperties === false || tool.inputSchema.oneOf !== undefined
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DB_PATH|databaseModulePath|filesystem|\/Users\//);
  });

  it("returns JSON-RPC errors for protocol faults and in-band errors for tool validation", async () => {
    await expect(handleCoforgeMcpRequest({ jsonrpc: "2.0", id: 2, method: "unknown" }, context())).resolves.toMatchObject({
      id: 2, error: { code: -32601 },
    });
    await expect(handleCoforgeMcpRequest({
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "not-a-tool", arguments: {} },
    }, context())).resolves.toMatchObject({ id: 3, error: { code: -32602 } });
    const invalid = await handleCoforgeMcpRequest({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "query", arguments: { sql: "SELECT name FROM suppliers", dbPath: "/private.db" } },
    }, context());
    expect(invalid).toMatchObject({ id: 4, result: { isError: true } });
    expect(JSON.stringify(invalid)).toContain("arguments.dbPath is not allowed");
    const rejectedEvents = (await readFile(process.env.COFORGE_MCP_AUDIT_PATH!, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(rejectedEvents).toMatchObject([
      { tool: "not-a-tool", outcome: "rejected", errorCode: "TOOL_NOT_FOUND" },
      { tool: "query", outcome: "rejected", errorCode: "SCHEMA_REJECTED" },
    ]);
    await expect(handleCoforgeMcpRequest({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }, context())).resolves.toMatchObject({
      id: 5, error: { code: -32602 },
    });
    await expect(handleCoforgeMcpRequest({ jsonrpc: "2.0", id: 6, method: "tools/list", params: { cursor: "hidden" } }, context())).resolves.toMatchObject({
      id: 6, error: { code: -32602 },
    });
  });

  it("does not reply to notifications", async () => {
    await expect(handleCoforgeMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, context())).resolves.toBeNull();
  });

  it("fails closed when the host does not explicitly inject an authorized role", () => {
    delete process.env.COFORGE_MCP_ROLE;
    expect(() => mcpContextFromEnvironment()).toThrow("must explicitly be analyst, admin, or desktop");
    process.env.COFORGE_MCP_ROLE = "anonymous";
    expect(() => mcpContextFromEnvironment()).toThrow();
    expect(() => mcpContextFromEnvironment({ ...process.env, COFORGE_MCP_ROLE: "analyst" })).not.toThrow();
  });

  it("frames split NDJSON input and rejects an oversized unterminated frame", async () => {
    const input = new PassThrough();
    const decoder = input.pipe(new NdjsonFrameDecoder(128));
    const frames: unknown[] = [];
    decoder.on("data", (frame) => frames.push(frame));
    input.write('{"jsonrpc":"2.0","id":1,');
    input.end('"method":"tools/list"}\n');
    await new Promise<void>((resolve, reject) => decoder.on("end", resolve).on("error", reject));
    expect(frames).toEqual([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);

    const oversized = new NdjsonFrameDecoder(8);
    const error = new Promise<Error>((resolve) => oversized.once("error", resolve));
    oversized.write(Buffer.alloc(9, "x"));
    await expect(error).resolves.toMatchObject({ message: "MCP frame exceeds the byte limit." });
    expect(MCP_MAX_FRAME_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("COFORGE MCP tools", () => {
  it("publishes strict, bounded schemas for every business engine", () => {
    expect(COFORGE_MCP_TOOLS).toHaveLength(9);
    for (const tool of COFORGE_MCP_TOOLS) {
      const serialized = JSON.stringify(tool.inputSchema);
      expect(serialized).toContain('"additionalProperties":false');
      expect(serialized).not.toContain('"path"');
      expect(serialized).not.toContain('"url"');
      expect(serialized).not.toContain('"command"');
    }
  });

  it.each([
    ["bidding", { operation: "calculate", input: { incoterm: "FOB", priceUsdPerMt: 80, quantityMt: 10_000, narKcalPerKg: 5_500, exchangeRateCnyPerUsd: 7.1 } }],
    ["sourcing", { operation: "inventory_position", input: { inventoryMt: 35_000, dailyConsumptionMt: 1_000 } }],
    ["freight", { operation: "voyage-cost", input: { cargoMt: 10_000, seaDistanceNm: 240, ladenSpeedKnots: 10, portDays: 1, ladenConsumptionMtPerDay: 20, portConsumptionMtPerDay: 3, vlsfoPriceUsdPerMt: 600 } }],
    ["laytime", { operation: "calculate", input: { laytimeStart: "2026-01-01T00:00:00Z", operationsComplete: "2026-01-02T00:00:00Z", allowedHours: 24, demurrageRateUsdPerDay: 10_000, events: [] } }],
    ["inventory", { operation: "rolling-plan", input: { initialInventoryMt: 0, stepMt: 10, defaultStorageCapacityMt: 100, periods: [{ id: "p", demandMt: 10, purchaseCostUsdPerMt: 1, maxPurchaseMt: 10 }] } }],
    ["blending", { operation: "optimize", input: { sources: [{ id: "s", availableMt: 100, costUsdPerMt: 1, narKcalPerKg: 5_000, sulfurPct: 0.5, ashPct: 10, totalMoisturePct: 12 }], requirements: { targetMt: 100, stepMt: 10, minNarKcalPerKg: 5_000, maxSulfurPct: 0.5, maxAshPct: 10, maxTotalMoisturePct: 12 } } }],
    ["coswap", { operation: "rank-swaps", input: { delayedShipments: [{ id: "d", deliveryWindowStart: "2026-01-01T00:00:00Z", deliveryWindowEnd: "2026-01-02T00:00:00Z", allowedPorts: ["p"], requiredQuantityMt: 1_000 }], candidates: [{ id: "c", deliveryTime: "2026-01-01T12:00:00Z", port: "P", quantityMt: 1_000, costUsdPerMt: 1 }] } }],
  ] as const)("reuses the existing %s business executor", async (name, argumentsValue) => {
    await expect(callCoforgeMcpTool(name, argumentsValue, context())).resolves.toBeTruthy();
  });

  it("rejects undeclared nested fields before the business executor runs", async () => {
    await expect(callCoforgeMcpTool("freight", {
      operation: "voyage-cost",
      input: {
        cargoMt: 10_000, seaDistanceNm: 240, ladenSpeedKnots: 10, portDays: 1,
        ladenConsumptionMtPerDay: 20, portConsumptionMtPerDay: 3, vlsfoPriceUsdPerMt: 600,
        arbitraryPath: "/etc/passwd",
      },
    }, context())).rejects.toThrow("arguments.input.arbitraryPath is not allowed");
  });

  it("returns a stable evidence envelope without echoing the raw input", async () => {
    const result = await callCoforgeMcpTool("freight", {
      operation: "voyage-cost",
      input: {
        cargoMt: 10_000, seaDistanceNm: 240, ladenSpeedKnots: 10, portDays: 1,
        ladenConsumptionMtPerDay: 20, portConsumptionMtPerDay: 3, vlsfoPriceUsdPerMt: 600,
      },
    }, context()) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      tool: "freight",
      operation: "voyage-cost",
      evidence: {
        callId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        auditEventId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      },
    });
    expect(result).not.toHaveProperty("input");
    const events = (await readFile(process.env.COFORGE_MCP_AUDIT_PATH!, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      callId: (result.evidence as Record<string, unknown>).callId,
      tool: "freight",
      operation: "voyage-cost",
      role: "desktop",
      outcome: "success",
      inputHash: (result.evidence as Record<string, unknown>).inputHash,
      resultHash: (result.evidence as Record<string, unknown>).resultHash,
      eventId: (result.evidence as Record<string, unknown>).auditEventId,
    });
    expect(JSON.stringify(events[0])).not.toContain("cargoMt");
  });
});
