"use client";

import { useEffect, useState } from "react";

export const METRIC_STORAGE_KEY = "coforge-metrics";

export type SavedMetric = { name: string; sql: string; chartConfig: unknown };

const DEFAULT_METRICS: SavedMetric[] = [
  {
    name: "在途船风险清单",
    sql: `SELECT c.vessel_name, cs.coal_type, c.quantity_mt, c.eta, c.status, c.demurrage_days, ROUND(c.price_usd_t + c.freight_usd_t, 2) AS landed_cost_usd_t FROM cargoes c JOIN coal_specs cs ON cs.id = c.coal_spec_id WHERE c.status IN ('delayed', 'open', 'fixed') ORDER BY c.demurrage_days DESC, c.eta LIMIT 12`,
    chartConfig: { type: "bar", x_key: "vessel_name", y_key: "landed_cost_usd_t", title: "在途船风险清单" },
  },
  {
    name: "各来源到岸成本",
    sql: `SELECT cs.origin, cs.coal_type, COUNT(*) AS cargoes, ROUND(AVG(c.price_usd_t + c.freight_usd_t), 2) AS avg_landed_cost FROM cargoes c JOIN coal_specs cs ON cs.id = c.coal_spec_id GROUP BY cs.origin, cs.coal_type ORDER BY avg_landed_cost`,
    chartConfig: { type: "bar", x_key: "coal_type", y_key: "avg_landed_cost", title: "各来源平均到岸成本" },
  },
  {
    name: "月度指数趋势",
    sql: `SELECT index_name, strftime('%Y-%m', index_date) AS month, ROUND(AVG(value_usd_t), 2) AS index_value FROM price_indices GROUP BY index_name, month ORDER BY index_name, month LIMIT 500`,
    chartConfig: { type: "line", x_key: "month", y_key: "index_value", title: "月度煤价指数趋势" },
  },
  {
    name: "航线运价对比",
    sql: `SELECT r.route_name, fq.vessel_class, ROUND(AVG(fq.rate_usd_t), 2) AS avg_rate_usd_t, ROUND(AVG(fq.congestion_days), 2) AS avg_congestion_days FROM freight_quotes fq JOIN freight_routes r ON r.id = fq.route_id GROUP BY r.route_name, fq.vessel_class ORDER BY avg_rate_usd_t DESC`,
    chartConfig: { type: "bar", x_key: "route_name", y_key: "avg_rate_usd_t", title: "航线运价对比" },
  },
  {
    name: "库存结构",
    sql: `SELECT i.yard, cs.coal_type, i.stock_mt, ROUND(i.avg_cost_usd_t, 2) AS avg_cost_usd_t FROM inventory i JOIN coal_specs cs ON cs.id = i.coal_spec_id ORDER BY i.stock_mt DESC`,
    chartConfig: { type: "bar", x_key: "coal_type", y_key: "stock_mt", title: "库存结构" },
  },
  {
    name: "配煤方案成本",
    sql: `SELECT plan_name, target_nar, blended_cost_usd_t, sulfur_pct, ash_pct FROM blend_plans ORDER BY blended_cost_usd_t`,
    chartConfig: { type: "bar", x_key: "plan_name", y_key: "blended_cost_usd_t", title: "配煤方案成本" },
  },
];

function readMetrics(): SavedMetric[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(METRIC_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeMetrics(metrics: SavedMetric[]) {
  localStorage.setItem(METRIC_STORAGE_KEY, JSON.stringify(metrics));
}

export default function MetricSidebar({
  onRunMetric,
  variant = "sidebar",
  className = "",
}: {
  onRunMetric: (m: SavedMetric) => void;
  variant?: "sidebar" | "embedded";
  className?: string;
}) {
  const [metrics, setMetrics] = useState<SavedMetric[]>([]);

  useEffect(() => {
    let stored = readMetrics();
    if (stored.length === 0 || !stored.some((m) => m.name === "在途船风险清单")) {
      writeMetrics(DEFAULT_METRICS);
      stored = DEFAULT_METRICS;
    }
    setMetrics(stored);

    const handler = (e: StorageEvent) => { if (e.key === METRIC_STORAGE_KEY) setMetrics(readMetrics()); };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  function handleDelete(name: string) {
    const next = metrics.filter((m) => m.name !== name);
    writeMetrics(next);
    setMetrics(next);
  }

  const shellClass = variant === "embedded"
    ? `flex min-h-0 flex-col ${className}`
    : `hidden w-64 flex-col border-l lg:flex ${className}`;
  const title = "已保存指标";

  return (
    <aside className={shellClass} style={{ borderColor: "var(--border)", background: variant === "embedded" ? "transparent" : "var(--surface)" }}>
      <div className={variant === "embedded" ? "px-1 pb-2" : "border-b px-4 py-3"} style={{ borderColor: "var(--border)" }}>
        <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{title}</h2>
      </div>
      <div className={variant === "embedded" ? "min-h-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto p-2"}>
        {metrics.length > 0 ? (
          <ul className="space-y-0.5">
            {metrics.map((m) => (
              <li key={m.name} className="group flex items-center rounded-lg px-3 py-2 transition-default" style={{ color: "var(--text-secondary)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                <button onClick={() => onRunMetric(m)} className="flex-1 truncate text-left text-sm">{m.name}</button>
                <button onClick={() => handleDelete(m.name)} className="ml-2 text-xs opacity-0 transition-default group-hover:opacity-50 hover:!opacity-100" style={{ color: "var(--error)" }}>×</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>暂无已保存指标</p>
        )}
      </div>
    </aside>
  );
}
