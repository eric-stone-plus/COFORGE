import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createOpenAICompatible: vi.fn(() => (model: string) => ({ model })),
  reserveTokenBudget: vi.fn(() => "reservation-id"),
  settleTokenReservation: vi.fn(),
  releaseTokenReservation: vi.fn(),
  updateProviderConnectionStatus: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => (model: string) => ({ model }) }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: mocks.createOpenAICompatible }));
vi.mock("@/lib/provider-url-guard", () => ({ guardedProviderFetch: vi.fn() }));
vi.mock("@/lib/provider-identity", async () => import("../src/lib/provider-identity"));
vi.mock("@/lib/provider-error", () => ({
  compactProviderError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock("@/lib/request-security", () => ({ enforceApiRequest: () => null }));
vi.mock("@/lib/local-settings", () => ({
  estimateTokenCount: () => 7,
  getEffectiveProviderSettings: () => ({
    backend: "openai-compatible",
    providerName: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    apiKey: "fixture-secret",
    model: "deepseek-v4-pro",
    timeoutMs: 30_000,
    ready: true,
  }),
  getPublicSettings: () => ({ tokenPlan: { monthlyBudget: 100_000 } }),
  isSettingsWritable: () => true,
  updateProviderConnectionStatus: mocks.updateProviderConnectionStatus,
}));
vi.mock("@/lib/token-ledger", () => ({
  reserveTokenBudget: mocks.reserveTokenBudget,
  settleTokenReservation: mocks.settleTokenReservation,
  releaseTokenReservation: mocks.releaseTokenReservation,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.reserveTokenBudget.mockReturnValue("reservation-id");
  mocks.updateProviderConnectionStatus.mockReturnValue({ mode: "desktop" });
});

function request() {
  return new Request("http://localhost/api/settings/test", {
    method: "POST",
    headers: { Host: "localhost", Origin: "http://localhost" },
  });
}

describe("provider connection probe", () => {
  it("disables DeepSeek thinking, reserves the full output allowance, and accepts only OK", async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: "OK",
      usage: { inputTokens: 11, outputTokens: 1, totalTokens: 12 },
    });
    const { POST } = await import("../src/app/api/settings/test/route");

    const response = await POST(request());
    const options = mocks.generateText.mock.calls[0][0];

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, message: "基础连接可用" });
    expect(mocks.reserveTokenBudget).toHaveBeenCalledWith(23, 100_000);
    expect(options).toMatchObject({
      maxOutputTokens: 16,
      providerOptions: { openaiCompatible: { thinking: { type: "disabled" } } },
    });
    expect(options).not.toHaveProperty("reasoning");
    expect(mocks.settleTokenReservation).toHaveBeenCalledWith("reservation-id", {
      promptTokens: 11,
      completionTokens: 1,
      totalTokens: 12,
    });
    expect(mocks.releaseTokenReservation).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionStatus).toHaveBeenCalledWith("ok", "基础连接可用：deepseek-v4-pro");
  });

  it("settles reported usage before rejecting an empty provider response", async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20 },
    });
    const { POST } = await import("../src/app/api/settings/test/route");

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toContain("empty or unexpected response");
    expect(mocks.settleTokenReservation).toHaveBeenCalledWith("reservation-id", {
      promptTokens: 11,
      completionTokens: 9,
      totalTokens: 20,
    });
    expect(mocks.releaseTokenReservation).not.toHaveBeenCalled();
  });
});
