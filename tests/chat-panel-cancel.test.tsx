import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => {
  const Component = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    Area: Component,
    AreaChart: Component,
    Bar: Component,
    BarChart: Component,
    CartesianGrid: Component,
    Cell: Component,
    Line: Component,
    LineChart: Component,
    Pie: Component,
    PieChart: Component,
    ResponsiveContainer: Component,
    Tooltip: Component,
    XAxis: Component,
    YAxis: Component,
  };
});

import ChatPanel from "../src/components/ChatPanel";

function abortableFetch() {
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  return { fetchMock, signal: () => signal };
}

async function submit(renderer: ReactTestRenderer, message = "测试取消") {
  const textarea = renderer.root.findByType("textarea");
  await act(async () => {
    textarea.props.onChange({ target: { value: message } });
  });
  const form = renderer.root.findByType("form");
  await act(async () => {
    form.props.onSubmit({ preventDefault: vi.fn() });
    await Promise.resolve();
  });
}

function buttonWithText(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").find((button) => button.children.join("") === text);
}

describe("ChatPanel request cancellation", () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    act(() => {
      renderer = create(<ChatPanel />);
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it("passes an AbortSignal to fetch and exposes a stop button while loading", async () => {
    const pending = abortableFetch();
    vi.stubGlobal("fetch", pending.fetchMock);

    await submit(renderer);

    expect(pending.fetchMock).toHaveBeenCalledOnce();
    expect(pending.signal()).toBeInstanceOf(AbortSignal);
    expect(pending.signal()?.aborted).toBe(false);
    expect(buttonWithText(renderer, "停止")).toBeDefined();
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  });

  it("aborts the active request without showing an error and returns to the send state", async () => {
    const pending = abortableFetch();
    vi.stubGlobal("fetch", pending.fetchMock);
    await submit(renderer);

    await act(async () => {
      buttonWithText(renderer, "停止")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pending.signal()?.aborted).toBe(true);
    expect(buttonWithText(renderer, "停止")).toBeUndefined();
    expect(buttonWithText(renderer, "发送")).toBeDefined();
    expect(renderer.root.findByType("textarea").props.disabled).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("请求出错");
  });

  it("aborts an active request when the component unmounts", async () => {
    const pending = abortableFetch();
    vi.stubGlobal("fetch", pending.fetchMock);
    await submit(renderer);

    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });

    expect(pending.signal()?.aborted).toBe(true);
  });
});
