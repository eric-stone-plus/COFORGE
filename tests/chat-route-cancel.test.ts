import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runConversationalAnswer: vi.fn(),
  queryPublicDb: vi.fn(),
  getPublicSettings: vi.fn(),
  getEffectiveProviderSettings: vi.fn(),
  updateProviderConnectionStatus: vi.fn(),
  runDesktopReasonixTurn: vi.fn(),
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
  isReasonixDeepSeekProvider: () => false,
  isReasonixDesktopEnabled: () => false,
  runDesktopReasonixTurn: mocks.runDesktopReasonixTurn,
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
});

describe("chat route cancellation", () => {
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
