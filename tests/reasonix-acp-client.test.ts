import { access, mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpSessionUpdate, ReasonixAcpClient } from "../src/lib/reasonix/acp-client";

const fixture = resolve("tests/fixtures/fake-reasonix-acp.js");
let tempDir: string;
let clients: ReasonixAcpClient[];

function client(overrides: Partial<ConstructorParameters<typeof ReasonixAcpClient>[0]> = {}) {
  const home = join(tempDir, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    REASONIX_HOME: home,
    ...(overrides.env ?? {}),
  };
  const instance = new ReasonixAcpClient({
    binaryPath: fixture,
    cwd: join(home, "workspace"),
    credentialBridgePath: join(home, ".env"),
    apiKey: "sk-private-fixture-key",
    mcp: { command: process.execPath, args: [fixture] },
    requestTimeoutMs: 2_000,
    ...overrides,
    env,
  });
  clients.push(instance);
  return instance;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-reasonix-acp-"));
  await import("fs/promises").then(({ mkdir }) => mkdir(join(tempDir, "home", "workspace"), { recursive: true }));
  clients = [];
});

afterEach(async () => {
  await Promise.all(clients.map((instance) => instance.stop()));
  await rm(tempDir, { recursive: true, force: true });
});

describe("Reasonix ACP stdio client", () => {
  it("initializes ACP v1 and injects only the first-party MCP into a new session", async () => {
    const instance = client();
    await writeFile(join(tempDir, "home", ".env"), "DEEPSEEK_API_KEY=stale\n");
    await expect(instance.start()).resolves.toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "reasonix", version: "fixture" },
    });
    await expect(access(join(tempDir, "home", ".env"))).rejects.toThrow();
    await expect(instance.newSession()).resolves.toMatchObject({ sessionId: "fixture-1" });
    await expect(access(join(tempDir, "home", ".env"))).rejects.toThrow();
  });

  it("clears workspace configuration before startup and again before a new session", async () => {
    const workspace = join(tempDir, "home", "workspace");
    await writeFile(join(workspace, "reasonix.toml"), 'permissions = "allow"\n');
    const instance = client();
    await instance.start();
    await expect(access(join(workspace, "reasonix.toml"))).rejects.toThrow();

    await mkdir(join(workspace, ".reasonix", "hooks"), { recursive: true });
    await writeFile(join(workspace, ".reasonix", "hooks", "startup"), "unsafe");
    await instance.newSession();
    await expect(access(join(workspace, ".reasonix"))).rejects.toThrow();
  });

  it("streams messages and permits only correlated COFORGE MCP tool updates", async () => {
    const updates: AcpSessionUpdate[] = [];
    const instance = client({ onUpdate: (update) => updates.push(update) });
    await instance.start();
    await instance.newSession();

    await expect(instance.prompt("mcp")).resolves.toEqual({ stopReason: "end_turn" });
    expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(updates[0].update.title).toBe("mcp__coforge__query");
  });

  it("cancels and rejects a turn that attempts any non-COFORGE tool", async () => {
    const violations: string[] = [];
    const instance = client({ onPolicyViolation: (tool) => violations.push(tool) });
    await instance.start();
    await instance.newSession();

    await expect(instance.prompt("unsafe")).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
    expect(violations).toEqual(["bash"]);
  });

  it("rejects a policy-violating turn without waiting for the runtime to finish", async () => {
    const instance = client();
    await instance.start();
    await instance.newSession();

    const outcome = Promise.race([
      instance.prompt("unsafe-hang"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("policy rejection timed out")), 250)),
    ]);
    await expect(outcome).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
  });

  it("sends session/cancel when an AbortSignal stops an active prompt", async () => {
    const instance = client();
    await instance.start();
    await instance.newSession();
    const abort = new AbortController();
    const prompt = instance.prompt("hang", abort.signal);
    abort.abort();

    await expect(prompt).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects direct slash skill, command, and MCP prompt invocation", async () => {
    const instance = client();
    await instance.start();
    await instance.newSession();
    await expect(instance.prompt("/review full")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
    await expect(instance.prompt(" /mcp__coforge__internal ")).rejects.toMatchObject({ code: "INVALID_PROMPT" });
  });

  it("retains a persisted session id across a crash and reloads it after restart", async () => {
    const instance = client();
    await instance.start();
    const { sessionId } = await instance.newSession();
    await expect(instance.prompt("crash")).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(instance.recoverySessionId).toBe(sessionId);

    const workspace = join(tempDir, "home", "workspace");
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { unsafe: {} } }));

    await instance.restartSession();
    await expect(access(join(workspace, ".mcp.json"))).rejects.toThrow();
    expect(instance.sessionId).toBe(sessionId);
    await expect(instance.prompt("recovered")).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("times out handshake requests and tears down cleanly", async () => {
    const instance = client({
      env: { ...process.env, NODE_ENV: "test", FAKE_ACP_MODE: "silent" },
      requestTimeoutMs: 25,
    });
    await expect(instance.start()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await expect(access(join(tempDir, "home", ".env"))).rejects.toThrow();
    await instance.stop();
  });

  it("removes a stale credential bridge even when the process crashes before initialize", async () => {
    await writeFile(join(tempDir, "home", ".env"), "DEEPSEEK_API_KEY=stale\n");
    const instance = client({
      env: { ...process.env, NODE_ENV: "test", FAKE_ACP_MODE: "crash-initialize" },
    });
    await expect(instance.start()).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    await expect(access(join(tempDir, "home", ".env"))).rejects.toThrow();
  });

  it("creates the session credential bridge as 0600 and removes it after the request", async () => {
    const instance = client({
      env: { ...process.env, NODE_ENV: "test", FAKE_ACP_SESSION_DELAY_MS: "30" },
    });
    await instance.start();
    const observation = new Promise<number>((resolveMode) => {
      const timer = setInterval(async () => {
        try {
          const metadata = await stat(join(tempDir, "home", ".env"));
          clearInterval(timer);
          resolveMode(metadata.mode & 0o777);
        } catch {
          // The exclusive bridge exists only while session/new is pending.
        }
      }, 1);
    });
    await instance.newSession();
    await expect(observation).resolves.toBe(0o600);
    await expect(access(join(tempDir, "home", ".env"))).rejects.toThrow();
  });

  it("fails a handshake when Reasonix reports a different ACP version", async () => {
    const instance = client({
      env: { ...process.env, NODE_ENV: "test", FAKE_ACP_MODE: "wrong-version" },
    });
    await expect(instance.start()).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(instance.pid).toBeUndefined();
  });
});
