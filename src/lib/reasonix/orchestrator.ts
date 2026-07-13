import { randomUUID } from "crypto";
import { constants as fsConstants } from "fs";
import { access, lstat, mkdir, realpath } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import type {
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdate,
  ReasonixAcpClient,
} from "./acp-client";
import { ReasonixAcpError } from "./acp-client";
import { createReasonixRuntime } from "./runtime";
import { REASONIX_RELEASE } from "./manifest";
import { assertTokenBudgetAvailable } from "../token-ledger";
import { isOfficialDeepSeekBaseURL } from "../provider-identity";
import type { QueryEvidence, QueryRow } from "../query-types";

const MAX_MCP_RESULT_TEXT_BYTES = 2 * 1024 * 1024;

export interface ReasonixDesktopConfiguration {
  packageRoot: string;
  integrityManifestPath: string;
  applicationDataDir: string;
  nodeBinary: string;
  mcpEntrypoint: string;
  dbPath: string;
  auditPath: string;
  mcpAuditPath: string;
}

interface ReasonixRuntimeClient {
  readonly pid?: number;
  readonly sessionId?: string;
  readonly recoverySessionId?: string;
  start(): Promise<unknown>;
  newSession(): Promise<AcpSessionNewResult>;
  restartSession(sessionId?: string): Promise<void>;
  prompt(text: string, signal?: AbortSignal): Promise<AcpPromptResult>;
  stop(clearRecovery?: boolean): Promise<void>;
}

type ClientFactory = (
  apiKey: string,
  onUpdate: (update: AcpSessionUpdate) => void,
) => Promise<ReasonixRuntimeClient>;

export interface ReasonixMcpCallEvidence {
  tool: string;
  operation?: string;
  acpToolCallId?: string;
  callId: string;
  inputHash: string;
  resultHash: string;
  auditEventId?: string;
}

export interface ReasonixTurnResult {
  thinking: "";
  intent: string;
  explanation: string;
  conversational: true;
  sql?: string;
  data?: QueryRow[];
  evidence?: QueryEvidence;
  runtime: {
    engine: "reasonix";
    version: string;
    sessionId: string;
    hostTurnId: string;
    stopReason: AcpPromptResult["stopReason"];
    usageUnavailable: true;
    evidenceUnavailable: boolean;
    mcpCalls: ReasonixMcpCallEvidence[];
  };
}

export interface ReasonixTurnOptions {
  apiKey: string;
  monthlyTokenBudget: number;
  signal?: AbortSignal;
  onUpdate?: (update: AcpSessionUpdate) => void;
}

export class ReasonixRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasonixRuntimeConfigurationError";
  }
}

type ActiveTurn = {
  text: string[];
  calls: ReasonixMcpEnvelope[];
  toolCalls: Map<string, string>;
  onUpdate?: (update: AcpSessionUpdate) => void;
};

type ReasonixMcpEnvelope = {
  schemaVersion: 1;
  tool: string;
  operation?: string;
  result: unknown;
  evidence: ReasonixMcpCallEvidence;
};

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function requiredAbsolutePath(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value || !isAbsolute(value)) {
    throw new ReasonixRuntimeConfigurationError(`${name} must be an absolute packaged path.`);
  }
  return resolve(value);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function regularFile(path: string, executable = false): Promise<string> {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new ReasonixRuntimeConfigurationError(`Packaged runtime file is missing or invalid: ${path}`);
  }
  if (executable) {
    await access(path, fsConstants.X_OK).catch(() => {
      throw new ReasonixRuntimeConfigurationError(`Packaged runtime file is not executable: ${path}`);
    });
  }
  return realpath(path);
}

export function isReasonixDesktopEnabled(env: RuntimeEnvironment = process.env): boolean {
  return env.COFORGE_DESKTOP === "1" && env.COFORGE_REASONIX_ENABLED !== "0";
}

export function isReasonixDeepSeekProvider(provider: {
  backend: string;
  baseURL: string;
  model: string;
}): boolean {
  return (
    provider.backend === "openai-compatible" &&
    isOfficialDeepSeekBaseURL(provider.baseURL) &&
    provider.model === "deepseek-v4-pro"
  );
}

async function prepareAuditPath(applicationDataDir: string, auditPath: string): Promise<void> {
  const auditDir = dirname(auditPath);
  const relativeDir = relative(applicationDataDir, auditDir);
  let current = applicationDataDir;
  for (const segment of relativeDir.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ReasonixRuntimeConfigurationError("The Reasonix MCP audit directory is not a regular directory.");
    }
    const resolved = await realpath(current);
    if (!isWithin(applicationDataDir, resolved)) {
      throw new ReasonixRuntimeConfigurationError("The Reasonix MCP audit directory escapes COFORGE app data.");
    }
  }

  const existingAudit = await lstat(auditPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingAudit && (!existingAudit.isFile() || existingAudit.isSymbolicLink())) {
    throw new ReasonixRuntimeConfigurationError("The Reasonix MCP audit file is not a regular file.");
  }
}

export async function reasonixDesktopConfigurationFromEnvironment(
  env: RuntimeEnvironment = process.env,
): Promise<ReasonixDesktopConfiguration> {
  if (!isReasonixDesktopEnabled(env)) {
    throw new ReasonixRuntimeConfigurationError("The embedded Reasonix beta is not enabled.");
  }

  const resources = await realpath(requiredAbsolutePath(env, "COFORGE_RESOURCES_DIR")).catch(() => {
    throw new ReasonixRuntimeConfigurationError("COFORGE_RESOURCES_DIR is missing or invalid.");
  });
  const applicationDataDir = await realpath(requiredAbsolutePath(env, "COFORGE_CONFIG_DIR")).catch(() => {
    throw new ReasonixRuntimeConfigurationError("COFORGE_CONFIG_DIR is missing or invalid.");
  });
  const packageRoot = await realpath(requiredAbsolutePath(env, "COFORGE_REASONIX_PACKAGE_ROOT")).catch(() => {
    throw new ReasonixRuntimeConfigurationError("COFORGE_REASONIX_PACKAGE_ROOT is missing or invalid.");
  });
  const integrityManifestPath = await regularFile(
    requiredAbsolutePath(env, "COFORGE_REASONIX_INTEGRITY_MANIFEST"),
  );
  const nodeBinary = await regularFile(requiredAbsolutePath(env, "COFORGE_NODE_BINARY"), true);
  const mcpEntrypoint = await regularFile(requiredAbsolutePath(env, "COFORGE_MCP_ENTRYPOINT"));
  const dbPath = await regularFile(requiredAbsolutePath(env, "DB_PATH"));

  for (const path of [packageRoot, integrityManifestPath, nodeBinary, mcpEntrypoint, dbPath]) {
    if (!isWithin(resources, path)) {
      throw new ReasonixRuntimeConfigurationError("Embedded Reasonix resources must remain inside the app bundle.");
    }
  }
  if (integrityManifestPath !== join(packageRoot, "packaged-manifest.json")) {
    throw new ReasonixRuntimeConfigurationError(
      "COFORGE_REASONIX_INTEGRITY_MANIFEST must be the packaged manifest inside the Reasonix root.",
    );
  }

  const configuredAuditPath = env.COFORGE_QUERY_AUDIT_PATH?.trim();
  const auditPath = resolve(configuredAuditPath || join(applicationDataDir, "audit", "query-events.jsonl"));
  if (!isAbsolute(auditPath) || !isWithin(applicationDataDir, auditPath)) {
    throw new ReasonixRuntimeConfigurationError("The Reasonix MCP audit path must remain inside COFORGE app data.");
  }
  await prepareAuditPath(applicationDataDir, auditPath);
  const configuredMcpAuditPath = env.COFORGE_MCP_AUDIT_PATH?.trim();
  const mcpAuditPath = resolve(configuredMcpAuditPath || join(applicationDataDir, "audit", "mcp-events.jsonl"));
  if (!isAbsolute(mcpAuditPath) || !isWithin(applicationDataDir, mcpAuditPath)) {
    throw new ReasonixRuntimeConfigurationError("The Reasonix MCP call audit path must remain inside COFORGE app data.");
  }
  await prepareAuditPath(applicationDataDir, mcpAuditPath);

  return {
    packageRoot,
    integrityManifestPath,
    applicationDataDir,
    nodeBinary,
    mcpEntrypoint,
    dbPath,
    auditPath,
    mcpAuditPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseMcpEnvelope(text: string): ReasonixMcpEnvelope | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_RESULT_TEXT_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.tool !== "string" || !isRecord(value.evidence)) {
    return undefined;
  }
  const evidence = value.evidence;
  if (
    typeof evidence.callId !== "string" ||
    !validHash(evidence.inputHash) ||
    !validHash(evidence.resultHash)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    tool: value.tool,
    ...(typeof value.operation === "string" ? { operation: value.operation } : {}),
    result: value.result,
    evidence: {
      tool: value.tool,
      ...(typeof value.operation === "string" ? { operation: value.operation } : {}),
      callId: evidence.callId,
      inputHash: evidence.inputHash,
      resultHash: evidence.resultHash,
      ...(typeof evidence.auditEventId === "string" ? { auditEventId: evidence.auditEventId } : {}),
    },
  };
}

function contentText(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => contentText(item, depth + 1));
  if (!isRecord(value)) return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  if ("content" in value) return contentText(value.content, depth + 1);
  return [];
}

function validQueryEvidence(value: unknown): value is QueryEvidence {
  if (!isRecord(value)) return false;
  return (
    typeof value.queryId === "string" &&
    typeof value.auditEventId === "string" &&
    value.source === "agent" &&
    Array.isArray(value.tables) && value.tables.every((table) => typeof table === "string") &&
    ["rowCount", "columnCount", "responseBytes", "durationMs", "limit"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
    ) &&
    validHash(value.resultHash) &&
    typeof value.truncated === "boolean"
  );
}

function validQueryRows(value: unknown): value is QueryRow[] {
  return Array.isArray(value) && value.every((row) => isRecord(row) && Object.values(row).every(
    (cell) => cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean",
  ));
}

function queryResultFromCalls(calls: ReasonixMcpEnvelope[]): {
  sql?: string;
  data?: QueryRow[];
  evidence?: QueryEvidence;
} {
  for (const call of [...calls].reverse()) {
    if (call.tool !== "query" || !isRecord(call.result) || call.result.ok !== true) continue;
    if (
      typeof call.result.executedSql === "string" &&
      validQueryRows(call.result.rows) &&
      validQueryEvidence(call.result.meta)
    ) {
      return { sql: call.result.executedSql, data: call.result.rows, evidence: call.result.meta };
    }
  }
  return {};
}

export class ReasonixRuntimeOrchestrator {
  private client?: ReasonixRuntimeClient;
  private activeApiKey?: string;
  private queue: Promise<void> = Promise.resolve();
  private activeTurn?: ActiveTurn;
  private stopping?: Promise<void>;
  private readonly createClient: ClientFactory;

  constructor(
    private readonly configuration: ReasonixDesktopConfiguration,
    clientFactory?: ClientFactory,
  ) {
    this.createClient = clientFactory ?? ((apiKey, onUpdate) => createReasonixRuntime({
      packageRoot: configuration.packageRoot,
      integrityManifestPath: configuration.integrityManifestPath,
      applicationDataDir: configuration.applicationDataDir,
      apiKey,
      mcp: {
        command: configuration.nodeBinary,
        args: [configuration.mcpEntrypoint],
        env: {
          DB_PATH: configuration.dbPath,
          COFORGE_QUERY_AUDIT_PATH: configuration.auditPath,
          COFORGE_MCP_AUDIT_PATH: configuration.mcpAuditPath,
          COFORGE_MCP_ROLE: "desktop",
        },
      },
      onUpdate,
    }));
  }

  runTurn(prompt: string, options: ReasonixTurnOptions): Promise<ReasonixTurnResult> {
    if (this.stopping) return Promise.reject(new Error("Reasonix runtime is stopping."));
    const task = this.queue.then(() => this.runExclusive(prompt, options));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      const client = this.client;
      this.client = undefined;
      this.activeApiKey = undefined;
      this.activeTurn = undefined;
      this.stopping = (async () => {
        await client?.stop();
        await this.queue.catch(() => undefined);
      })();
    }
    await this.stopping;
  }

  private async runExclusive(prompt: string, options: ReasonixTurnOptions): Promise<ReasonixTurnResult> {
    if (this.stopping) throw new Error("Reasonix runtime is stopping.");
    const normalized = prompt.trim();
    if (!normalized) throw new Error("Reasonix prompt cannot be empty.");
    if (options.signal?.aborted) throw new DOMException("Reasonix request was aborted.", "AbortError");
    assertTokenBudgetAvailable(options.monthlyTokenBudget);

    const client = await this.ensureClient(options.apiKey);
    if (this.stopping) throw new Error("Reasonix runtime is stopping.");
    const turn: ActiveTurn = { text: [], calls: [], toolCalls: new Map(), onUpdate: options.onUpdate };
    this.activeTurn = turn;
    const hostTurnId = randomUUID();
    let promptResult: AcpPromptResult;
    try {
      promptResult = await client.prompt(normalized, options.signal);
    } catch (error) {
      if (
        error instanceof ReasonixAcpError &&
        (error.code === "ABORTED" || error.code === "TOOL_POLICY_VIOLATION")
      ) {
        // session/cancel is only a notification. Destroying the process is the
        // barrier that prevents late chunks from contaminating the next turn.
        await client.stop(false);
      }
      throw error;
    } finally {
      this.activeTurn = undefined;
    }

    const explanation = turn.text.join("").trim();
    if (!explanation) throw new Error("Reasonix completed without an assistant message.");
    const sessionId = client.sessionId;
    if (!sessionId) throw new Error("Reasonix completed without an active session id.");
    const query = queryResultFromCalls(turn.calls);
    return {
      thinking: "",
      intent: "Reasonix 煤炭运营分析",
      explanation,
      conversational: true,
      ...query,
      runtime: {
        engine: "reasonix",
        version: REASONIX_RELEASE.version,
        sessionId,
        hostTurnId,
        stopReason: promptResult.stopReason,
        usageUnavailable: true,
        evidenceUnavailable: turn.calls.length === 0,
        mcpCalls: turn.calls.map((call) => call.evidence),
      },
    };
  }

  private async ensureClient(apiKey: string): Promise<ReasonixRuntimeClient> {
    if (this.client && this.activeApiKey !== apiKey) {
      await this.client.stop();
      this.client = undefined;
      this.activeApiKey = undefined;
    }

    if (!this.client) {
      const client = await this.createClient(apiKey, (update) => this.handleUpdate(update));
      try {
        await client.start();
        await client.newSession();
      } catch (error) {
        await client.stop().catch(() => undefined);
        throw error;
      }
      this.client = client;
      this.activeApiKey = apiKey;
      return client;
    }

    if (!this.client.pid) {
      const recoverySessionId = this.client.recoverySessionId;
      if (!recoverySessionId) {
        await this.client.start();
        await this.client.newSession();
      } else {
        await this.client.restartSession(recoverySessionId);
      }
    }
    return this.client;
  }

  private handleUpdate(update: AcpSessionUpdate): void {
    const turn = this.activeTurn;
    if (!turn) return;
    if (update.update.sessionUpdate === "agent_message_chunk") {
      turn.text.push(...contentText(update.update.content));
    } else if (update.update.sessionUpdate === "tool_call") {
      const callId = update.update.toolCallId;
      const title = update.update.title;
      const match = typeof title === "string" ? /^mcp__coforge__([a-z0-9_-]+)$/.exec(title) : null;
      if (typeof callId === "string" && match) turn.toolCalls.set(callId, match[1]);
    } else if (update.update.sessionUpdate === "tool_call_update" && update.update.status === "completed") {
      const acpToolCallId = update.update.toolCallId;
      const expectedTool = typeof acpToolCallId === "string" ? turn.toolCalls.get(acpToolCallId) : undefined;
      for (const text of contentText(update.update.content)) {
        const envelope = parseMcpEnvelope(text);
        if (envelope && expectedTool === envelope.tool && typeof acpToolCallId === "string") {
          envelope.evidence.acpToolCallId = acpToolCallId;
          turn.calls.push(envelope);
        }
      }
      if (typeof acpToolCallId === "string") turn.toolCalls.delete(acpToolCallId);
    }
    turn.onUpdate?.(update);
  }
}

let desktopRuntime: ReasonixRuntimeOrchestrator | undefined;

export async function runDesktopReasonixTurn(
  prompt: string,
  options: ReasonixTurnOptions,
): Promise<ReasonixTurnResult> {
  if (!desktopRuntime) {
    desktopRuntime = new ReasonixRuntimeOrchestrator(await reasonixDesktopConfigurationFromEnvironment());
  }
  return desktopRuntime.runTurn(prompt, options);
}

export async function shutdownDesktopReasonixRuntime(): Promise<void> {
  const runtime = desktopRuntime;
  desktopRuntime = undefined;
  await runtime?.stop();
}

function installProcessShutdownHandlers(): void {
  const globalState = globalThis as typeof globalThis & { __coforgeReasonixShutdownInstalled?: boolean };
  if (globalState.__coforgeReasonixShutdownInstalled) return;
  globalState.__coforgeReasonixShutdownInstalled = true;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const fallback = setTimeout(() => process.exit(1), 2_500);
    fallback.unref?.();
    void shutdownDesktopReasonixRuntime().finally(() => {
      clearTimeout(fallback);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

installProcessShutdownHandlers();

export type { ReasonixAcpClient };
