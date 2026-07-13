"use client";

import { useEffect, useMemo, useState } from "react";
import { isOfficialDeepSeekBaseURL } from "@/lib/provider-identity";

type ProviderBackend = "auto" | "openai-compatible" | "anthropic";

type PublicSettings = {
  mode: "desktop" | "web-demo";
  writable: boolean;
  credentialStore: {
    backend: "macos-keychain" | "windows-credential-manager" | "unavailable";
    label: string;
    available: boolean;
    message: string;
  };
  provider: {
    backend: ProviderBackend;
    backendLabel: string;
    providerName: string;
    baseURL: string;
    model: string;
    timeoutMs: number;
    temperature: number;
    source: "local" | "env" | "default";
    ready: boolean;
    configured: boolean;
    testable: boolean;
    apiKeyConfigured: boolean;
    connectionStatus: "missing" | "untested" | "ok" | "error";
    connectionMessage: string;
    testedAt: string;
  };
  tokenPlan: {
    monthlyBudget: number;
  };
  usage: {
    period: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requestCount: number;
    reservedTokens: number;
    reservationOverrunTokens: number;
    remainingTokens: number;
    budgetPercent: number;
  };
};

const EMPTY_SETTINGS: PublicSettings = {
  mode: "web-demo",
  writable: false,
  credentialStore: {
    backend: "unavailable",
    label: "系统凭证库",
    available: false,
    message: "系统凭证库仅在打包后的桌面应用中可用；不会降级为明文存储。",
  },
  provider: {
    backend: "openai-compatible",
    backendLabel: "DeepSeek 官方 API",
    providerName: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    timeoutMs: 60000,
    temperature: 0.2,
    source: "default",
    ready: false,
    configured: false,
    testable: false,
    apiKeyConfigured: false,
    connectionStatus: "missing",
    connectionMessage: "请填写 DeepSeek API key；默认使用旗舰 Pro 模型与 Max 推理强度。",
    testedAt: "",
  },
  tokenPlan: { monthlyBudget: 100000 },
  usage: {
    period: "",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    reservedTokens: 0,
    reservationOverrunTokens: 0,
    remainingTokens: 100000,
    budgetPercent: 0,
  },
};

const BACKEND_OPTIONS: Array<{ id: ProviderBackend; label: string }> = [
  { id: "auto", label: "自动识别" },
  { id: "openai-compatible", label: "Chat Completions 兼容" },
  { id: "anthropic", label: "Anthropic Messages API" },
];

const MODEL_SERVICE_OPTIONS = [
  { id: "deepseek", label: "DeepSeek（默认 · Pro / Max）", baseURL: "https://api.deepseek.com", backend: "openai-compatible" as ProviderBackend, model: "deepseek-v4-pro" },
  { id: "custom", label: "其他服务 / 手动配置", baseURL: "", backend: "auto" as ProviderBackend, model: "" },
  { id: "moonshot", label: "Moonshot / Kimi", baseURL: "https://api.moonshot.cn/v1", backend: "openai-compatible" as ProviderBackend, model: "moonshot-v1-8k" },
  { id: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com/v1", backend: "anthropic" as ProviderBackend, model: "claude-sonnet-4-5" },
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", backend: "openai-compatible" as ProviderBackend, model: "gpt-4o-mini" },
];

function formatInt(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function formatTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeURL(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "").replace(/\/chat\/completions?$/i, "");
}

function inferDraftProvider(baseURL: string, backend: ProviderBackend) {
  const lower = normalizeURL(baseURL).toLowerCase();
  if (backend === "anthropic" || lower.includes("anthropic.com")) {
    return { backend: "anthropic" as ProviderBackend, model: "claude-sonnet-4-5", label: "Anthropic Messages API" };
  }
  if (isOfficialDeepSeekBaseURL(normalizeURL(baseURL))) {
    return { backend: "openai-compatible" as ProviderBackend, model: "deepseek-v4-pro", label: "Chat Completions 兼容" };
  }
  if (lower.includes("moonshot.cn")) {
    return { backend: "openai-compatible" as ProviderBackend, model: "moonshot-v1-8k", label: "Chat Completions 兼容" };
  }
  if (lower.includes("openai.com")) {
    return { backend: "openai-compatible" as ProviderBackend, model: "gpt-4o-mini", label: "Chat Completions 兼容" };
  }
  if (backend === "openai-compatible") {
    return { backend, model: "", label: "Chat Completions 兼容" };
  }
  return { backend: "auto" as ProviderBackend, model: "", label: "自动识别 / 通用模型 API" };
}

function serviceIdFromDraft(baseURL: string, backend: ProviderBackend) {
  const normalized = normalizeURL(baseURL).toLowerCase();
  const matched = MODEL_SERVICE_OPTIONS.find((item) => item.baseURL && normalizeURL(item.baseURL).toLowerCase() === normalized);
  if (matched) return matched.id;
  if (!normalized && backend === "auto") return "custom";
  return "custom";
}

function connectionMeta(status: PublicSettings["provider"]["connectionStatus"], ready: boolean) {
  if (!ready || status === "missing") {
    return { label: "未配置", color: "var(--text-muted)", bg: "var(--surface-hover)" };
  }
  if (status === "ok") {
    return { label: "连接可用", color: "var(--success)", bg: "rgba(26, 127, 55, 0.12)" };
  }
  if (status === "error") {
    return { label: "连接失败", color: "var(--error)", bg: "var(--error-soft)" };
  }
  return { label: "已保存未测试", color: "var(--warning)", bg: "var(--warning-soft)" };
}

function SettingInput({
  label,
  value,
  type = "text",
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string | number;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border px-3 text-sm outline-none transition-default disabled:opacity-60"
        style={{ borderColor: "var(--border)", background: "var(--surface-hover)", color: "var(--text)" }}
      />
    </label>
  );
}

export default function LocalSettingsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [settings, setSettings] = useState<PublicSettings>(EMPTY_SETTINGS);
  const [draft, setDraft] = useState({
    backend: "openai-compatible" as ProviderBackend,
    providerName: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "",
    timeoutMs: 60000,
    temperature: 0.2,
    monthlyBudget: 100000,
  });
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function loadSettings() {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = await res.json() as PublicSettings | { error?: string };
      if (!res.ok) {
        if ("error" in data && data.error) setStatus(data.error);
        return;
      }
      const loaded = data as PublicSettings;
      setSettings(loaded);
      setDraft((current) => ({
        ...current,
        backend: loaded.provider.backend || "auto",
        providerName: loaded.provider.providerName || "openai-compatible",
        baseURL: loaded.provider.baseURL || "",
        model: loaded.provider.model || "",
        timeoutMs: loaded.provider.timeoutMs || 60000,
        temperature: loaded.provider.temperature ?? 0.2,
        monthlyBudget: loaded.tokenPlan.monthlyBudget || 100000,
      }));
    } catch {
      setStatus("无法读取本机设置，请稍后重试。");
    }
  }

  useEffect(() => {
    loadSettings();
  }, [refreshKey]);

  useEffect(() => {
    if (open) loadSettings();
  }, [open]);

  const inferred = useMemo(() => inferDraftProvider(draft.baseURL, draft.backend), [draft.baseURL, draft.backend]);
  const serviceId = useMemo(() => serviceIdFromDraft(draft.baseURL, draft.backend), [draft.baseURL, draft.backend]);

  function statusAfterSave(data: PublicSettings) {
    if (data.provider.connectionStatus === "ok") return "已保存，当前连接仍可用";
    if (data.provider.connectionStatus === "missing") return data.provider.connectionMessage || "配置不完整，请选择模型服务并填写 key/token。";
    return "已保存，尚未测试连接";
  }

  async function testConnection() {
    setTesting(true);
    setStatus("正在测试连接...");
    try {
      const res = await fetch("/api/settings/test", { method: "POST" });
      const data = await res.json();
      if (data.settings) setSettings(data.settings as PublicSettings);
      if (!res.ok || !data.ok) throw new Error(data.error || "连接失败");
      setStatus("连接可用，已写入本机状态");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "连接失败");
      await loadSettings();
    } finally {
      setTesting(false);
    }
  }

  async function saveSettings(testAfter = false) {
    setSaving(true);
    setStatus(null);
    try {
      const backend = draft.backend === "auto" ? inferred.backend : draft.backend;
      const model = draft.model || inferred.model;
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            backend,
            providerName: backend === "anthropic" ? "anthropic" : "openai-compatible",
            baseURL: draft.baseURL,
            model,
            apiKey: draft.apiKey,
            timeoutMs: draft.timeoutMs,
            temperature: draft.temperature,
          },
          tokenPlan: {
            monthlyBudget: draft.monthlyBudget,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "设置保存失败");
      const saved = data as PublicSettings;
      setSettings(saved);
      setDraft((current) => ({
        ...current,
        backend: saved.provider.backend,
        providerName: saved.provider.providerName,
        baseURL: saved.provider.baseURL,
        model: saved.provider.model,
        apiKey: "",
        timeoutMs: saved.provider.timeoutMs,
        temperature: saved.provider.temperature,
        monthlyBudget: saved.tokenPlan.monthlyBudget,
      }));

      if (testAfter && saved.provider.ready) {
        setSaving(false);
        await testConnection();
        return;
      }
      setStatus(statusAfterSave(saved));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    if (!confirm("清除本机保存的 API key？")) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            backend: draft.backend,
            providerName: draft.providerName,
            baseURL: draft.baseURL,
            model: draft.model,
            clearApiKey: true,
            timeoutMs: draft.timeoutMs,
            temperature: draft.temperature,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "清除失败");
      setSettings(data as PublicSettings);
      setDraft((current) => ({ ...current, apiKey: "" }));
      setStatus("本机 API key 已清除");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "清除失败");
    } finally {
      setSaving(false);
    }
  }

  async function resetUsage() {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/token-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const usage = await res.json();
      if (!res.ok) throw new Error(usage.error || "重置失败");
      await loadSettings();
      setStatus("本地 token 用量已重置");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "重置失败");
    } finally {
      setSaving(false);
    }
  }

  const modeLabel = settings.mode === "desktop" ? "本地应用" : "扫码演示";
  const meta = connectionMeta(settings.provider.connectionStatus, settings.provider.ready);
  const writable = settings.writable;
  const testedAt = formatTime(settings.provider.testedAt);
  const sourceLabel = settings.provider.source === "local" ? "本机配置" : settings.provider.source === "env" ? "环境变量" : "未保存";
  const savedKeyLabel = settings.provider.apiKeyConfigured
    ? settings.provider.source === "env" ? "环境变量 key 已读取" : "本机 key 已保存"
    : "未保存 key";
  const showModelHint = Boolean(draft.baseURL && !draft.model && !inferred.model);
  const canWriteCredential = settings.credentialStore.available || (!draft.apiKey.trim() && !settings.provider.apiKeyConfigured);
  const canSaveAndTest = writable && canWriteCredential && Boolean(draft.baseURL.trim()) && Boolean(draft.apiKey.trim() || settings.provider.apiKeyConfigured);

  function applyModelService(serviceId: string) {
    const service = MODEL_SERVICE_OPTIONS.find((item) => item.id === serviceId);
    if (!service) return;
    setDraft((current) => ({
      ...current,
      backend: service.backend,
      baseURL: service.baseURL,
      model: service.model,
      providerName: service.backend === "anthropic" ? "anthropic" : "openai-compatible",
    }));
    if (service.id === "custom") setAdvancedOpen(true);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-default"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-hover)",
          color: "var(--text-secondary)",
        }}
        title="设置"
      >
        <span>设置</span>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
        <span className="hidden sm:inline" style={{ color: meta.color }}>{meta.label}</span>
        <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-50 max-h-[calc(100svh-88px)] w-[min(92vw,460px)] overflow-y-auto rounded-xl border shadow-2xl"
          role="menu"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>设置</h2>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                {writable ? "选择模型服务并填写 key/token。API URL 和 model 可在高级设置调整。" : "公开扫码页为只读演示，不保存访客凭证。"}
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="h-8 w-8 rounded-lg text-sm" style={{ color: "var(--text-muted)", background: "var(--surface-hover)" }}>×</button>
          </div>

          <div className="space-y-4 px-4 py-4" role="none">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>运行模式</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: "var(--text)" }}>{modeLabel}</p>
              </div>
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>调用次数</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: "var(--text)" }}>{formatInt(settings.usage.requestCount)}</p>
              </div>
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>预算占用</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: "var(--text)" }}>{settings.usage.budgetPercent}%</p>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
                <span>{formatInt(settings.usage.totalTokens)} / {formatInt(settings.tokenPlan.monthlyBudget)} tokens</span>
                <span>{settings.usage.period || "当前周期"}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--surface-hover)" }}>
                <div className="h-full rounded-full" style={{ width: `${settings.usage.budgetPercent}%`, background: settings.usage.budgetPercent > 85 ? "var(--warning)" : "var(--accent)" }} />
              </div>
              {settings.usage.reservedTokens > 0 && <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>进行中预留：{formatInt(settings.usage.reservedTokens)} tokens</p>}
              {settings.usage.reservationOverrunTokens > 0 && <p className="mt-1 text-[11px]" style={{ color: "var(--warning)" }}>模型上报用量曾超出预留：{formatInt(settings.usage.reservationOverrunTokens)} tokens；后续调用已受预算闸门限制。</p>}
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: "var(--border)", background: meta.bg }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>模型连接状态 · {sourceLabel}</p>
                  <p className="mt-1 text-sm font-semibold" style={{ color: meta.color }}>{meta.label}</p>
                </div>
                {testedAt && <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{testedAt}</span>}
              </div>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                {settings.provider.connectionMessage}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>模型服务</span>
                <select
                  disabled={!writable}
                  value={serviceId}
                  onChange={(event) => applyModelService(event.target.value)}
                  className="h-9 w-full rounded-lg border px-3 text-sm outline-none transition-default disabled:opacity-60"
                  style={{ borderColor: "var(--border)", background: "var(--surface-hover)", color: "var(--text)" }}
                >
                  {MODEL_SERVICE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div>
                <SettingInput
                  label={settings.provider.apiKeyConfigured ? `API key / token（${savedKeyLabel}，留空不覆盖）` : "API key / token"}
                  value={draft.apiKey}
                  disabled={!writable || !settings.credentialStore.available}
                  type="password"
                  placeholder={settings.credentialStore.available ? `保存在 ${settings.credentialStore.label}` : "系统凭证库不可用"}
                  onChange={(value) => setDraft((d) => ({ ...d, apiKey: value }))}
                />
                {settings.provider.apiKeyConfigured && writable && (
                  <button
                    type="button"
                    onClick={clearApiKey}
                    disabled={saving}
                    className="mt-2 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}
                  >
                    清除本机 API key
                  </button>
                )}
                <p className="mt-2 text-[11px] leading-relaxed" style={{ color: settings.credentialStore.available ? "var(--success)" : "var(--warning)" }}>
                  {settings.credentialStore.message}
                </p>
                {serviceId === "deepseek" && (
                  <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
                    使用自己的 DeepSeek 账户充值并创建 API key；费用与退款由 DeepSeek 按账户政策处理，COFORGE 不代收款。
                  </p>
                )}
              </div>
              <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border)", background: "var(--surface-hover)", color: "var(--text-secondary)" }}>
                当前识别：{draft.baseURL ? inferred.label : "未选择模型服务"}{(draft.model || inferred.model) ? ` · ${(draft.model || inferred.model)}` : draft.baseURL ? " · 需要在高级设置填写 model" : ""}
              </div>
              {showModelHint && (
                <p className="text-xs" style={{ color: "var(--warning)" }}>这个 API URL 无法自动匹配 model，请展开高级设置后手动填写。</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium"
              style={{ borderColor: "var(--border)", background: "var(--surface-hover)", color: "var(--text-secondary)" }}
            >
              <span>高级设置</span>
              <span>{advancedOpen ? "收起" : "展开"}</span>
            </button>

            {advancedOpen && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <SettingInput
                    label="API URL"
                    value={draft.baseURL}
                    disabled={!writable}
                    placeholder="https://api.example.com/v1"
                    onChange={(value) => {
                      const next = inferDraftProvider(value, draft.backend);
                      setDraft((d) => ({
                        ...d,
                        baseURL: value,
                        model: next.model || d.model,
                        backend: d.backend === "auto" ? "auto" : d.backend,
                      }));
                    }}
                  />
                </div>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>后端类型</span>
                  <select
                    disabled={!writable}
                    value={draft.backend}
                    onChange={(event) => {
                      const backend = event.target.value as ProviderBackend;
                      const next = inferDraftProvider(draft.baseURL, backend);
                      setDraft((d) => ({ ...d, backend, model: next.model || d.model }));
                    }}
                    className="h-9 w-full rounded-lg border px-3 text-sm outline-none transition-default disabled:opacity-60"
                    style={{ borderColor: "var(--border)", background: "var(--surface-hover)", color: "var(--text)" }}
                  >
                    {BACKEND_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="sm:col-span-2">
                  <SettingInput label="模型名称" value={draft.model} disabled={!writable} placeholder={inferred.model || "provider-model-name"} onChange={(value) => setDraft((d) => ({ ...d, model: value }))} />
                </div>
                <SettingInput label="超时时间 ms" value={draft.timeoutMs} disabled={!writable} type="number" onChange={(value) => setDraft((d) => ({ ...d, timeoutMs: Number(value) || 60000 }))} />
                <SettingInput label="温度参数" value={draft.temperature} disabled={!writable} type="number" onChange={(value) => setDraft((d) => ({ ...d, temperature: Number(value) }))} />
                <div className="sm:col-span-2">
                  <SettingInput label="月度 token 预算" value={draft.monthlyBudget} disabled={!writable} type="number" onChange={(value) => setDraft((d) => ({ ...d, monthlyBudget: Number(value) || 100000 }))} />
                </div>
              </div>
            )}

            {status && <p className="rounded-lg px-3 py-2 text-xs" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)" }}>{status}</p>}
          </div>

          <div className="flex items-center justify-between border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <button type="button" onClick={resetUsage} disabled={!writable || saving || testing} className="rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)" }}>重置用量</button>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-xs font-medium" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)" }}>关闭</button>
              <button type="button" onClick={() => saveSettings(false)} disabled={!writable || saving || testing || (Boolean(draft.apiKey.trim()) && !settings.credentialStore.available)} className="rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)" }}>{saving ? "保存中..." : "保存"}</button>
              <button type="button" onClick={() => saveSettings(true)} disabled={!canSaveAndTest || saving || testing} className="rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-50" style={{ background: "var(--accent)" }}>{testing ? "测试中..." : "保存并测试"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
