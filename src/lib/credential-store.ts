import { createHash, timingSafeEqual } from "crypto";
import { constants as fsConstants, accessSync, lstatSync, readFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";

const HELPER_PROTOCOL_VERSION = 2;
const PROVIDER_CREDENTIAL = "provider-api-key";
const MAX_SECRET_BYTES = 32 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const MAX_HELPER_BINARY_BYTES = 64 * 1024 * 1024;

export type CredentialStoreBackend =
  | "macos-keychain"
  | "windows-credential-manager"
  | "unavailable";

export type CredentialStoreStatus = {
  backend: CredentialStoreBackend;
  label: string;
  available: boolean;
  message: string;
};

export type CredentialStoreErrorCode =
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "CREDENTIAL_STORE_FAILED"
  | "CREDENTIAL_INVALID";

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

export function isCredentialStoreError(error: unknown): error is CredentialStoreError {
  return error instanceof CredentialStoreError;
}

type SupportedPlatform = "darwin" | "win32";
type HelperOperation = "status" | "read" | "write" | "delete";

type HelperResponse = {
  version?: unknown;
  ok?: unknown;
  found?: unknown;
  secret?: unknown;
  binding?: unknown;
};

export type ProviderCredentialRecord = {
  secret: string;
  binding: string;
};

function platformDescription(platform: NodeJS.Platform): Omit<CredentialStoreStatus, "available" | "message"> | null {
  if (platform === "darwin") {
    return { backend: "macos-keychain", label: "macOS Keychain" };
  }
  if (platform === "win32") {
    return { backend: "windows-credential-manager", label: "Windows Credential Manager" };
  }
  return null;
}

function configuredHelperPath() {
  return process.env.COFORGE_CREDENTIAL_HELPER?.trim() || "";
}

function validateHelperPath(
  helperPath: string,
  platform: SupportedPlatform,
  windowsExpectedHash: string,
): string | null {
  if (!helperPath) return "The desktop credential helper is not configured.";
  if (!path.isAbsolute(helperPath)) return "The desktop credential helper path must be absolute.";

  try {
    const stat = lstatSync(helperPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return "The desktop credential helper must be a regular file.";
    }
    accessSync(helperPath, fsConstants.X_OK);

    if (platform === "darwin") {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) {
        return "The desktop credential helper has an unexpected owner.";
      }
      if ((stat.mode & 0o022) !== 0) {
        return "The desktop credential helper must not be group- or world-writable.";
      }
    } else {
      const expectedHash = windowsExpectedHash;
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        return "The Windows credential helper requires a packaged SHA-256 pin.";
      }
      if (stat.size < 1 || stat.size > MAX_HELPER_BINARY_BYTES) {
        return "The Windows credential helper binary size is invalid.";
      }
      const actualHash = createHash("sha256").update(readFileSync(helperPath)).digest();
      const expectedHashBytes = Buffer.from(expectedHash, "hex");
      if (!timingSafeEqual(actualHash, expectedHashBytes)) {
        return "The Windows credential helper does not match its packaged SHA-256 pin.";
      }
    }
  } catch {
    return "The desktop credential helper is missing or not executable.";
  }

  return null;
}

export function describeCredentialStore(
  platform: NodeJS.Platform = process.platform,
  helperPath = configuredHelperPath(),
  desktopMode = process.env.COFORGE_DESKTOP === "1",
  windowsExpectedHash = process.env.COFORGE_CREDENTIAL_HELPER_SHA256?.trim().toLowerCase() || "",
): CredentialStoreStatus {
  const description = platformDescription(platform);
  if (!description) {
    return {
      backend: "unavailable",
      label: "System credential store",
      available: false,
      message: "This platform has no supported COFORGE system credential store; plaintext fallback is disabled.",
    };
  }

  if (!desktopMode) {
    return {
      ...description,
      available: false,
      message: "The system credential store is available only inside the packaged COFORGE desktop app; plaintext fallback is disabled.",
    };
  }

  const supportedPlatform: SupportedPlatform = platform === "win32" ? "win32" : "darwin";
  const pathError = validateHelperPath(helperPath, supportedPlatform, windowsExpectedHash);
  if (pathError) {
    const platformMessage = platform === "win32"
      ? "Install and configure the signed Windows Credential Manager helper; plaintext fallback is disabled."
      : "Launch COFORGE from the packaged desktop app to use macOS Keychain; plaintext fallback is disabled.";
    return {
      ...description,
      available: false,
      message: `${pathError} ${platformMessage}`,
    };
  }

  return {
    ...description,
    available: true,
    message: `API keys are stored in ${description.label} and never in settings.json.`,
  };
}

function minimalHelperEnvironment(platform: SupportedPlatform): NodeJS.ProcessEnv {
  if (platform === "win32") {
    return {
      NODE_ENV: process.env.NODE_ENV,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
    };
  }
  return { NODE_ENV: process.env.NODE_ENV };
}

function runHelper(operation: HelperOperation, secret?: string, binding?: string): HelperResponse {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE", describeCredentialStore(platform).message);
  }
  const status = describeCredentialStore(platform);
  if (!status.available) {
    throw new CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE", status.message);
  }

  const helperPath = configuredHelperPath();
  const request = JSON.stringify({
    version: HELPER_PROTOCOL_VERSION,
    operation,
    credential: PROVIDER_CREDENTIAL,
    ...(secret === undefined ? {} : { secret }),
    ...(binding === undefined ? {} : { binding }),
  });
  const result = spawnSync(helperPath, [], {
    input: request,
    encoding: "utf8",
    env: minimalHelperEnvironment(platform),
    maxBuffer: MAX_HELPER_OUTPUT_BYTES,
    timeout: 5_000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || result.signal) {
    throw new CredentialStoreError(
      "CREDENTIAL_STORE_FAILED",
      `${status.label} could not complete the credential operation. No plaintext fallback was used.`,
    );
  }

  try {
    const response = JSON.parse(result.stdout) as HelperResponse;
    if (response.version !== HELPER_PROTOCOL_VERSION || response.ok !== true) throw new Error("invalid response");
    return response;
  } catch {
    throw new CredentialStoreError(
      "CREDENTIAL_STORE_FAILED",
      `${status.label} returned an invalid response. No plaintext fallback was used.`,
    );
  }
}

function validateSecret(secret: string) {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (!secret || bytes > MAX_SECRET_BYTES || secret.includes("\0")) {
    throw new CredentialStoreError(
      "CREDENTIAL_INVALID",
      `API key must contain between 1 and ${MAX_SECRET_BYTES} UTF-8 bytes and cannot contain NUL characters.`,
    );
  }
}

export function readProviderCredential(): ProviderCredentialRecord {
  const response = runHelper("read");
  if (response.found === false) return { secret: "", binding: "none" };
  if (response.found !== true || typeof response.secret !== "string") {
    throw new CredentialStoreError("CREDENTIAL_STORE_FAILED", "The system credential store returned an invalid credential response.");
  }
  validateSecret(response.secret);
  const binding = typeof response.binding === "string" ? response.binding : "";
  if (binding && !/^keychain:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding)) {
    throw new CredentialStoreError("CREDENTIAL_STORE_FAILED", "The system credential store returned an invalid credential binding.");
  }
  return { secret: response.secret, binding };
}

export function readProviderCredentialIfAvailable(): ProviderCredentialRecord {
  if (!describeCredentialStore().available) return { secret: "", binding: "none" };
  return readProviderCredential();
}

export function writeProviderCredential(secret: string, binding: string): void {
  validateSecret(secret);
  if (!/^keychain:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding)) {
    throw new CredentialStoreError("CREDENTIAL_INVALID", "The credential transaction binding is invalid.");
  }
  runHelper("write", secret, binding);
}

export function deleteProviderCredential(): void {
  runHelper("delete");
}
