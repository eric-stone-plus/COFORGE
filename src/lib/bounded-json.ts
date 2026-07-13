export const STANDARD_JSON_BODY_LIMIT = 64 * 1024;
export const BUSINESS_JSON_BODY_LIMIT = 1024 * 1024;

export type RequestBodyErrorCode = "BODY_TOO_LARGE" | "INVALID_JSON" | "INVALID_CONTENT_LENGTH";

export class RequestBodyError extends Error {
  readonly code: RequestBodyErrorCode;
  readonly status: 400 | 413;

  constructor(code: RequestBodyErrorCode) {
    super(code === "BODY_TOO_LARGE"
      ? "Request body is too large."
      : code === "INVALID_CONTENT_LENGTH"
        ? "Invalid Content-Length header."
        : "Invalid JSON payload.");
    this.name = "RequestBodyError";
    this.code = code;
    this.status = code === "BODY_TOO_LARGE" ? 413 : 400;
  }
}

export function isRequestBodyError(error: unknown): error is RequestBodyError {
  return error instanceof RequestBodyError;
}

function validateLimit(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("JSON body limit must be a positive safe integer");
  }
}

export function assertDeclaredBodyWithinLimit(request: Request, maxBytes: number) {
  validateLimit(maxBytes);
  const raw = request.headers.get("content-length");
  if (raw === null) return;

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) throw new RequestBodyError("INVALID_CONTENT_LENGTH");
  const declaredBytes = Number(normalized);
  if (!Number.isSafeInteger(declaredBytes)) throw new RequestBodyError("INVALID_CONTENT_LENGTH");
  if (declaredBytes > maxBytes) throw new RequestBodyError("BODY_TOO_LARGE");
}

async function readBoundedBody(request: Request, maxBytes: number) {
  assertDeclaredBodyWithinLimit(request, maxBytes);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new RequestBodyError("INVALID_JSON");

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RequestBodyError("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (isRequestBodyError(error)) throw error;
    throw new RequestBodyError("INVALID_JSON");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJson(
  request: Request,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const body = await readBoundedBody(request, maxBytes);
  if (body.byteLength === 0 && options.allowEmpty) return undefined;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (!text.trim() && options.allowEmpty) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("INVALID_JSON");
  }
}
