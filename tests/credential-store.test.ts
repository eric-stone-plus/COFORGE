import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bounded-json", async () => import("../src/lib/bounded-json"));
vi.mock("@/lib/credential-store", async () => import("../src/lib/credential-store"));
vi.mock("@/lib/local-settings", async () => import("../src/lib/local-settings"));
vi.mock("@/lib/request-security", async () => import("../src/lib/request-security"));

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
let directory = "";
let helperPath = "";
let helperStatePath = "";
const ledgerClosers: Array<() => void> = [];
const { renameSyncMock } = vi.hoisted(() => ({ renameSyncMock: vi.fn() }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  renameSyncMock.mockImplementation(actual.renameSync);
  return { ...actual, renameSync: renameSyncMock };
});

function installFakeHelper() {
  helperPath = path.join(directory, "credential-helper");
  helperStatePath = path.join(directory, "helper-state.json");
  writeFileSync(helperPath, `#!${process.execPath}
const fs = require("fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const statePath = ${JSON.stringify(helperStatePath)};
const failurePath = ${JSON.stringify(path.join(directory, "helper-failure.json"))};
let secret = "";
try { secret = JSON.parse(fs.readFileSync(statePath, "utf8")).secret || ""; } catch {}
let failure = {};
try { failure = JSON.parse(fs.readFileSync(failurePath, "utf8")); } catch {}
let binding = "";
try { binding = JSON.parse(fs.readFileSync(statePath, "utf8")).binding || ""; } catch {}
let response = { version: 2, ok: true };
if (request.version !== 2 || request.credential !== "provider-api-key") process.exit(2);
if (request.operation === "read") response = { ...response, found: Boolean(secret), ...(secret ? { secret, binding } : {}) };
else if (request.operation === "write") {
  if (!/^keychain:[0-9a-f-]{36}$/.test(request.binding || "")) process.exit(2);
  if (failure.beforeWriteSecret === request.secret) process.exit(3);
  fs.writeFileSync(statePath, JSON.stringify({ secret: request.secret, binding: request.binding }), { mode: 0o600 });
  if (failure.afterWriteSecret === request.secret) process.exit(3);
}
else if (request.operation === "delete") { try { fs.unlinkSync(statePath); } catch {} }
else if (request.operation !== "status") process.exit(2);
process.stdout.write(JSON.stringify(response));
`);
  chmodSync(helperPath, 0o700);
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  directory = mkdtempSync(path.join(tmpdir(), "coforge-credentials-"));
  installFakeHelper();
  renameSyncMock.mockClear();
  process.env = {
    ...originalEnv,
    COFORGE_CONFIG_DIR: directory,
    COFORGE_TOKEN_LEDGER_PATH: path.join(directory, "token-ledger.sqlite"),
    COFORGE_DESKTOP: "1",
    COFORGE_CREDENTIAL_HELPER: helperPath,
  };
  delete process.env.COFORGE_ALLOW_ENV_PROVIDER;
  vi.resetModules();
});

afterEach(() => {
  for (const close of ledgerClosers.splice(0)) close();
  process.env = { ...originalEnv };
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  rmSync(directory, { recursive: true, force: true });
});

async function loadSettings() {
  const settings = await import("../src/lib/local-settings");
  const ledger = await import("../src/lib/token-ledger");
  ledgerClosers.push(ledger.closeTokenLedgerForTests);
  return settings;
}

function settingsText() {
  return readFileSync(path.join(directory, "settings.json"), "utf8");
}

// These tests spawn the real Swift Keychain helper and perform real Keychain
// I/O; under full-suite parallel load a single operation can exceed the
// default 5s test timeout.
describe("desktop system credential store", { timeout: 30_000 }, () => {
  it("keeps the future Windows bridge unavailable without a packaged hash pin", async () => {
    const { describeCredentialStore } = await import("../src/lib/credential-store");
    expect(describeCredentialStore("win32", helperPath, true, "")).toMatchObject({
      backend: "windows-credential-manager",
      available: false,
    });
    expect(describeCredentialStore("win32", helperPath, true, "").message).toMatch(/SHA-256 pin/);
  });

  it("stores, reads, and clears an API key without writing it to settings.json", async () => {
    const settings = await loadSettings();
    const secret = "test-provider-secret-not-real";

    const saved = settings.updateLocalSettings({ provider: { apiKey: secret } });
    expect(saved.provider.apiKeyConfigured).toBe(true);
    expect(saved.credentialStore).toMatchObject({ backend: "macos-keychain", available: true });
    expect(settingsText()).not.toContain(secret);
    expect(JSON.parse(settingsText()).provider).not.toHaveProperty("apiKey");
    const binding = JSON.parse(settingsText()).provider.credentialBinding;
    expect(binding).toMatch(/^keychain:[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(helperStatePath, "utf8"))).toMatchObject({ secret, binding });
    expect(settings.getEffectiveProviderSettings().apiKey).toBe(secret);

    const cleared = settings.updateLocalSettings({ provider: { clearApiKey: true } });
    expect(cleared.provider.apiKeyConfigured).toBe(false);
    expect(settingsText()).not.toContain(secret);
  });

  it("migrates a legacy plaintext key before removing the JSON field", async () => {
    const secret = "legacy-test-provider-secret";
    writeFileSync(path.join(directory, "settings.json"), JSON.stringify({
      provider: {
        backend: "openai-compatible",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        apiKey: secret,
      },
    }), { mode: 0o600 });

    const settings = await loadSettings();
    expect(settings.getEffectiveProviderSettings().apiKey).toBe(secret);
    expect(settingsText()).not.toContain(secret);
    expect(JSON.parse(settingsText()).provider).not.toHaveProperty("apiKey");
  });

  it("migrates a legacy unbound Keychain value into a random transaction binding", async () => {
    const secret = "legacy-keychain-secret";
    writeFileSync(helperStatePath, JSON.stringify({ secret }), { mode: 0o600 });
    writeFileSync(path.join(directory, "settings.json"), JSON.stringify({
      provider: {
        backend: "openai-compatible",
        baseURL: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        credentialBinding: "sha256:" + "a".repeat(64),
      },
    }), { mode: 0o600 });

    const settings = await loadSettings();
    expect(settings.getEffectiveProviderSettings().apiKey).toBe(secret);
    const binding = JSON.parse(settingsText()).provider.credentialBinding;
    expect(binding).toMatch(/^keychain:[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(helperStatePath, "utf8"))).toEqual({ secret, binding });
  });

  it("scrubs and refuses a legacy plaintext key when no trusted helper is available", async () => {
    const secret = "legacy-must-not-load";
    process.env.COFORGE_CREDENTIAL_HELPER = path.join(directory, "missing-helper");
    writeFileSync(path.join(directory, "settings.json"), JSON.stringify({
      provider: { apiKey: secret },
    }), { mode: 0o600 });

    const settings = await loadSettings();
    expect(() => settings.getEffectiveProviderSettings()).toThrow(/plaintext fallback is disabled/i);
    expect(settingsText()).not.toContain(secret);
    expect(JSON.parse(settingsText()).provider).not.toHaveProperty("apiKey");
  });

  it("rejects new key persistence when the helper is unavailable", async () => {
    process.env.COFORGE_CREDENTIAL_HELPER = path.join(directory, "missing-helper");
    const settings = await loadSettings();

    expect(() => settings.updateLocalSettings({ provider: { apiKey: "must-not-persist" } })).toThrowError(expect.objectContaining({
      code: "CREDENTIAL_STORE_UNAVAILABLE",
    }));
    expect(() => readFileSync(path.join(directory, "settings.json"), "utf8")).toThrow();
  });

  it("returns a stable 503 code from the settings API when secure storage is unavailable", async () => {
    process.env.COFORGE_CREDENTIAL_HELPER = path.join(directory, "missing-helper");
    process.env.COFORGE_DESKTOP_CAPABILITY = "test-desktop-capability";
    const { POST } = await import("../src/app/api/settings/route");
    const ledger = await import("../src/lib/token-ledger");
    ledgerClosers.push(ledger.closeTokenLedgerForTests);
    const response = await POST(new Request("http://127.0.0.1:18123/api/settings", {
      method: "POST",
      headers: {
        host: "127.0.0.1:18123",
        origin: "http://127.0.0.1:18123",
        "content-type": "application/json",
        "x-coforge-capability": "test-desktop-capability",
      },
      body: JSON.stringify({ provider: { apiKey: "test-must-not-persist" } }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "CREDENTIAL_STORE_UNAVAILABLE",
    });
    expect(() => readFileSync(path.join(directory, "settings.json"), "utf8")).toThrow();
  });

  it("restores the old provider and key when the atomic settings rename fails", async () => {
    const settings = await loadSettings();
    settings.updateLocalSettings({
      provider: {
        baseURL: "https://old-provider.example/v1",
        model: "old-model",
        apiKey: "old-provider-key",
      },
    });
    renameSyncMock.mockImplementationOnce(() => {
      throw new Error("forced atomic rename failure");
    });

    expect(() => settings.updateLocalSettings({
      provider: {
        baseURL: "https://new-provider.example/v1",
        model: "new-model",
        apiKey: "new-provider-key",
      },
    })).toThrow(/forced atomic rename failure/);

    expect(settings.getEffectiveProviderSettings()).toMatchObject({
      baseURL: "https://old-provider.example/v1",
      model: "old-model",
      apiKey: "old-provider-key",
    });
    expect(settingsText()).not.toContain("new-provider-key");
  });

  it("fails closed when a partial helper mutation cannot be rolled back", async () => {
    const settings = await loadSettings();
    settings.updateLocalSettings({
      provider: {
        baseURL: "https://old-provider.example/v1",
        model: "old-model",
        apiKey: "old-provider-key",
      },
    });
    writeFileSync(path.join(directory, "helper-failure.json"), JSON.stringify({
      afterWriteSecret: "new-provider-key",
      beforeWriteSecret: "old-provider-key",
    }));

    expect(() => settings.updateLocalSettings({
      provider: {
        baseURL: "https://new-provider.example/v1",
        model: "new-model",
        apiKey: "new-provider-key",
      },
    })).toThrow(/rollback.*credential/i);

    expect(JSON.parse(settingsText()).provider).toMatchObject({
      baseURL: "https://old-provider.example/v1",
      model: "old-model",
    });
    expect(() => settings.getEffectiveProviderSettings()).toThrow(/refused to use the API key/i);
  });
});
