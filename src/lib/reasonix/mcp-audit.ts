import { randomUUID } from "crypto";
import { lstat, mkdir, open, realpath } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";

export type McpAuditOutcome = "success" | "rejected" | "failed";

export interface McpAuditEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  callId: string;
  tool: string;
  operation: string;
  role: "analyst" | "admin" | "desktop";
  outcome: McpAuditOutcome;
  inputHash: string;
  resultHash?: string;
  errorCode?: string;
}

export interface McpAuditInput {
  callId: string;
  tool: string;
  operation: string;
  role: McpAuditEvent["role"];
  outcome: McpAuditOutcome;
  inputHash: string;
  resultHash?: string;
  errorCode?: string;
}

const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const AUDIT_FILE_MODE = 0o600;
const AUDIT_DIRECTORY_MODE = 0o700;
let appendChain: Promise<void> = Promise.resolve();

export function resolveMcpAuditPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env.COFORGE_MCP_AUDIT_PATH?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error("COFORGE_MCP_AUDIT_PATH must be an absolute path.");
  }
  return resolve(configured);
}

function validateAuditInput(input: McpAuditInput): void {
  if (!input.callId || input.callId.length > 128) throw new Error("Invalid MCP audit call id.");
  if (!NAME.test(input.tool) || !NAME.test(input.operation)) throw new Error("Invalid MCP audit operation.");
  if (!HASH.test(input.inputHash) || (input.resultHash && !HASH.test(input.resultHash))) {
    throw new Error("Invalid MCP audit hash.");
  }
  if (input.errorCode && !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) {
    throw new Error("Invalid MCP audit error code.");
  }
}

function createMcpAuditEvent(input: McpAuditInput): McpAuditEvent {
  validateAuditInput(input);
  return Object.freeze({
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    callId: input.callId,
    tool: input.tool,
    operation: input.operation,
    role: input.role,
    outcome: input.outcome,
    inputHash: input.inputHash,
    ...(input.resultHash ? { resultHash: input.resultHash } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

async function ensurePrivateAuditTarget(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: AUDIT_DIRECTORY_MODE });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("MCP audit directory is not a regular directory.");
  }
  await realpath(directory);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("MCP audit file is not a regular file.");
  }
}

async function appendEvent(path: string, event: McpAuditEvent): Promise<void> {
  await ensurePrivateAuditTarget(path);
  const handle = await open(path, "a+", AUDIT_FILE_MODE);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("MCP audit target is not a regular file.");
    const [resolvedPath, resolvedDirectory] = await Promise.all([realpath(path), realpath(dirname(path))]);
    if (dirname(resolvedPath) !== resolvedDirectory) {
      throw new Error("MCP audit target escapes its configured directory.");
    }
    await handle.chmod(AUDIT_FILE_MODE);
    await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function appendMcpAuditEvent(
  input: McpAuditInput,
  path = resolveMcpAuditPath(),
): Promise<McpAuditEvent> {
  const event = createMcpAuditEvent(input);
  const pending = appendChain.then(async () => {
    await appendEvent(path, event);
    return event;
  });
  appendChain = pending.then(() => undefined, () => undefined);
  return pending;
}

export function resetMcpAuditQueueForTests(): void {
  appendChain = Promise.resolve();
}
