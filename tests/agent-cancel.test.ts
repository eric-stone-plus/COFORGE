import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  queryPublicDb: vi.fn(),
  releaseTokenReservation: vi.fn(),
  reserveTokenBudget: vi.fn(() => "reservation-id"),
  settleTokenReservation: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ({}) }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => () => ({}) }));
vi.mock("../src/lib/db", () => ({ queryPublicDb: mocks.queryPublicDb }));
vi.mock("../src/lib/data-catalog", () => ({ publicSchemaPrompt: () => "synthetic schema" }));
vi.mock("../src/lib/provider-url-guard", () => ({ guardedProviderFetch: vi.fn() }));
vi.mock("../src/lib/local-settings", () => ({
  estimateTokenCount: (value: string) => Math.max(1, Math.ceil(value.length / 4)),
  getEffectiveProviderSettings: () => ({
    backend: "openai-compatible",
    providerName: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "custom-test-key",
    timeoutMs: 60_000,
    temperature: 0.1,
    configured: true,
  }),
  getPublicSettings: () => ({ tokenPlan: { monthlyBudget: 100_000 } }),
}));
vi.mock("../src/lib/token-ledger", () => ({
  releaseTokenReservation: mocks.releaseTokenReservation,
  reserveTokenBudget: mocks.reserveTokenBudget,
  settleTokenReservation: mocks.settleTokenReservation,
}));

function waitForAbort(options: unknown): Promise<never> {
  const signal = (options as { abortSignal: AbortSignal }).abortSignal;
  return new Promise((_, reject) => {
    const rejectWithReason = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) rejectWithReason();
    else signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserveTokenBudget.mockReturnValue("reservation-id");
});

describe("legacy agent cancellation", () => {
  it("does not query SQL after the initial provider generation is cancelled", async () => {
    mocks.generateText.mockImplementationOnce(waitForAbort);
    const abort = new AbortController();
    const { runAgent } = await import("../src/lib/agent");

    const pending = runAgent("分析库存", [], undefined, abort.signal);
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledOnce());
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    expect(mocks.releaseTokenReservation).toHaveBeenCalledOnce();
  });

  it("propagates cancellation from the JSON repair generation", async () => {
    mocks.generateText
      .mockResolvedValueOnce({ text: "not-json", usage: { totalTokens: 3 } })
      .mockImplementationOnce(waitForAbort);
    const abort = new AbortController();
    const { runAgent } = await import("../src/lib/agent");

    const pending = runAgent("分析航次", [], undefined, abort.signal);
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledTimes(2));
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
  });

  it("propagates cancellation while explaining an executed result", async () => {
    mocks.generateText
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thinking: "",
          intent: "库存分析",
          sql: "SELECT 1 AS value",
          chart_config: { type: "bar", x_key: "value", y_key: "value", title: "结果" },
          explanation: "fallback",
        }),
        usage: { totalTokens: 10 },
      })
      .mockImplementationOnce(waitForAbort);
    mocks.queryPublicDb.mockResolvedValueOnce({
      ok: true,
      executedSql: "SELECT 1 AS value LIMIT 500",
      rows: [{ value: 1 }],
      error: null,
      meta: { queryId: "query-id", source: "agent" },
    });
    const abort = new AbortController();
    const { runAgent } = await import("../src/lib/agent");

    const pending = runAgent("解释结果", [], undefined, abort.signal);
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledTimes(2));
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.queryPublicDb).toHaveBeenCalledOnce();
  });

  it("propagates cancellation from a conversational answer generation", async () => {
    mocks.generateText.mockImplementationOnce(waitForAbort);
    const progress = vi.fn();
    const abort = new AbortController();
    const { runConversationalAnswer } = await import("../src/lib/agent");

    const pending = runConversationalAnswer("继续解释", [], progress, abort.signal);
    await vi.waitFor(() => expect(mocks.generateText).toHaveBeenCalledOnce());
    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ step: "done" }));
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    expect(mocks.releaseTokenReservation).toHaveBeenCalledOnce();
  });

  it("does not start result explanation after cancellation during SQL execution", async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: JSON.stringify({
        thinking: "",
        intent: "库存分析",
        sql: "SELECT 1 AS value",
        chart_config: { type: "bar", x_key: "value", y_key: "value", title: "结果" },
        explanation: "fallback",
      }),
      usage: { totalTokens: 10 },
    });
    let finishQuery!: (value: unknown) => void;
    mocks.queryPublicDb.mockImplementationOnce(() => new Promise((resolve) => {
      finishQuery = resolve;
    }));
    const progress = vi.fn();
    const abort = new AbortController();
    const { runAgent } = await import("../src/lib/agent");

    const pending = runAgent("查询后停止", [], progress, abort.signal);
    await vi.waitFor(() => expect(mocks.queryPublicDb).toHaveBeenCalledOnce());
    abort.abort();
    finishQuery({
      ok: true,
      executedSql: "SELECT 1 AS value LIMIT 500",
      rows: [{ value: 1 }],
      error: null,
      meta: { queryId: "query-id", source: "agent" },
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ step: "done" }));
  });
});
