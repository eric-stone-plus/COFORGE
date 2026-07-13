import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { open, rm } from "fs/promises";
import { dirname, resolve } from "path";
import { REASONIX_RELEASE } from "./manifest";
import {
  denyPermissionResult,
  firstPartyMcpServer,
  FirstPartyMcpOptions,
  isAllowedReasonixTool,
  ReasonixMcpServer,
} from "./policy";
import { resetReasonixWorkspace } from "./home";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AcpSessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: string;
    toolCallId?: string;
    title?: string;
    content?: unknown;
    status?: string;
    [key: string]: unknown;
  };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: JsonObject;
  agentInfo: { name: string; version?: string };
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: unknown[];
}

export interface AcpPromptResult {
  stopReason: "end_turn" | "cancelled" | "error";
  transcriptPath?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface ReasonixAcpClientOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  credentialBridgePath: string;
  apiKey: string;
  mcp: FirstPartyMcpOptions;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  onUpdate?: (update: AcpSessionUpdate) => void;
  onPermission?: (request: AcpPermissionRequest) => Promise<"allow_once" | "reject_once">;
  onPolicyViolation?: (toolName: string) => void;
  onStderr?: (text: string) => void;
  spawnProcess?: typeof spawn;
}

export class ReasonixAcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReasonixAcpError";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(frame: JsonRpcFrame): string {
  return typeof frame.error?.message === "string" ? frame.error.message : "Unknown ACP error";
}

function assertSessionUpdate(value: unknown): AcpSessionUpdate {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isRecord(value.update)) {
    throw new ReasonixAcpError("Malformed session/update notification", "PROTOCOL_ERROR");
  }
  if (typeof value.update.sessionUpdate !== "string") {
    throw new ReasonixAcpError("session/update is missing its discriminator", "PROTOCOL_ERROR");
  }
  return value as unknown as AcpSessionUpdate;
}

function assertPermissionRequest(value: unknown): AcpPermissionRequest {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isRecord(value.toolCall)) {
    throw new ReasonixAcpError("Malformed session/request_permission request", "PROTOCOL_ERROR");
  }
  if (typeof value.toolCall.toolCallId !== "string" || !Array.isArray(value.options)) {
    throw new ReasonixAcpError("Malformed permission request body", "PROTOCOL_ERROR");
  }
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      typeof option.optionId !== "string" ||
      typeof option.name !== "string" ||
      typeof option.kind !== "string"
    ) {
      throw new ReasonixAcpError("Malformed permission option", "PROTOCOL_ERROR");
    }
  }
  return value as unknown as AcpPermissionRequest;
}

function toolNameFromUpdate(update: AcpSessionUpdate): string | undefined {
  if (update.update.sessionUpdate !== "tool_call") return undefined;
  return typeof update.update.title === "string" ? update.update.title : "";
}

function permissionToolName(request: AcpPermissionRequest): string {
  return (request.toolCall.title ?? "").split(/\s/, 1)[0];
}

function assertInitializeResult(value: unknown): AcpInitializeResult {
  if (!isRecord(value) || typeof value.protocolVersion !== "number" || !isRecord(value.agentInfo)) {
    throw new ReasonixAcpError("Malformed initialize result", "PROTOCOL_ERROR");
  }
  if (typeof value.agentInfo.name !== "string" || !isRecord(value.agentCapabilities)) {
    throw new ReasonixAcpError("Malformed initialize capabilities", "PROTOCOL_ERROR");
  }
  return value as unknown as AcpInitializeResult;
}

function assertSessionNewResult(value: unknown): AcpSessionNewResult {
  if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new ReasonixAcpError("Reasonix returned an invalid session id", "PROTOCOL_ERROR");
  }
  return value as unknown as AcpSessionNewResult;
}

function assertPromptResult(value: unknown): AcpPromptResult {
  if (
    !isRecord(value) ||
    (value.stopReason !== "end_turn" && value.stopReason !== "cancelled" && value.stopReason !== "error")
  ) {
    throw new ReasonixAcpError("Malformed session/prompt result", "PROTOCOL_ERROR");
  }
  return value as unknown as AcpPromptResult;
}

export class ReasonixAcpClient {
  private readonly mcpServer: ReasonixMcpServer;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly spawnProcess: typeof spawn;
  private process?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private nextId = 0;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private stopping = false;
  private initialized = false;
  private activeSessionId?: string;
  private recoverableSessionId?: string;
  private allowedToolCalls = new Set<string>();
  private policyViolation?: ReasonixAcpError;
  private lastStderr = "";
  private credentialBridgePresent = false;

  constructor(private readonly options: ReasonixAcpClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.mcpServer = firstPartyMcpServer(options.mcp);
    if (resolve(dirname(options.credentialBridgePath)) !== resolve(options.env.REASONIX_HOME ?? "")) {
      throw new ReasonixAcpError("Credential bridge must be inside the isolated Reasonix home", "INVALID_HOME");
    }
    if (resolve(options.cwd) !== resolve(options.env.REASONIX_HOME ?? "", "workspace")) {
      throw new ReasonixAcpError("ACP cwd must be the isolated Reasonix workspace", "INVALID_HOME");
    }
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  get recoverySessionId(): string | undefined {
    return this.recoverableSessionId;
  }

  async start(): Promise<AcpInitializeResult> {
    if (this.process) throw new ReasonixAcpError("Reasonix ACP process is already running", "ALREADY_STARTED");
    await this.resetWorkspace();
    this.stopping = false;
    this.lastStderr = "";
    this.stdoutBuffer = Buffer.alloc(0);
    this.policyViolation = undefined;
    await this.removeCredentialBridge();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(
        this.options.binaryPath,
        ["acp", "--model", "deepseek-pro", "--profile", "balanced"],
        {
          cwd: this.options.cwd,
          env: this.options.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      await this.removeCredentialBridge();
      throw new ReasonixAcpError("Reasonix ACP failed to start", "SPAWN_FAILED", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    this.process = child;
    child.once("error", (error) => this.failProcess("Reasonix ACP failed to start", error, child));
    child.once("exit", (code, signal) => {
      const detail = this.lastStderr.trim();
      this.failProcess(
        `Reasonix ACP exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : ""}`,
        undefined,
        child,
      );
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.lastStderr = (this.lastStderr + chunk).slice(-8_192);
      this.options.onStderr?.(chunk);
    });

    child.stdout.on("data", (chunk: Buffer | string) => this.handleStdoutChunk(child, chunk));
    child.stdout.once("end", () => {
      if (!this.stopping) this.failProcess("Reasonix ACP stdout closed unexpectedly", undefined, child);
    });

    let result: AcpInitializeResult;
    try {
      const raw = await this.request("initialize", {
        protocolVersion: REASONIX_RELEASE.protocolVersion,
        clientInfo: { name: "coforge", title: "COFORGE", version: "0.1.0" },
        clientCapabilities: {},
      });
      result = assertInitializeResult(raw);
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (result.protocolVersion !== REASONIX_RELEASE.protocolVersion) {
      await this.stop();
      throw new ReasonixAcpError(
        `Reasonix ACP protocol ${result.protocolVersion} does not match pinned version ${REASONIX_RELEASE.protocolVersion}`,
        "PROTOCOL_MISMATCH",
      );
    }
    this.initialized = true;
    return result;
  }

  async newSession(): Promise<AcpSessionNewResult> {
    if (!this.initialized) throw new ReasonixAcpError("Reasonix ACP is not initialized", "NOT_INITIALIZED");
    if (this.activeSessionId) throw new ReasonixAcpError("An ACP session is already active", "SESSION_ACTIVE");
    await this.resetWorkspace();
    await this.createCredentialBridge();
    let raw: unknown;
    try {
      raw = await this.request("session/new", {
        cwd: this.options.cwd,
        mcpServers: [this.mcpServer],
      });
    } finally {
      await this.removeCredentialBridge();
    }
    const result = assertSessionNewResult(raw);
    this.activeSessionId = result.sessionId;
    this.recoverableSessionId = result.sessionId;
    this.allowedToolCalls.clear();
    return result;
  }

  async loadSession(sessionId: string): Promise<void> {
    if (!this.initialized) throw new ReasonixAcpError("Reasonix ACP is not initialized", "NOT_INITIALIZED");
    if (this.activeSessionId) throw new ReasonixAcpError("An ACP session is already active", "SESSION_ACTIVE");
    if (!sessionId.trim()) throw new ReasonixAcpError("A recovery session id is required", "INVALID_SESSION");
    await this.resetWorkspace();
    await this.createCredentialBridge();
    try {
      await this.request("session/load", {
        sessionId,
        cwd: this.options.cwd,
        mcpServers: [this.mcpServer],
      });
    } finally {
      await this.removeCredentialBridge();
    }
    this.activeSessionId = sessionId;
    this.recoverableSessionId = sessionId;
    this.allowedToolCalls.clear();
  }

  async restartSession(sessionId = this.recoverableSessionId): Promise<void> {
    if (!sessionId) throw new ReasonixAcpError("No persisted ACP session is available to recover", "NO_SESSION");
    if (this.process) await this.stop(false);
    await this.start();
    try {
      await this.loadSession(sessionId);
    } catch (error) {
      await this.stop(false);
      throw error;
    }
  }

  prompt(text: string, signal?: AbortSignal): Promise<AcpPromptResult> {
    const sessionId = this.requireSession();
    const normalized = text.trim();
    if (!normalized) return Promise.reject(new ReasonixAcpError("Prompt cannot be empty", "INVALID_PROMPT"));
    if (normalized.startsWith("/")) {
      return Promise.reject(new ReasonixAcpError("Slash commands are disabled in COFORGE", "INVALID_PROMPT"));
    }
    this.policyViolation = undefined;
    return this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: normalized }] },
      { signal, timeoutMs: 0 },
    ).then((value) => {
      if (this.policyViolation) throw this.policyViolation;
      return assertPromptResult(value);
    });
  }

  cancel(): void {
    const sessionId = this.requireSession();
    this.notify("session/cancel", { sessionId });
  }

  async closeSession(): Promise<void> {
    const sessionId = this.requireSession();
    await this.request("session/close", { sessionId });
    this.activeSessionId = undefined;
    this.recoverableSessionId = undefined;
    this.allowedToolCalls.clear();
    this.policyViolation = undefined;
  }

  async stop(clearRecovery = true, graceMs = 1_500): Promise<void> {
    const child = this.process;
    if (!child) {
      if (clearRecovery) this.recoverableSessionId = undefined;
      await this.removeCredentialBridge();
      return;
    }
    this.stopping = true;
    this.process = undefined;
    this.initialized = false;
    this.activeSessionId = undefined;
    if (clearRecovery) this.recoverableSessionId = undefined;
    this.allowedToolCalls.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ReasonixAcpError("Reasonix ACP stopped", "STOPPED"));
    }
    this.pending.clear();
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) {
      await this.removeCredentialBridge();
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.removeCredentialBridge();
  }

  private requireSession(): string {
    if (!this.activeSessionId) throw new ReasonixAcpError("No active Reasonix ACP session", "NO_SESSION");
    return this.activeSessionId;
  }

  private resetWorkspace(): Promise<void> {
    return resetReasonixWorkspace(resolve(this.options.env.REASONIX_HOME!), resolve(this.options.cwd));
  }

  private request<T = unknown>(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(new ReasonixAcpError("Reasonix ACP is not running", "NOT_RUNNING"));
    }
    const id = ++this.nextId;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      const cleanup = () => {
        if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
      };
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            cleanup();
            reject(new ReasonixAcpError(`ACP request ${method} timed out`, "REQUEST_TIMEOUT"));
          }, timeoutMs)
        : setTimeout(() => undefined, 0x7fffffff);
      timer.unref?.();
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      if (options.signal) {
        abortHandler = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          if (method === "session/prompt" && this.activeSessionId) this.cancel();
          reject(new ReasonixAcpError(`ACP request ${method} was aborted`, "ABORTED"));
        };
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }
      if (!this.pending.has(id)) return;
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(frame: JsonObject): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new ReasonixAcpError("Reasonix ACP is not running", "NOT_RUNNING");
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) > this.maxFrameBytes) {
      throw new ReasonixAcpError("Outbound ACP frame exceeds size limit", "FRAME_TOO_LARGE");
    }
    child.stdin.write(line, "utf8");
  }

  private handleStdoutChunk(child: ChildProcessWithoutNullStreams, chunk: Buffer | string): void {
    if (this.process !== child) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    for (;;) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.maxFrameBytes) {
        this.failProcess("Inbound ACP frame exceeds size limit", undefined, child);
        child.kill("SIGKILL");
        return;
      }
      if (line.length > 0) this.handleLine(child, line.toString("utf8"));
    }
    if (this.stdoutBuffer.length > this.maxFrameBytes) {
      this.failProcess("Inbound ACP frame exceeds size limit", undefined, child);
      child.kill("SIGKILL");
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.process !== child) return;
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch (error) {
      this.failProcess("Reasonix emitted invalid JSON", error, child);
      child.kill("SIGKILL");
      return;
    }
    if (frame.jsonrpc !== "2.0") {
      this.failProcess("Reasonix emitted a non-JSON-RPC frame", undefined, child);
      child.kill("SIGKILL");
      return;
    }
    if (typeof frame.method === "string") {
      void this.handleInboundMethod(child, frame).catch((error) => {
        this.failProcess("Failed to handle an ACP host request", error, child);
        child.kill("SIGKILL");
      });
      return;
    }
    if (typeof frame.id !== "number" && typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new ReasonixAcpError(`${pending.method}: ${errorMessage(frame)}`, "RPC_ERROR"));
    } else {
      pending.resolve(frame.result);
    }
  }

  private async handleInboundMethod(child: ChildProcessWithoutNullStreams, frame: JsonRpcFrame): Promise<void> {
    if (this.process !== child) return;
    if (frame.method === "session/update") {
      try {
        const update = assertSessionUpdate(frame.params);
        if (update.sessionId !== this.activeSessionId) {
          this.reportPolicyViolation("<wrong-session-update>");
          return;
        }
        const toolName = toolNameFromUpdate(update);
        if (toolName !== undefined) {
          const callId = update.update.toolCallId;
          if (!toolName || typeof callId !== "string" || !isAllowedReasonixTool(toolName)) {
            this.reportPolicyViolation(toolName || "<missing-tool-name>");
            return;
          }
          this.allowedToolCalls.add(callId);
        } else if (update.update.sessionUpdate === "tool_call_update") {
          const callId = update.update.toolCallId;
          if (typeof callId !== "string" || !this.allowedToolCalls.has(callId)) {
            this.reportPolicyViolation("<unknown-tool-call>");
            return;
          }
          if (update.update.status === "completed" || update.update.status === "failed") {
            this.allowedToolCalls.delete(callId);
          }
        }
        this.options.onUpdate?.(update);
      } catch (error) {
        this.failProcess("Invalid session/update from Reasonix", error, child);
        child.kill("SIGKILL");
      }
      return;
    }

    if (frame.method === "session/request_permission" && frame.id !== undefined) {
      let result = denyPermissionResult();
      try {
        const request = assertPermissionRequest(frame.params);
        const toolName = permissionToolName(request);
        if (
          request.sessionId === this.activeSessionId &&
          isAllowedReasonixTool(toolName) &&
          this.options.onPermission
        ) {
          const decision = await this.options.onPermission(request);
          if (decision === "allow_once" && request.options.some((option) => option.optionId === "allow_once")) {
            result = { outcome: { outcome: "selected", optionId: "allow_once" } };
          }
        }
      } catch {
        result = denyPermissionResult();
      }
      this.write({ jsonrpc: "2.0", id: frame.id, result });
      return;
    }

    if (frame.id !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: `Unsupported host method: ${frame.method}` },
      });
    }
  }

  private reportPolicyViolation(toolName: string): void {
    if (!this.policyViolation) {
      this.policyViolation = new ReasonixAcpError(
        `Reasonix attempted disallowed tool ${toolName}`,
        "TOOL_POLICY_VIOLATION",
      );
    }
    this.options.onPolicyViolation?.(toolName);
    if (this.activeSessionId) {
      try {
        this.cancel();
      } catch {
        // The orchestrator tears down the process after the prompt rejects.
      }
    }

    // A policy violation cannot wait for an untrusted runtime to acknowledge
    // cancellation. Reject the active turn so the host can enforce a restart.
    for (const [id, pending] of this.pending) {
      if (pending.method !== "session/prompt") continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(this.policyViolation);
    }
  }

  private async createCredentialBridge(): Promise<void> {
    if (!this.options.apiKey || /[\r\n\0]/.test(this.options.apiKey)) {
      throw new ReasonixAcpError("DeepSeek API key is missing or invalid", "INVALID_CREDENTIAL");
    }
    await rm(this.options.credentialBridgePath, { force: true });
    let handle;
    try {
      handle = await open(this.options.credentialBridgePath, "wx", 0o600);
    } catch (error) {
      throw new ReasonixAcpError("Could not create the Reasonix credential bridge", "CREDENTIAL_BRIDGE_FAILED", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    this.credentialBridgePresent = true;
    try {
      await handle.writeFile(`DEEPSEEK_API_KEY=${JSON.stringify(this.options.apiKey)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.removeCredentialBridge();
      throw new ReasonixAcpError("Could not create the Reasonix credential bridge", "CREDENTIAL_BRIDGE_FAILED", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    await handle.close();
  }

  private async removeCredentialBridge(): Promise<void> {
    if (!this.credentialBridgePresent) {
      await rm(this.options.credentialBridgePath, { force: true }).catch(() => undefined);
      return;
    }
    this.credentialBridgePresent = false;
    await rm(this.options.credentialBridgePath, { force: true }).catch(() => undefined);
  }

  private failProcess(
    message: string,
    cause?: unknown,
    child?: ChildProcessWithoutNullStreams,
  ): void {
    if (this.stopping) return;
    if (child && this.process !== child) return;
    if (this.activeSessionId) this.recoverableSessionId = this.activeSessionId;
    this.process = undefined;
    const error = new ReasonixAcpError(message, "PROCESS_EXITED", {
      cause: cause instanceof Error ? cause : undefined,
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.initialized = false;
    this.activeSessionId = undefined;
    this.allowedToolCalls.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    void this.removeCredentialBridge();
  }
}
