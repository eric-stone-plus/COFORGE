import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runConversationalAnswer: vi.fn(),
  queryPublicDb: vi.fn(),
  getPublicSettings: vi.fn(),
  getEffectiveProviderSettings: vi.fn(),
  updateProviderConnectionStatus: vi.fn(),
  isReasonixDeepSeekProvider: vi.fn(() => false),
  isReasonixDesktopEnabled: vi.fn(() => false),
  runDesktopReasonixTurn: vi.fn(),
  shutdownDesktopReasonixRuntime: vi.fn(),
}));

vi.mock("@/lib/agent", () => ({
  runAgent: mocks.runAgent,
  runConversationalAnswer: mocks.runConversationalAnswer,
}));
vi.mock("@/lib/bounded-json", async () => import("../src/lib/bounded-json"));
vi.mock("@/lib/db", () => ({ queryPublicDb: mocks.queryPublicDb }));
vi.mock("@/lib/demo-cache", () => ({ CACHED_RESULTS: {} }));
vi.mock("@/lib/local-settings", () => ({
  getPublicSettings: mocks.getPublicSettings,
  getEffectiveProviderSettings: mocks.getEffectiveProviderSettings,
  updateProviderConnectionStatus: mocks.updateProviderConnectionStatus,
}));
vi.mock("@/lib/reasonix/orchestrator", () => ({
  isReasonixDeepSeekProvider: mocks.isReasonixDeepSeekProvider,
  isReasonixDesktopEnabled: mocks.isReasonixDesktopEnabled,
  runDesktopReasonixTurn: mocks.runDesktopReasonixTurn,
  shutdownDesktopReasonixRuntime: mocks.shutdownDesktopReasonixRuntime,
}));
vi.mock("@/lib/provider-error", async () => import("../src/lib/provider-error"));
vi.mock("@/lib/request-security", () => ({ enforceApiRequest: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  mocks.getPublicSettings.mockReturnValue({
    mode: "desktop",
    tokenPlan: { monthlyBudget: 100_000 },
    provider: {
      configured: true,
      ready: true,
      model: "test-model",
    },
  });
  mocks.getEffectiveProviderSettings.mockReturnValue({
    backend: "openai-compatible",
    baseURL: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "nonstandard-secret",
    configured: true,
  });
  mocks.isReasonixDeepSeekProvider.mockReturnValue(false);
  mocks.isReasonixDesktopEnabled.mockReturnValue(false);
  mocks.shutdownDesktopReasonixRuntime.mockResolvedValue(undefined);
  vi.useRealTimers();
});

describe("chat route cancellation", () => {
  it("does not let prior business context contaminate a standalone introduction fallback", async () => {
    mocks.getPublicSettings.mockReturnValueOnce({
      mode: "desktop",
      tokenPlan: { monthlyBudget: 100_000 },
      provider: { configured: false, ready: false, model: "deepseek-v4-pro" },
    });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({
        message: "在吗，介绍一下你自己",
        context: [{ question: "哪些航线的运价和拥堵风险最值得关注？", explanation: "船货风险清单" }],
      }),
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);
    const body = await response.text();

    expect(body).toContain("我是 COFORGE 的本地煤炭运营分析助手");
    expect(body).not.toContain("船货风险要先看");
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("keeps a business question that begins with a greeting in the business fallback", async () => {
    mocks.getPublicSettings.mockReturnValueOnce({
      mode: "desktop",
      tokenPlan: { monthlyBudget: 100_000 },
      provider: { configured: false, ready: false, model: "deepseek-v4-pro" },
    });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "你好，库存还能覆盖多少天？", context: [] }),
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);
    const body = await response.text();

    expect(body).toContain("库存不能只看总吨数");
    expect(body).not.toContain("我是 COFORGE 的本地煤炭运营分析助手");
  });

  it("recognizes polite standalone introductions without reusing business context", async () => {
    mocks.getPublicSettings.mockReturnValue({
      mode: "desktop",
      tokenPlan: { monthlyBudget: 100_000 },
      provider: { configured: false, ready: false, model: "deepseek-v4-pro" },
    });
    const { POST } = await import("../src/app/api/chat/route");

    for (const message of ["请介绍一下你自己吧", "你是谁呀？"]) {
      const response = await POST(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
        body: JSON.stringify({ message, context: [{ question: "上一轮船货风险" }] }),
      }));
      await expect(response.text()).resolves.toContain("我是 COFORGE 的本地煤炭运营分析助手");
    }
  });

  it("uses the conversational provider directly when Reasonix returns no assistant message for a greeting", async () => {
    mocks.isReasonixDesktopEnabled.mockReturnValue(true);
    mocks.isReasonixDeepSeekProvider.mockReturnValue(true);
    mocks.runDesktopReasonixTurn.mockRejectedValueOnce(
      new Error("Reasonix completed without an assistant message."),
    );
    mocks.runConversationalAnswer.mockResolvedValueOnce({
      thinking: "",
      intent: "自然语言煤炭运营追问",
      explanation: "在，我是 COFORGE。",
      conversational: true,
    });
    const { POST } = await import("../src/app/api/chat/route");
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "在吗？介绍一下你自己", context: [{ question: "上一轮船货风险" }] }),
    }));
    const body = await response.text();

    expect(body).toContain("在，我是 COFORGE");
    expect(body).toContain("reasonix_fallback");
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.runConversationalAnswer).toHaveBeenCalledOnce();
    expect(mocks.shutdownDesktopReasonixRuntime).toHaveBeenCalledOnce();
  });

  it("does not retry the provider for non-empty Reasonix errors", async () => {
    mocks.isReasonixDesktopEnabled.mockReturnValue(true);
    mocks.isReasonixDeepSeekProvider.mockReturnValue(true);
    mocks.runDesktopReasonixTurn.mockRejectedValueOnce(new Error("Provider returned 401 unauthorized"));
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "分析库存风险", context: [] }),
    }));
    const body = await response.text();

    expect(body).toContain("recoverable_error");
    expect(body).not.toContain("Reasonix 未返回正文");
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.runConversationalAnswer).not.toHaveBeenCalled();
    expect(mocks.shutdownDesktopReasonixRuntime).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionStatus).toHaveBeenCalledWith("error", expect.any(String));
  });

  it("opens an in-process circuit after an empty Reasonix turn", async () => {
    mocks.isReasonixDesktopEnabled.mockReturnValue(true);
    mocks.isReasonixDeepSeekProvider.mockReturnValue(true);
    mocks.runDesktopReasonixTurn.mockRejectedValueOnce(
      new Error("Reasonix completed without an assistant message."),
    );
    mocks.runAgent.mockResolvedValue({
      thinking: "",
      intent: "库存分析",
      explanation: "库存分析结果",
      sql: "SELECT 1",
      data: [{ value: 1 }],
    });
    const { POST } = await import("../src/app/api/chat/route");
    const ask = (message: string) => POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message, context: [] }),
    }));

    await (await ask("分析本月库存风险")).text();
    await (await ask("分析下月库存风险")).text();

    expect(mocks.runDesktopReasonixTurn).toHaveBeenCalledOnce();
    expect(mocks.shutdownDesktopReasonixRuntime).toHaveBeenCalledOnce();
    expect(mocks.runAgent).toHaveBeenCalledTimes(2);
  });

  it("retries Reasonix after the empty-response circuit cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T08:00:00Z"));
    mocks.isReasonixDesktopEnabled.mockReturnValue(true);
    mocks.isReasonixDeepSeekProvider.mockReturnValue(true);
    mocks.runDesktopReasonixTurn
      .mockRejectedValueOnce(new Error("Reasonix completed without an assistant message."))
      .mockResolvedValueOnce({
        thinking: "",
        intent: "Reasonix 煤炭运营分析",
        explanation: "Reasonix 已恢复",
        conversational: true,
        runtime: { engine: "reasonix", version: "fixture" },
      });
    mocks.runAgent.mockResolvedValueOnce({
      thinking: "",
      intent: "库存分析",
      explanation: "直连兜底",
      sql: "SELECT 1",
      data: [{ value: 1 }],
    });
    const { POST } = await import("../src/app/api/chat/route");
    const ask = () => POST(new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "分析库存风险", context: [] }),
    }));

    await (await ask()).text();
    vi.advanceTimersByTime(10 * 60_000);
    const body = await (await ask()).text();

    expect(body).toContain("Reasonix 已恢复");
    expect(mocks.runDesktopReasonixTurn).toHaveBeenCalledTimes(2);
  });

  it("propagates request cancellation and suppresses late progress, fallback, SQL, and status writes", async () => {
    let agentSignal: AbortSignal | undefined;
    mocks.runAgent.mockImplementation((_message, _context, progress, signal: AbortSignal) => {
      agentSignal = signal;
      progress({ step: "analyzing", message: "early progress" });
      return (
      new Promise((_, reject) => {
        const rejectWithReason = () => {
          try {
            progress({ step: "done", message: "late progress" });
          } catch (error) {
            reject(error);
            return;
          }
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) rejectWithReason();
        else signal.addEventListener("abort", rejectWithReason, { once: true });
      })
      );
    });
    const abort = new AbortController();
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "取消这次分析", context: [] }),
      signal: abort.signal,
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
    expect(agentSignal?.aborted).toBe(false);
    abort.abort();

    const body = await response.text();
    expect(agentSignal?.aborted).toBe(true);
    expect(body).toContain("early progress");
    expect(body).not.toContain("late progress");
    await vi.waitFor(() => {
      expect(mocks.runConversationalAnswer).not.toHaveBeenCalled();
      expect(mocks.updateProviderConnectionStatus).not.toHaveBeenCalled();
      expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    });
  });

  it("treats a direct AbortError from the primary agent as cancellation", async () => {
    mocks.runAgent.mockRejectedValueOnce(new DOMException("Provider aborted", "AbortError"));
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "停止分析", context: [] }),
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);

    await expect(response.text()).resolves.toBe("");
    expect(mocks.runConversationalAnswer).not.toHaveBeenCalled();
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionStatus).not.toHaveBeenCalled();
  });

  it("treats a direct AbortError from the conversational fallback as cancellation", async () => {
    mocks.runAgent.mockRejectedValueOnce(new Error("Primary generation failed"));
    mocks.runConversationalAnswer.mockRejectedValueOnce(new DOMException("Fallback aborted", "AbortError"));
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "停止兜底分析", context: [{ question: "上一问" }] }),
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);

    await expect(response.text()).resolves.toBe("");
    expect(mocks.runConversationalAnswer).toHaveBeenCalledOnce();
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionStatus).not.toHaveBeenCalled();
  });

  it("aborts upstream work when the response body consumer cancels", async () => {
    let agentSignal: AbortSignal | undefined;
    mocks.runAgent.mockImplementation((_message, _context, _progress, signal: AbortSignal) => {
      agentSignal = signal;
      return new Promise((_, reject) => {
        const rejectWithReason = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) rejectWithReason();
        else signal.addEventListener("abort", rejectWithReason, { once: true });
      });
    });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: JSON.stringify({ message: "取消响应流", context: [] }),
    });
    const { POST } = await import("../src/app/api/chat/route");

    const response = await POST(request);
    await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledOnce());
    expect(agentSignal?.aborted).toBe(false);

    await response.body?.cancel("consumer cancelled");

    await vi.waitFor(() => expect(agentSignal?.aborted).toBe(true));
    expect(mocks.runConversationalAnswer).not.toHaveBeenCalled();
    expect(mocks.queryPublicDb).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnectionStatus).not.toHaveBeenCalled();
  });
});
