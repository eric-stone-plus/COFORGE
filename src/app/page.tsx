"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import ChatPanel, { ChatResult } from "@/components/ChatPanel";
import BusinessCalculator from "@/components/BusinessCalculator";
import LocalSettingsPanel from "@/components/LocalSettingsPanel";
import MetricSidebar, { SavedMetric } from "@/components/MetricSidebar";
import type { DashboardSummary, ModuleSummary } from "@/lib/co-modules";

const COLORS = ["#4e8cff", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee", "#fb923c", "#a1a1aa"];

function KpiCard({ label, value, icon, sub }: { label: string; value: string; icon: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base font-semibold sm:h-9 sm:w-9" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</p>
        <p className="whitespace-nowrap text-[13px] font-bold sm:text-sm" style={{ color: "var(--text)" }}>{value}</p>
        {sub && <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{sub}</p>}
      </div>
    </div>
  );
}

function ChartCard({ title, children, bodyClassName = "h-44" }: { title: string; children: React.ReactNode; bodyClassName?: string }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text)" }}>{title}</h3>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="text-right text-xs font-semibold" style={{ color: color || "var(--text)" }}>{value}</span>
    </div>
  );
}

type ModuleId = ModuleSummary["id"];

const MODULE_PROMPTS: Record<ModuleId, string> = {
  covista: "把当前在途船按 ETA、滞期天数和到岸成本排一个风险优先级。",
  cofare: "哪些航线的运价和拥堵风险最值得关注？",
  corice: "当前 active/planned 合同相对指数是偏贵还是偏便宜？",
  coblop: "在硫分和灰分受控的前提下，哪个配煤方案最划算？",
  coswap: "如果 delayed 船赶不上交付，哪条候选船最适合替换？",
};

const FALLBACK_MODULES: ModuleSummary[] = [
  { id: "covista", name: "COVISTA", title: "船货状态分析", description: "ETA、状态、滞期和到岸成本关注清单。", status: "等待数据", method: "status-risk-heuristic", version: "1.0.0-demo", assumptions: [], metrics: [{ label: "状态", value: "等待加载" }], records: [] },
  { id: "cofare", name: "COFARE", title: "航线运价分析", description: "航线运价、船型和拥堵风险对比。", status: "等待数据", method: "historical-route-descriptive", version: "1.0.0-demo", assumptions: [], metrics: [{ label: "状态", value: "等待加载" }], records: [] },
  { id: "corice", name: "CORICE", title: "滚动指数成本", description: "合同价格与指数口径的采购成本观察。", status: "等待数据", method: "contract-index-spread-snapshot", version: "1.0.0-demo", assumptions: [], metrics: [{ label: "状态", value: "等待加载" }], records: [] },
  { id: "coblop", name: "COBLOP", title: "配煤方案筛选", description: "质量约束下的配煤方案成本筛选。", status: "等待数据", method: "precomputed-plan-filter", version: "1.0.0-demo", assumptions: [], metrics: [{ label: "状态", value: "等待加载" }], records: [] },
  { id: "coswap", name: "COSWAP", title: "延误替代评估", description: "延误船货替代和换船风险评分。", status: "等待数据", method: "candidate-risk-heuristic", version: "1.0.0-demo", assumptions: [], metrics: [{ label: "状态", value: "等待加载" }], records: [] },
];

const RECORD_COLUMNS: Record<ModuleId, Array<{ key: string; label: string }>> = {
  covista: [
    { key: "vessel_name", label: "船名" },
    { key: "coal_type", label: "煤种" },
    { key: "quantity_mt", label: "数量" },
    { key: "eta", label: "ETA" },
  ],
  cofare: [
    { key: "route_name", label: "航线" },
    { key: "vessel_class", label: "船型" },
    { key: "avg_rate_usd_t", label: "运价" },
    { key: "avg_congestion_days", label: "等待" },
  ],
  corice: [
    { key: "contract_no", label: "合同" },
    { key: "coal_type", label: "煤种" },
    { key: "delivery_month", label: "月份" },
    { key: "fixed_vs_index_usd_t", label: "价差" },
  ],
  coblop: [
    { key: "plan_name", label: "方案" },
    { key: "target_nar", label: "NAR" },
    { key: "blended_cost_usd_t", label: "成本" },
    { key: "quality_status", label: "质量" },
  ],
  coswap: [
    { key: "delayed_vessel", label: "延误船" },
    { key: "candidate_vessel", label: "替代船" },
    { key: "cost_delta_usd_t", label: "价差" },
    { key: "swap_risk_score", label: "风险" },
  ],
};

function formatRecordValue(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
  return String(value);
}

function toneColor(tone: ModuleSummary["metrics"][number]["tone"]) {
  if (tone === "bad") return "var(--error)";
  if (tone === "warn") return "var(--warning)";
  if (tone === "good") return "var(--success)";
  return "var(--text)";
}

const MODULE_ICONS: Record<ModuleId, string> = {
  covista: "CV",
  cofare: "FR",
  corice: "IX",
  coblop: "BL",
  coswap: "SW",
};

function ModuleNavButton({
  module,
  active,
  onSelect,
  compact = false,
}: {
  module: ModuleSummary;
  active: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-w-0 rounded-lg border text-left transition-default ${compact ? "w-[168px] shrink-0 px-3 py-2" : "w-full px-3 py-2.5"}`}
      style={{
        borderColor: active ? "var(--accent)" : "var(--border)",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-secondary)",
      }}
    >
      <span className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold" style={{ background: active ? "var(--accent)" : "var(--surface-hover)", color: active ? "#fff" : "var(--text-muted)" }}>
          {MODULE_ICONS[module.id]}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold">{module.name}</span>
          <span className="mt-0.5 block truncate text-[10px]" style={{ color: active ? "var(--accent)" : "var(--text-muted)" }}>{module.title}</span>
        </span>
      </span>
    </button>
  );
}

function ModuleRecordTable({ module }: { module: ModuleSummary }) {
  const records = module.records.slice(0, 5);
  const columns = RECORD_COLUMNS[module.id].filter((column) => records.some((record) => column.key in record));

  if (!records.length || !columns.length) return null;

  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <table className="w-full table-fixed text-[10px]" style={{ color: "var(--text-secondary)" }}>
        <thead style={{ background: "var(--surface-hover)" }}>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="truncate px-2 py-1.5 text-left font-medium">{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, index) => (
            <tr key={index} style={{ borderTop: "1px solid var(--border)" }}>
              {columns.map((column) => (
                <td key={column.key} className="truncate px-2 py-1.5" title={formatRecordValue(record[column.key])}>{formatRecordValue(record[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModuleDetailCard({
  module,
  onPrompt,
  compact = false,
}: {
  module: ModuleSummary;
  onPrompt: (text: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: compact ? "var(--surface-hover)" : "var(--surface)" }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: "var(--accent)" }}>{MODULE_ICONS[module.id]}</span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>{module.name}</h3>
              <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{module.title}</p>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>{module.description}</p>
        </div>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px]" style={{ background: "var(--success-soft)", color: "var(--success)" }}>{module.status}</span>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {module.metrics.slice(0, 4).map((metric) => (
          <div key={metric.label} className="rounded-lg border px-2.5 py-2" style={{ borderColor: "var(--border)", background: compact ? "var(--surface)" : "var(--surface-hover)" }}>
            <p className="truncate text-[10px]" style={{ color: "var(--text-muted)" }}>{metric.label}</p>
            <p className="mt-0.5 truncate text-xs font-semibold" style={{ color: toneColor(metric.tone) }}>{metric.value}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 rounded-lg border px-2.5 py-2 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
        方法：{module.method} · v{module.version}
        {module.assumptions.length > 0 && <span title={module.assumptions.join("；")}> · {module.assumptions.length} 条假设</span>}
      </div>

      {!compact && <div className="mb-3"><ModuleRecordTable module={module} /></div>}

      <button
        type="button"
        onClick={() => onPrompt(MODULE_PROMPTS[module.id])}
        className="h-9 w-full rounded-lg text-xs font-medium text-white transition-default"
        style={{ background: "var(--accent)" }}
      >
        用 {module.name} 生成分析问题
      </button>
    </div>
  );
}

function WorkbenchSidebar({
  modules,
  activeId,
  onSelect,
  onPrompt,
  onRunMetric,
}: {
  modules: ModuleSummary[];
  activeId: ModuleId;
  onSelect: (id: ModuleId) => void;
  onPrompt: (text: string) => void;
  onRunMetric: (m: SavedMetric) => void;
}) {
  const active = modules.find((module) => module.id === activeId) ?? modules[0];

  return (
    <aside className="hidden w-[310px] shrink-0 flex-col border-r lg:flex" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="border-b px-4 py-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: "linear-gradient(135deg, #3b7bfd, #7a5af8)" }}>CO</div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold" style={{ color: "var(--text)" }}>COFORGE</h1>
            <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>煤炭运营工具包</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <section className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>工具切换</h2>
            <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{modules.length} 个模块</span>
          </div>
          <div className="space-y-1">
            {modules.map((module) => (
              <ModuleNavButton key={module.id} module={module} active={module.id === active.id} onSelect={() => onSelect(module.id)} />
            ))}
          </div>
        </section>

        <section className="mb-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>当前工具</h2>
          <ModuleDetailCard module={active} onPrompt={onPrompt} compact />
        </section>

        <section className="mb-4 rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>运行链路</h2>
          <div className="space-y-2 text-xs" style={{ color: "var(--text-secondary)" }}>
            {["选择煤炭工具", "生成只读 SQL", "本地执行查询", "回填经营结论"].map((item, index) => (
              <div key={item} className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: "var(--surface)", color: "var(--accent)" }}>{index + 1}</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        <MetricSidebar onRunMetric={onRunMetric} variant="embedded" />
      </div>

      <div className="border-t px-4 py-3 text-[11px] leading-relaxed" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
        公开版本仅使用合成数据；真实接入应通过私有适配器管理权限、凭证和数据口径。
      </div>
    </aside>
  );
}

function MobileModuleStrip({
  modules,
  activeId,
  onSelect,
}: {
  modules: ModuleSummary[];
  activeId: ModuleId;
  onSelect: (id: ModuleId) => void;
}) {
  return (
    <div className="border-b px-3 py-2 lg:hidden" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>工具包</span>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>横向切换分析模块</span>
      </div>
      <div className="no-scrollbar flex gap-2 overflow-x-auto">
        {modules.map((module) => (
          <ModuleNavButton key={module.id} module={module} active={module.id === activeId} onSelect={() => onSelect(module.id)} compact />
        ))}
      </div>
    </div>
  );
}

type QueryResult = Record<string, string | number | boolean | null>;

type QueryResponse =
  | { ok: true; rows: QueryResult[]; executedSql: string; evidence?: ChatResult["evidence"] }
  | { ok: false; rows: []; executedSql: null; error: { code: string; message: string } };

async function query(sql: string): Promise<QueryResponse> {
  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    if (res.ok && data.ok === true && Array.isArray(data.rows) && typeof data.executedSql === "string") {
      return { ok: true, rows: data.rows as QueryResult[], executedSql: data.executedSql, evidence: data.meta };
    }
    return {
      ok: false,
      rows: [],
      executedSql: null,
      error: {
        code: typeof data.error?.code === "string" ? data.error.code : "QUERY_FAILED",
        message: typeof data.error?.message === "string" ? data.error.message : "查询未能完成",
      },
    };
  } catch {
    return { ok: false, rows: [], executedSql: null, error: { code: "NETWORK_ERROR", message: "无法连接本地查询服务" } };
  }
}

export default function Home() {
  const [rerunResult, setRerunResult] = useState<ChatResult | null>(null);
  const [rerunResultEvent, setRerunResultEvent] = useState<{ id: number; question: string; result: ChatResult } | null>(null);
  const [history, setHistory] = useState<ChatResult[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [mobilePanel, setMobilePanel] = useState<"chat" | "dashboard">("chat");
  const [isDesktop, setIsDesktop] = useState(false);
  const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [activeModuleId, setActiveModuleId] = useState<ModuleId>("covista");
  const [suggestedPrompt, setSuggestedPrompt] = useState<{ text: string; id: number } | null>(null);

  const toggleTheme = useCallback(() => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("coforge-theme", next);
  }, [theme]);

  useEffect(() => {
    const saved = localStorage.getItem("coforge-theme") as "light" | "dark" | null;
    const initial = saved || "dark";
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/modules", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.modules) || !data.dashboard?.kpis) {
          throw new Error(data.error || `看板请求失败 (${res.status})`);
        }
        if (!active) return;
        setModules(data.modules);
        setDashboard(data.dashboard as DashboardSummary);
        setDashboardError(null);
        setActiveModuleId((current) => data.modules.some((item: ModuleSummary) => item.id === current) ? current : data.modules[0]?.id ?? current);
      } catch (error) {
        if (active) setDashboardError(error instanceof Error ? error.message : "看板加载失败");
      } finally {
        if (active) setDashboardLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function handleRunMetric(metric: SavedMetric) {
    setMobilePanel("chat");
    query(metric.sql).then((queryResult) => {
      const result: ChatResult = queryResult.ok && queryResult.rows.length
        ? {
          intent: `运行已保存指标：${metric.name}`,
          sql: queryResult.executedSql,
          data: queryResult.rows,
          chartConfig: metric.chartConfig as ChatResult["chartConfig"],
          explanation: `已按当前数据库重新运行指标「${metric.name}」，返回 ${queryResult.rows.length} 行；图表和 SQL 均对应本次实际执行结果。`,
          evidence: queryResult.evidence,
        }
        : queryResult.ok
          ? {
            intent: `运行已保存指标：${metric.name}`,
            sql: queryResult.executedSql,
            data: [],
            chartConfig: metric.chartConfig as ChatResult["chartConfig"],
            explanation: `已按当前数据库重新运行指标「${metric.name}」，本次实际查询返回 0 行。`,
            evidence: queryResult.evidence,
          }
        : {
          intent: `运行已保存指标：${metric.name}`,
          sql: undefined,
          data: [],
          chartConfig: metric.chartConfig as ChatResult["chartConfig"],
          error: queryResult.error.code,
          explanation: `指标「${metric.name}」运行失败：${queryResult.error.message}。没有用旧数据或静态解释替代本次结果。`,
        };
      setRerunResult(result);
      setRerunResultEvent((event) => ({ id: (event?.id ?? 0) + 1, question: `运行已保存指标：${metric.name}`, result }));
    });
  }

  function handleNewResult(result: ChatResult) {
    setHistory((h) => [...h, result]);
    setSettingsRefreshKey((key) => key + 1);
  }

  function handleModulePrompt(text: string) {
    setSuggestedPrompt({ text, id: Date.now() });
    setMobilePanel("chat");
  }

  const toolkitModules = modules.length ? modules : FALLBACK_MODULES;
  const activeModule = toolkitModules.find((module) => module.id === activeModuleId) ?? toolkitModules[0];
  const kpis = dashboard?.kpis;
  const indexData = dashboard?.indexTrend ?? [];
  const routes = dashboard?.routes ?? [];
  const statuses = dashboard?.statuses ?? [];
  const inventory = dashboard?.inventory ?? [];
  const blends = dashboard?.blends ?? [];
  const watchlist = dashboard?.watchlist ?? [];
  const dashboardStateError = dashboardError ?? dashboard?.error ?? null;
  const dashboardStale = Boolean(dashboard && (dashboard.stale || dashboardStateError));
  const dashboardWarning = dashboardStateError
    ? dashboard
      ? `数据刷新失败，继续显示上一快照：${dashboardStateError}`
      : `看板不可用：${dashboardStateError}`
    : dashboard?.stale
      ? `数据快照已过期或不完整：${dashboard.freshness.reason ?? "请检查数据源日期"}`
      : null;
  const delayedPercent = kpis?.cargoCount ? (kpis.delayedCargoes / kpis.cargoCount) * 100 : 0;
  const formatMt = (value = 0) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M t` : `${Math.round(value / 1000)}k t`;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row" style={{ background: "var(--bg)" }}>
      <WorkbenchSidebar
        modules={toolkitModules}
        activeId={activeModule.id}
        onSelect={setActiveModuleId}
        onPrompt={handleModulePrompt}
        onRunMetric={handleRunMetric}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
        <header className="sticky top-0 z-20 flex flex-col gap-3 border-b px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between lg:static lg:px-6" style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--surface) 92%, transparent)" }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white lg:hidden" style={{ background: "linear-gradient(135deg, #3b7bfd, #7a5af8)" }}>CO</div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold" style={{ color: "var(--text)" }}>煤炭运营智能分析工作台</h1>
              <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{activeModule.name} · {activeModule.title}</p>
            </div>
          </div>
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <span className="min-w-0 truncate text-xs sm:hidden" style={{ color: "var(--text-muted)" }}>合成煤炭样例 · 48 条船货</span>
            <span className="hidden min-w-0 text-xs sm:inline" style={{ color: "var(--text-muted)" }}>本地模型配置 · 只读 SQL · token 预算</span>
            <div className="flex shrink-0 items-center gap-2">
              <LocalSettingsPanel refreshKey={settingsRefreshKey} />
              <button onClick={toggleTheme} className="flex h-7 w-7 items-center justify-center rounded-lg text-sm transition-default" style={{ background: "var(--surface-hover)", color: "var(--text-muted)" }}
                title={theme === "light" ? "Dark mode" : "Light mode"}>
                {theme === "light" ? "☾" : "☀"}
              </button>
            </div>
          </div>
        </header>

        <div className="no-scrollbar grid grid-flow-col auto-cols-[minmax(150px,1fr)] gap-2 overflow-x-auto border-b px-3 py-2 sm:grid-flow-row sm:grid-cols-4 lg:grid-cols-8 lg:px-4" style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
          <KpiCard label="船货规模" value={formatMt(kpis?.cargoVolumeMt)} icon="CV" sub={`${kpis?.cargoCount ?? 0} 条合成船货`} />
          <KpiCard label="到岸成本" value={`$${(kpis?.avgLandedCostUsdT ?? 0).toFixed(1)}/t`} icon="LC" sub="煤价 + 海运费" />
          <KpiCard label="平均运费" value={`$${(kpis?.avgFreightUsdT ?? 0).toFixed(1)}/t`} icon="FR" sub="样例航线均值" />
          <KpiCard label="延误船货" value={String(kpis?.delayedCargoes ?? 0)} icon="DL" sub={`${delayedPercent.toFixed(1)}% 关注清单`} />
          <KpiCard label="库存规模" value={formatMt(kpis?.inventoryMt)} icon="ST" sub="分煤质库存" />
          <KpiCard label="有效合同" value={String(kpis?.activeContracts ?? 0)} icon="CT" sub="active + planned" />
          <KpiCard label="配煤方案" value={String(kpis?.blendPlans ?? 0)} icon="BL" sub="质量约束" />
          <KpiCard label="供应商" value={String(kpis?.suppliers ?? 0)} icon="SP" sub="公开演示样例" />
        </div>

        <MobileModuleStrip
          modules={toolkitModules}
          activeId={activeModule.id}
          onSelect={setActiveModuleId}
        />

        <div className="grid grid-cols-2 gap-1 border-b px-3 py-2 lg:hidden" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          {(["chat", "dashboard"] as const).map((panel) => {
            const active = mobilePanel === panel;
            return (
              <button
                key={panel}
                type="button"
                onClick={() => setMobilePanel(panel)}
                className="h-9 rounded-lg text-sm font-medium transition-default"
                style={{ background: active ? "var(--accent)" : "var(--surface-hover)", color: active ? "#fff" : "var(--text-secondary)" }}
              >
                {panel === "chat" ? "运营问答" : "看板"}
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
          <div className={`${mobilePanel === "chat" ? "flex" : "hidden"} min-h-0 flex-1 lg:flex`}>
            <ChatPanel onResult={handleNewResult} externalResult={rerunResult} externalResultEvent={rerunResultEvent} suggestedPrompt={suggestedPrompt} className="w-full" />
          </div>

          {(isDesktop || mobilePanel === "dashboard") && (
            <div key={`dashboard-${mobilePanel}`} className={`${mobilePanel === "dashboard" ? "block" : "hidden"} w-full border-t lg:block lg:w-[460px] lg:overflow-y-auto lg:border-l lg:border-t-0`} style={{ borderColor: "var(--border)", background: "var(--surface-hover)" }}>
              <div className="space-y-3 p-3">
                {(dashboardLoading || dashboardWarning) && (
                  <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: dashboardWarning ? "var(--warning)" : "var(--border)", background: "var(--surface)", color: dashboardWarning ? "var(--warning)" : "var(--text-muted)" }}>
                    {dashboardLoading ? "正在读取本地看板数据…" : dashboardWarning ?? "看板不可用"}
                  </div>
                )}
                <ModuleDetailCard module={activeModule} onPrompt={handleModulePrompt} />

                <BusinessCalculator />

                <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                  <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text)" }}>运营健康度</h3>
                  <MetricRow label="延误船货比例" value={`${delayedPercent.toFixed(1)}%`} color="var(--warning)" />
                  <MetricRow label="延误船货" value={`${kpis?.delayedCargoes ?? 0} 条`} />
                  <MetricRow label="库存覆盖" value={`${(kpis?.inventoryCoverDays ?? 0).toFixed(1)} 天 @ 16k t/日`} />
                  <MetricRow label="平均到岸成本" value={`$${(kpis?.avgLandedCostUsdT ?? 0).toFixed(1)}/t`} />
                  <MetricRow label="平均海运费" value={`$${(kpis?.avgFreightUsdT ?? 0).toFixed(1)}/t`} />
                  <MetricRow label="质量罚扣敞口" value={`$${Math.round((kpis?.qualityPenaltyUsd ?? 0) / 1000)}k 样例`} color="var(--warning)" />
                  <MetricRow label="低风险供应商" value={`${kpis?.lowRiskSuppliers ?? 0} / ${kpis?.suppliers ?? 0}`} color="var(--success)" />
                  <MetricRow label="数据状态" value={dashboardStale ? (dashboardStateError ? "刷新失败 / 旧快照" : "数据过期 / 不完整") : dashboard ? "已刷新" : "不可用"} color={dashboardStale ? "var(--warning)" : dashboard ? "var(--success)" : "var(--error)"} />
                </div>

                <ChartCard title="ICI4 印尼 4200 指数趋势">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={indexData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 12 }} />
                      <Area type="monotone" dataKey="index_value" stroke="#4e8cff" fill="rgba(78,140,255,.18)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ChartCard title="航线运价对比">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={routes} layout="vertical" margin={{ top: 4, right: 4, bottom: 0, left: 44 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                        <YAxis type="category" dataKey="route" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} width={72} />
                        <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 11 }} />
                        <Bar dataKey="rate" fill="#34d399" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>

                  <ChartCard title="船货状态分布" bodyClassName="h-64 sm:h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 11 }} />
                        <Pie data={statuses} dataKey="cargoes" nameKey="status" cx="50%" cy="50%" innerRadius={34} outerRadius={64} paddingAngle={2}>
                          {statuses.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </div>

                <ChartCard title="分煤质库存">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={inventory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="coal_type" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} interval={0} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 12 }} />
                      <Bar dataKey="stock_mt" radius={[4, 4, 0, 0]}>
                        {inventory.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                    <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text)" }}>船货关注清单</h3>
                    <table className="w-full text-xs" style={{ color: "var(--text-secondary)" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                          <th className="py-1 text-left font-medium">船名</th>
                          <th className="py-1 text-right font-medium">货量</th>
                          <th className="py-1 text-right font-medium">风险</th>
                        </tr>
                      </thead>
                      <tbody>
                        {watchlist.map((rawRow, index) => {
                          const row = rawRow as Record<string, unknown>;
                          return (
                          <tr key={`${row.vessel}-${index}`} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td className="max-w-[90px] truncate py-1">{String(row.vessel)}</td>
                            <td className="py-1 text-right">{typeof row.cargo_mt === "number" ? `${Math.round(row.cargo_mt / 1000)}k t` : String(row.cargo ?? "-")}</td>
                            <td className="py-1 text-right">{row.risk ? String(row.risk) : `${String(row.status)} · ${Number(row.risk_score).toFixed(0)}`}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <ChartCard title="配煤方案成本">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={blends} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="plan" tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} />
                        <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--border)", fontSize: 11 }} />
                        <Bar dataKey="cost" fill="#a78bfa" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </div>

                <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                  <h3 className="mb-2 text-xs font-semibold" style={{ color: "var(--text)" }}>演示数据边界</h3>
                  <MetricRow label="数据来源" value="合成煤炭运营样例" color="var(--accent)" />
                  <MetricRow label="快照生成" value={dashboard?.generatedAt ? new Date(dashboard.generatedAt).toLocaleString("zh-CN") : "-"} />
                  <MetricRow label="数据截至" value={dashboard?.asOf ?? "-"} />
                  <MetricRow label="时效校验" value={dashboard?.freshness.reason ?? (dashboard ? "各关键数据集均在 SLA 内" : "-")} color={dashboard?.stale ? "var(--warning)" : "var(--success)"} />
                  <MetricRow label="公司真实数据" value="未包含" color="var(--success)" />
                  <MetricRow label="数据库访问" value="本地只读 SQLite" />
                  <MetricRow label="模型凭证" value="BYOK，本地配置" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
