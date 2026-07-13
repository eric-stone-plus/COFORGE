import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdate,
} from "../src/lib/reasonix/acp-client";
import { ReasonixAcpClient } from "../src/lib/reasonix/acp-client";
import { resolve } from "path";
import {
  isReasonixDeepSeekProvider,
  isReasonixDesktopEnabled,
  reasonixDesktopConfigurationFromEnvironment,
  ReasonixRuntimeOrchestrator,
} from "../src/lib/reasonix/orchestrator";
import { closeTokenLedgerForTests } from "../src/lib/token-ledger";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-reasonix-orchestrator-"));
  process.env.COFORGE_TOKEN_LEDGER_PATH = join(tempDir, "token-ledger.sqlite");
});

afterEach(async () => {
  closeTokenLedgerForTests();
  delete process.env.COFORGE_TOKEN_LEDGER_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

function configuration() {
  return {
    packageRoot: join(tempDir, "resources", "reasonix"),
    integrityManifestPath: join(tempDir, "resources", "reasonix", "packaged-manifest.json"),
    applicationDataDir: join(tempDir, "support"),
    nodeBinary: process.execPath,
    mcpEntrypoint: join(tempDir, "resources", "app", "coforge-mcp-server.cjs"),
    dbPath: join(tempDir, "resources", "data", "coal-demo.db"),
    auditPath: join(tempDir, "support", "audit", "query-events.jsonl"),
    mcpAuditPath: join(tempDir, "support", "audit", "mcp-events.jsonl"),
  };
}

class FakeClient {
  pid: number | undefined = 123;
  sessionId: string | undefined;
  recoverySessionId: string | undefined;

  constructor(private readonly onUpdate: (update: AcpSessionUpdate) => void) {}

  async start() {}

  async newSession(): Promise<AcpSessionNewResult> {
    this.sessionId = "session-fixture";
    this.recoverySessionId = this.sessionId;
    return { sessionId: this.sessionId };
  }

  async restartSession(sessionId = this.recoverySessionId): Promise<void> {
    this.pid = 124;
    this.sessionId = sessionId;
  }

  async prompt(text: string): Promise<AcpPromptResult> {
    const sessionId = this.sessionId!;
    if (text === "query") {
      this.onUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "mcp__coforge__query",
          status: "pending",
        },
      });
      const meta = {
        queryId: "query-1",
        auditEventId: "audit-1",
        source: "agent",
        tables: ["cargoes"],
        rowCount: 1,
        columnCount: 1,
        responseBytes: 20,
        resultHash: "b".repeat(64),
        durationMs: 1,
        limit: 1,
        truncated: true,
      };
      const envelope = {
        schemaVersion: 1,
        tool: "query",
        operation: "select",
        result: { ok: true, rows: [{ vessel_name: "Fixture" }], executedSql: "SELECT vessel_name FROM cargoes LIMIT 1", meta },
        evidence: {
          callId: "call-1",
          inputHash: "a".repeat(64),
          resultHash: "c".repeat(64),
          auditEventId: "audit-1",
        },
      };
      this.onUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: JSON.stringify(envelope) } }],
        },
      });
    }
    this.onUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${text}` } },
    });
    return { stopReason: "end_turn" };
  }

  async stop() {
    this.pid = undefined;
    this.sessionId = undefined;
  }
}

describe("Reasonix desktop orchestration", () => {
  it("enables the desktop runtime by default and accepts an explicit rollback flag", () => {
    expect(isReasonixDesktopEnabled({ COFORGE_DESKTOP: "1" })).toBe(true);
    expect(isReasonixDesktopEnabled({ COFORGE_DESKTOP: "1", COFORGE_REASONIX_ENABLED: "1" })).toBe(true);
    expect(isReasonixDesktopEnabled({ COFORGE_DESKTOP: "1", COFORGE_REASONIX_ENABLED: "0" })).toBe(false);
    expect(isReasonixDesktopEnabled({ COFORGE_REASONIX_ENABLED: "1" })).toBe(false);
  });

  it("passes only the exact official DeepSeek Pro provider into Reasonix", () => {
    expect(isReasonixDeepSeekProvider({
      backend: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
    })).toBe(true);
    expect(isReasonixDeepSeekProvider({
      backend: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
    })).toBe(false);
    expect(isReasonixDeepSeekProvider({
      backend: "openai-compatible",
      baseURL: "https://api.deepseek.com.evil.example",
      model: "deepseek-v4-pro",
    })).toBe(false);
    expect(isReasonixDeepSeekProvider({
      backend: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      model: "another-model",
    })).toBe(false);
    for (const baseURL of [
      "http://api.deepseek.com",
      "https://user@api.deepseek.com",
      "https://api.deepseek.com:8443",
      "https://api.deepseek.com/proxy",
      "https://api.deepseek.com?",
      "https://api.deepseek.com?target=other",
      "https://api.deepseek.com#",
      "https://api.deepseek.com/#fragment",
    ]) {
      expect(isReasonixDeepSeekProvider({
        backend: "openai-compatible",
        baseURL,
        model: "deepseek-v4-pro",
      })).toBe(false);
    }
    for (const baseURL of [
      "https://api.deepseek.com/",
      "https://api.deepseek.com:443/v1",
      "https://API.DEEPSEEK.COM/v1/",
    ]) {
      expect(isReasonixDeepSeekProvider({
        backend: "openai-compatible",
        baseURL,
        model: "deepseek-v4-pro",
      })).toBe(true);
    }
  });

  it("validates every packaged runtime path and keeps audit output in app data", async () => {
    const resources = join(tempDir, "resources");
    const support = join(tempDir, "support");
    const paths = {
      node: join(resources, "node", "bin", "node"),
      mcp: join(resources, "app", "coforge-mcp-server.cjs"),
      db: join(resources, "data", "coal-demo.db"),
      reasonix: join(resources, "reasonix"),
      integrityManifest: join(resources, "reasonix", "packaged-manifest.json"),
    };
    await Promise.all([
      mkdir(join(resources, "node", "bin"), { recursive: true }),
      mkdir(join(resources, "app"), { recursive: true }),
      mkdir(join(resources, "data"), { recursive: true }),
      mkdir(paths.reasonix, { recursive: true }),
      mkdir(support, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(paths.node, "fixture"),
      writeFile(paths.mcp, "fixture"),
      writeFile(paths.db, "fixture"),
      writeFile(paths.integrityManifest, "{}"),
    ]);
    await chmod(paths.node, 0o700);
    const env = {
      COFORGE_DESKTOP: "1",
      COFORGE_REASONIX_ENABLED: "1",
      COFORGE_RESOURCES_DIR: resources,
      COFORGE_CONFIG_DIR: support,
      COFORGE_REASONIX_PACKAGE_ROOT: paths.reasonix,
      COFORGE_REASONIX_INTEGRITY_MANIFEST: paths.integrityManifest,
      COFORGE_NODE_BINARY: paths.node,
      COFORGE_MCP_ENTRYPOINT: paths.mcp,
      DB_PATH: paths.db,
    };

    const configured = await reasonixDesktopConfigurationFromEnvironment(env);
    expect(configured.packageRoot).toMatch(/resources\/reasonix$/);
    expect(configured.integrityManifestPath).toBe(
      await import("fs/promises").then(({ realpath }) => realpath(paths.integrityManifest)),
    );
    expect(configured.auditPath).toBe(join(configured.applicationDataDir, "audit", "query-events.jsonl"));
    expect(configured.mcpAuditPath).toBe(join(configured.applicationDataDir, "audit", "mcp-events.jsonl"));
    await expect(reasonixDesktopConfigurationFromEnvironment({
      ...env,
      COFORGE_QUERY_AUDIT_PATH: join(tempDir, "escaped-audit.jsonl"),
    })).rejects.toThrow(/audit path/);
    await expect(reasonixDesktopConfigurationFromEnvironment({
      ...env,
      COFORGE_MCP_AUDIT_PATH: join(tempDir, "escaped-mcp-audit.jsonl"),
    })).rejects.toThrow(/MCP call audit path/);
  });

  it("serializes turns and exposes only authenticated MCP evidence", async () => {
    let client: FakeClient | undefined;
    const updates: string[] = [];
    const orchestrator = new ReasonixRuntimeOrchestrator(configuration(), async (_key, onUpdate) => {
      client = new FakeClient(onUpdate);
      return client;
    });

    const [query, chat] = await Promise.all([
      orchestrator.runTurn("query", { apiKey: "fixture-key", monthlyTokenBudget: 100, onUpdate: (update) => updates.push(update.update.sessionUpdate) }),
      orchestrator.runTurn("chat", { apiKey: "fixture-key", monthlyTokenBudget: 100 }),
    ]);

    expect(client).toBeDefined();
    expect(query).toMatchObject({
      explanation: "answer:query",
      sql: "SELECT vessel_name FROM cargoes LIMIT 1",
      data: [{ vessel_name: "Fixture" }],
      evidence: { queryId: "query-1", auditEventId: "audit-1" },
      runtime: {
        engine: "reasonix",
        sessionId: "session-fixture",
        usageUnavailable: true,
        evidenceUnavailable: false,
        mcpCalls: [{ tool: "query", acpToolCallId: "call-1", callId: "call-1" }],
      },
    });
    expect(chat).toMatchObject({
      explanation: "answer:chat",
      runtime: { evidenceUnavailable: true, mcpCalls: [] },
    });
    expect(updates).toEqual(["tool_call", "tool_call_update", "agent_message_chunk"]);
    await orchestrator.stop();
  });

  it("refuses a turn when the monthly budget has no capacity", async () => {
    const { reserveTokenBudget } = await import("../src/lib/token-ledger");
    reserveTokenBudget(100, 100);
    const orchestrator = new ReasonixRuntimeOrchestrator(configuration(), async (_key, onUpdate) => new FakeClient(onUpdate));
    await expect(orchestrator.runTurn("chat", {
      apiKey: "fixture-key",
      monthlyTokenBudget: 100,
    })).rejects.toThrow(/budget exhausted/);
    await orchestrator.stop();
  });

  it("stops an active client immediately instead of waiting for a hung turn", async () => {
    let resolvePrompt: ((value: AcpPromptResult) => void) | undefined;
    let stopped = false;
    const orchestrator = new ReasonixRuntimeOrchestrator(configuration(), async () => ({
      pid: 123,
      sessionId: "session-fixture",
      async start() {},
      async newSession() { return { sessionId: "session-fixture" }; },
      async restartSession() {},
      prompt: () => new Promise<AcpPromptResult>((resolvePromptResult) => { resolvePrompt = resolvePromptResult; }),
      async stop() {
        stopped = true;
        resolvePrompt?.({ stopReason: "cancelled" });
      },
    }));

    const turn = orchestrator.runTurn("hang", { apiKey: "fixture-key", monthlyTokenBudget: 100 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await orchestrator.stop();
    expect(stopped).toBe(true);
    await expect(turn).rejects.toThrow(/without an assistant message/);
  });

  it("restarts after abort before accepting another turn and ignores late output", async () => {
    const home = join(tempDir, "acp-home");
    await mkdir(join(home, "workspace"), { recursive: true });
    const fixture = resolve("tests/fixtures/fake-reasonix-acp.js");
    let created = 0;
    const orchestrator = new ReasonixRuntimeOrchestrator(configuration(), async (_key, onUpdate) => {
      created += 1;
      return new ReasonixAcpClient({
        binaryPath: fixture,
        cwd: join(home, "workspace"),
        env: { ...process.env, NODE_ENV: "test", REASONIX_HOME: home },
        credentialBridgePath: join(home, ".env"),
        apiKey: "fixture-key",
        mcp: { command: process.execPath, args: [fixture] },
        requestTimeoutMs: 2_000,
        onUpdate,
      });
    });
    const abort = new AbortController();
    const cancelled = orchestrator.runTurn("delayed-cancel", {
      apiKey: "fixture-key",
      monthlyTokenBudget: 100,
      signal: abort.signal,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "ABORTED" });

    const fresh = await orchestrator.runTurn("fresh-after-cancel", {
      apiKey: "fixture-key",
      monthlyTokenBudget: 100,
    });
    expect(created).toBe(1);
    expect(fresh).toMatchObject({
      explanation: "echo:fresh-after-cancel",
      runtime: { sessionId: "fixture-1", evidenceUnavailable: true, mcpCalls: [] },
    });
    expect(fresh.explanation).not.toContain("stale");
    expect(fresh.sql).toBeUndefined();
    expect(fresh.data).toBeUndefined();
    await orchestrator.stop();
  });

  it("rejects queued turns during shutdown without spawning a replacement client", async () => {
    let resolvePrompt: ((value: AcpPromptResult) => void) | undefined;
    let clientCount = 0;
    const orchestrator = new ReasonixRuntimeOrchestrator(configuration(), async () => {
      clientCount += 1;
      return {
        pid: 123,
        sessionId: "session-fixture",
        async start() {},
        async newSession() { return { sessionId: "session-fixture" }; },
        async restartSession() {},
        prompt: () => new Promise<AcpPromptResult>((resolvePromptResult) => { resolvePrompt = resolvePromptResult; }),
        async stop() { resolvePrompt?.({ stopReason: "cancelled" }); },
      };
    });

    const active = orchestrator.runTurn("active", { apiKey: "fixture-key", monthlyTokenBudget: 100 });
    const queued = orchestrator.runTurn("queued", { apiKey: "fixture-key", monthlyTokenBudget: 100 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await orchestrator.stop();
    await expect(active).rejects.toThrow(/without an assistant message/);
    await expect(queued).rejects.toThrow(/runtime is stopping/);
    expect(clientCount).toBe(1);
  });
});
