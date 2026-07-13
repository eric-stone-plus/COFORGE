import { Transform, type TransformCallback } from "stream";
import {
  callCoforgeMcpTool,
  CoforgeMcpToolNotFoundError,
  listCoforgeMcpTools,
  type CoforgeMcpContext,
} from "./mcp-tools";
import { resolveMcpAuditPath } from "./mcp-audit";

export const COFORGE_MCP_PROTOCOL_VERSION = "2024-11-05";
export const COFORGE_MCP_SERVER_VERSION = "0.1.0";
export const MCP_MAX_FRAME_BYTES = 2 * 1024 * 1024;

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
};

export class McpFrameError extends Error {
  constructor(message: string, readonly code = -32700) {
    super(message);
    this.name = "McpFrameError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function responseError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseRequest(frame: unknown): JsonRpcRequest {
  if (!isObject(frame) || frame.jsonrpc !== "2.0" || typeof frame.method !== "string" || frame.method.length === 0) {
    throw new McpFrameError("Invalid JSON-RPC request.", -32600);
  }
  if (Object.prototype.hasOwnProperty.call(frame, "id") && !validId(frame.id)) {
    throw new McpFrameError("Invalid JSON-RPC id.", -32600);
  }
  return frame as JsonRpcRequest;
}

function initializeParams(value: unknown): void {
  if (!isObject(value) || typeof value.protocolVersion !== "string" || value.protocolVersion.length === 0) {
    throw new McpFrameError("initialize requires protocolVersion.", -32602);
  }
}

function emptyOrAbsentParams(value: unknown, method: string): void {
  if (value === undefined) return;
  if (!isObject(value) || Object.keys(value).length !== 0) {
    throw new McpFrameError(`${method} does not accept parameters.`, -32602);
  }
}

function toolCallParams(value: unknown): { name: string; arguments: unknown } {
  if (!isObject(value)) throw new McpFrameError("tools/call params must be an object.", -32602);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "name" && key !== "arguments")) {
    throw new McpFrameError("tools/call params contain an unsupported property.", -32602);
  }
  if (typeof value.name !== "string" || !value.name) {
    throw new McpFrameError("tools/call requires a tool name.", -32602);
  }
  return { name: value.name, arguments: value.arguments ?? {} };
}

function textResult(value: unknown, isError: boolean) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], isError };
}

export function mcpContextFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CoforgeMcpContext {
  const role = env.COFORGE_MCP_ROLE;
  if (role !== "analyst" && role !== "admin" && role !== "desktop") {
    throw new Error("COFORGE_MCP_ROLE must explicitly be analyst, admin, or desktop.");
  }
  return { role, auditPath: resolveMcpAuditPath(env) };
}

export async function handleCoforgeMcpRequest(
  rawFrame: unknown,
  context: CoforgeMcpContext,
): Promise<JsonRpcResponse | null> {
  if (rawFrame instanceof McpFrameError) {
    return responseError(null, rawFrame.code, rawFrame.message);
  }
  let request: JsonRpcRequest;
  try {
    request = parseRequest(rawFrame);
  } catch (error) {
    const frameError = error instanceof McpFrameError ? error : new McpFrameError("Invalid JSON-RPC request.", -32600);
    return responseError(null, frameError.code, frameError.message);
  }

  // Notifications never receive replies. Only the MCP lifecycle notification is accepted.
  if (!Object.prototype.hasOwnProperty.call(request, "id")) {
    return null;
  }
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize":
      try {
        initializeParams(request.params);
      } catch (error) {
        const frameError = error instanceof McpFrameError ? error : new McpFrameError("Invalid initialize params.", -32602);
        return responseError(id, frameError.code, frameError.message);
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: COFORGE_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "coforge", version: COFORGE_MCP_SERVER_VERSION },
        },
      };
    case "tools/list":
      try {
        emptyOrAbsentParams(request.params, "tools/list");
      } catch (error) {
        const frameError = error instanceof McpFrameError ? error : new McpFrameError("Invalid tools/list params.", -32602);
        return responseError(id, frameError.code, frameError.message);
      }
      return { jsonrpc: "2.0", id, result: { tools: listCoforgeMcpTools() } };
    case "tools/call": {
      let call: ReturnType<typeof toolCallParams>;
      try {
        call = toolCallParams(request.params);
      } catch (error) {
        const frameError = error instanceof McpFrameError ? error : new McpFrameError("Invalid tool call.", -32602);
        return responseError(id, frameError.code, frameError.message);
      }
      try {
        const result = await callCoforgeMcpTool(call.name, call.arguments, context);
        return { jsonrpc: "2.0", id, result: textResult(result, false) };
      } catch (error) {
        if (error instanceof CoforgeMcpToolNotFoundError) {
          return responseError(id, -32602, error.message);
        }
        const message = error instanceof Error ? error.message : "Tool call failed.";
        return { jsonrpc: "2.0", id, result: textResult(message, true) };
      }
    }
    default:
      return responseError(id, -32601, `Method not found: ${request.method}`);
  }
}

export class NdjsonFrameDecoder extends Transform {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MCP_MAX_FRAME_BYTES) {
    super({ readableObjectMode: true });
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError("Invalid MCP frame limit");
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.buffered = Buffer.concat([this.buffered, bytes]);
      if (this.buffered.length > this.maxFrameBytes && this.buffered.indexOf(0x0a) === -1) {
        throw new McpFrameError("MCP frame exceeds the byte limit.");
      }
      this.drainLines();
      if (this.buffered.length > this.maxFrameBytes) {
        throw new McpFrameError("MCP frame exceeds the byte limit.");
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.buffered.length > 0) this.pushFrame(this.buffered);
      this.buffered = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline === -1) return;
      const line = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      this.pushFrame(line);
    }
  }

  private pushFrame(line: Buffer): void {
    const normalized = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    if (normalized.length === 0) return;
    if (normalized.length > this.maxFrameBytes) throw new McpFrameError("MCP frame exceeds the byte limit.");
    try {
      this.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(normalized)));
    } catch {
      this.push(new McpFrameError("Invalid JSON in MCP frame."));
    }
  }
}
