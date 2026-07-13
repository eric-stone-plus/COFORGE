import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { NextResponse } from "next/server";
import { guardedProviderFetch } from "@/lib/provider-url-guard";
import { compactProviderError } from "@/lib/provider-error";
import { enforceApiRequest } from "@/lib/request-security";
import {
  estimateTokenCount,
  getEffectiveProviderSettings,
  getPublicSettings,
  isSettingsWritable,
  updateProviderConnectionStatus,
} from "@/lib/local-settings";
import { releaseTokenReservation, reserveTokenBudget, settleTokenReservation } from "@/lib/token-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = enforceApiRequest(request, {
    minimumRole: "admin",
    rateLimit: { bucket: "provider-test", limit: 6, windowMs: 60_000 },
  });
  if (rejected) return rejected;

  if (!isSettingsWritable()) {
    return NextResponse.json(
      { error: "Settings are writable only in the local desktop app." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const settings = getEffectiveProviderSettings();
  if (!settings.ready) {
    return NextResponse.json(
      { ok: false, error: "缺少 API URL、API key/token 或 model。", settings: getPublicSettings() },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const provider = settings.backend === "anthropic"
    ? createAnthropic({
      name: settings.providerName || "anthropic",
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      fetch: guardedProviderFetch,
    })
    : createOpenAICompatible({
      name: settings.providerName || "openai-compatible",
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      fetch: guardedProviderFetch,
    });
  const system = "You are a connection probe. Reply with OK only.";
  const prompt = "Return OK.";
  let reservation = "";

  try {
    reservation = reserveTokenBudget(
      estimateTokenCount(`${system}\n${prompt}`) + 16,
      getPublicSettings().tokenPlan.monthlyBudget,
    );
    const { text, usage } = await generateText({
      model: provider(settings.model),
      system,
      prompt,
      temperature: 0,
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(Math.min(settings.timeoutMs, 15000)),
    });
    settleTokenReservation(reservation, {
      promptTokens: usage?.inputTokens ?? estimateTokenCount(`${system}\n${prompt}`),
      completionTokens: usage?.outputTokens ?? estimateTokenCount(text),
      totalTokens: usage?.totalTokens,
    });
    reservation = "";
    if (!/^ok[.!]?$/i.test(text.trim())) {
      throw new Error("Provider connection probe returned an empty or unexpected response");
    }

    const publicSettings = updateProviderConnectionStatus("ok", `基础连接可用：${settings.model}`);
    return NextResponse.json(
      { ok: true, message: "基础连接可用", settings: publicSettings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (reservation) releaseTokenReservation(reservation);
    const message = compactProviderError(error, settings.apiKey) || "连接失败。";
    const publicSettings = updateProviderConnectionStatus("error", message);
    return NextResponse.json(
      { ok: false, error: message, settings: publicSettings },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
