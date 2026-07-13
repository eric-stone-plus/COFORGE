import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const { providerFetchMock } = vi.hoisted(() => ({
  providerFetchMock: vi.fn(),
}));

vi.mock("../src/lib/provider-url-guard", () => ({
  guardedProviderFetch: providerFetchMock,
}));

const PROVIDER_ENV_KEYS = [
  "AI_BACKEND",
  "AI_PROVIDER_NAME",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_API_KEY",
  "AI_TIMEOUT_MS",
  "AI_TEMPERATURE",
  "COFORGE_CONFIG_DIR",
  "COFORGE_TOKEN_LEDGER_PATH",
  "COFORGE_DESKTOP",
  "COFORGE_ALLOW_ENV_PROVIDER",
] as const;

const originalEnv = Object.fromEntries(
  PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PROVIDER_ENV_KEYS)[number], string | undefined>;

let configDir = "";
const ledgerClosers: Array<() => void> = [];

function clearProviderEnv() {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
}

function configureEnvironmentProvider(baseURL: string, model: string) {
  process.env.AI_BACKEND = "openai-compatible";
  process.env.AI_PROVIDER_NAME = "openai-compatible";
  process.env.AI_BASE_URL = baseURL;
  process.env.AI_MODEL = model;
  process.env.AI_API_KEY = "test-api-key";
  process.env.AI_TIMEOUT_MS = "2500";
  process.env.AI_TEMPERATURE = "0.1";
}

function successfulChatResponse(model: string) {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "连接正常" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearProviderEnv();
  configDir = mkdtempSync(path.join(tmpdir(), "coforge-deepseek-defaults-"));
  process.env.COFORGE_CONFIG_DIR = configDir;
  process.env.COFORGE_TOKEN_LEDGER_PATH = path.join(configDir, "token-ledger.sqlite");
  providerFetchMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const close of ledgerClosers.splice(0)) close();
  clearProviderEnv();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  rmSync(configDir, { recursive: true, force: true });
});

async function loadSettingsModule() {
  const settings = await import("../src/lib/local-settings");
  const ledger = await import("../src/lib/token-ledger");
  ledgerClosers.push(ledger.closeTokenLedgerForTests);
  return settings;
}

async function captureConversationalRequest(baseURL: string, model: string) {
  configureEnvironmentProvider(baseURL, model);
  let requestBody: Record<string, unknown> | undefined;
  providerFetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(typeof init?.body).toBe("string");
    requestBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return successfulChatResponse(model);
  });

  const { runConversationalAnswer } = await import("../src/lib/agent");
  await runConversationalAnswer("测试模型连接");
  const { closeTokenLedgerForTests } = await import("../src/lib/token-ledger");
  ledgerClosers.push(closeTokenLedgerForTests);
  expect(providerFetchMock).toHaveBeenCalledOnce();
  return requestBody;
}

describe("DeepSeek provider defaults", () => {
  it("uses a complete AI_* environment provider when no settings file exists", async () => {
    configureEnvironmentProvider("https://api.deepseek.com", "deepseek-v4-pro");
    const { getEffectiveProviderSettings } = await loadSettingsModule();

    expect(getEffectiveProviderSettings()).toMatchObject({
      source: "env",
      backend: "openai-compatible",
      providerName: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "test-api-key",
      timeoutMs: 2500,
      temperature: 0.1,
      ready: true,
      configured: true,
    });
  });

  it("falls back to the official DeepSeek Pro default with no configuration", async () => {
    const { getEffectiveProviderSettings } = await loadSettingsModule();

    expect(getEffectiveProviderSettings()).toMatchObject({
      source: "default",
      backend: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "",
      ready: false,
      configured: false,
    });
  });

  it("shows product defaults without exposing hosted provider credentials", async () => {
    configureEnvironmentProvider("https://private-provider.example/v1", "private-model");
    process.env = { ...process.env, NODE_ENV: "production" };
    const { getPublicSettings } = await loadSettingsModule();

    expect(getPublicSettings().provider).toMatchObject({
      source: "default",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKeyConfigured: false,
      ready: false,
      configured: false,
    });
  });
});

describe("DeepSeek reasoning request", () => {
  it("serializes max reasoning effort for the official DeepSeek endpoint", async () => {
    const body = await captureConversationalRequest(
      "https://api.deepseek.com",
      "deepseek-v4-pro",
    );

    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      reasoning_effort: "max",
    });
  });

  it("does not send DeepSeek reasoning effort to another compatible provider", async () => {
    const body = await captureConversationalRequest(
      "https://api.example.com/v1",
      "example-chat-pro",
    );

    expect(body).toMatchObject({ model: "example-chat-pro" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("does not identify a lookalike hostname as the official DeepSeek endpoint", async () => {
    const body = await captureConversationalRequest(
      "https://api.deepseek.com.evil.example/v1",
      "deepseek-v4-pro",
    );

    expect(body).toMatchObject({ model: "deepseek-v4-pro" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("serializes the connection probe with DeepSeek thinking disabled", async () => {
    let requestBody: Record<string, unknown> | undefined;
    providerFetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(typeof init?.body).toBe("string");
      requestBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return successfulChatResponse("deepseek-v4-pro");
    });
    const provider = createOpenAICompatible({
      name: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      apiKey: "test-api-key",
      fetch: providerFetchMock,
    });

    await generateText({
      model: provider("deepseek-v4-pro"),
      system: "You are a connection probe. Reply with OK only.",
      prompt: "Return OK.",
      temperature: 0,
      providerOptions: { openaiCompatible: { thinking: { type: "disabled" } } },
      maxOutputTokens: 16,
    });

    expect(requestBody).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      max_tokens: 16,
    });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });
});

describe("DeepSeek account guidance", () => {
  it("shows BYOK billing guidance only for the DeepSeek service selection", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/components/LocalSettingsPanel.tsx"),
      "utf8",
    );

    expect(source).toMatch(/\{serviceId === "deepseek" && \([\s\S]*?使用自己的 DeepSeek 账户充值并创建 API key；费用与退款由 DeepSeek 按账户政策处理，COFORGE 不代收款。[\s\S]*?\)\}/);
  });
});
