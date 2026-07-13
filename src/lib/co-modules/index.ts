import type Database from "better-sqlite3";
import { getDb } from "../db";

export type ModuleSummary = {
  id: "covista" | "cofare" | "corice" | "coblop" | "coswap";
  name: string;
  title: string;
  description: string;
  status: string;
  method: string;
  version: string;
  assumptions: string[];
  metrics: Array<{ label: string; value: string; tone?: "default" | "good" | "warn" | "bad" }>;
  records: Record<string, unknown>[];
};

export type DashboardSummary = {
  generatedAt: string;
  asOf: string | null;
  source: {
    kind: "synthetic-sqlite";
    label: string;
  };
  stale: boolean;
  error: string | null;
  freshness: {
    checkedAt: string;
    reason: string | null;
    datasets: Array<{
      id: "cargoes" | "price_indices" | "freight_quotes" | "inventory" | "contracts";
      label: string;
      asOf: string | null;
      ageDays: number | null;
      maxAgeDays: number;
      status: "fresh" | "stale" | "missing";
    }>;
  };
  kpis: {
    cargoVolumeMt: number;
    cargoCount: number;
    avgLandedCostUsdT: number;
    avgFreightUsdT: number;
    delayedCargoes: number;
    inventoryMt: number;
    activeContracts: number;
    blendPlans: number;
    suppliers: number;
    qualityPenaltyUsd: number;
    lowRiskSuppliers: number;
    inventoryCoverDays: number;
  };
  indexTrend: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  inventory: Record<string, unknown>[];
  blends: Record<string, unknown>[];
  watchlist: Record<string, unknown>[];
};

type Db = Database.Database;

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_DATASETS = [
  { id: "cargoes", label: "船货 ETA", expression: "MAX(eta)", table: "cargoes", maxAgeDays: 45 },
  { id: "price_indices", label: "价格指数", expression: "MAX(index_date)", table: "price_indices", maxAgeDays: 60 },
  { id: "freight_quotes", label: "航线运价", expression: "MAX(quote_month || '-01')", table: "freight_quotes", maxAgeDays: 60 },
  { id: "inventory", label: "库存到货", expression: "MAX(arrival_month || '-01')", table: "inventory", maxAgeDays: 120 },
  { id: "contracts", label: "合同交付", expression: "MAX(delivery_month || '-01')", table: "contracts", maxAgeDays: 60 },
] as const;

function dashboardFreshness(db: Db, now: Date) {
  const checkedAt = now.toISOString();
  const rows = db.prepare(DASHBOARD_DATASETS.map((dataset) => (
    `SELECT '${dataset.id}' AS id, ${dataset.expression} AS as_of FROM ${dataset.table}`
  )).join(" UNION ALL ")).all() as Array<{ id: typeof DASHBOARD_DATASETS[number]["id"]; as_of: string | null }>;
  const byId = new Map(rows.map((row) => [row.id, row.as_of]));
  const datasets = DASHBOARD_DATASETS.map((dataset) => {
    const asOf = byId.get(dataset.id) ?? null;
    const timestamp = asOf ? Date.parse(`${asOf.length === 7 ? `${asOf}-01` : asOf}T00:00:00Z`) : Number.NaN;
    const ageDays = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / DAY_MS)) : null;
    return {
      id: dataset.id,
      label: dataset.label,
      asOf,
      ageDays,
      maxAgeDays: dataset.maxAgeDays,
      status: (ageDays === null ? "missing" : ageDays > dataset.maxAgeDays ? "stale" : "fresh") as "fresh" | "stale" | "missing",
    };
  });
  const unhealthy = datasets.filter((dataset) => dataset.status !== "fresh");
  const reason = unhealthy.length
    ? unhealthy.map((dataset) => dataset.status === "missing"
      ? `${dataset.label}无数据`
      : `${dataset.label}已滞后 ${dataset.ageDays} 天（阈值 ${dataset.maxAgeDays} 天）`).join("；")
    : null;
  const asOf = datasets.every((dataset) => dataset.asOf)
    ? datasets.map((dataset) => dataset.asOf!).sort()[0]
    : null;
  return { checkedAt, reason, datasets, asOf, stale: unhealthy.length > 0 };
}

function formatMoney(value: number, digits = 2) {
  return `$${value.toFixed(digits)}`;
}

function formatMt(value: number) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M t`;
  if (value >= 1000) return `${Math.round(value / 1000)}k t`;
  return `${Math.round(value)} t`;
}

function toneForRisk(value: number): "good" | "warn" | "bad" {
  if (value >= 70) return "bad";
  if (value >= 40) return "warn";
  return "good";
}

export function covistaSummary(db: Db = getDb()): ModuleSummary {
  const records = db.prepare(`
    SELECT
      c.vessel_name,
      cs.coal_type,
      c.quantity_mt,
      c.eta,
      c.status,
      c.demurrage_days,
      ROUND(c.price_usd_t + c.freight_usd_t, 2) AS landed_cost_usd_t,
      CASE
        WHEN c.status = 'delayed' THEN 80 + c.demurrage_days * 4
        WHEN c.status = 'open' THEN 45
        WHEN c.status = 'fixed' THEN 35
        ELSE 20
      END AS risk_score
    FROM cargoes c
    JOIN coal_specs cs ON cs.id = c.coal_spec_id
    ORDER BY risk_score DESC, c.eta
    LIMIT 8
  `).all() as Record<string, unknown>[];
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS cargoes,
      SUM(quantity_mt) AS volume_mt,
      SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) AS delayed_cargoes,
      ROUND(AVG(price_usd_t + freight_usd_t), 2) AS avg_landed_cost
    FROM cargoes
  `).get() as { cargoes: number; volume_mt: number; delayed_cargoes: number; avg_landed_cost: number };

  return {
    id: "covista",
    name: "COVISTA",
    title: "船货状态与风险分析",
    description: "面向煤炭船货的状态、ETA、滞期和到岸成本关注清单。",
    status: "公开演示模块",
    method: "status-risk-heuristic",
    version: "1.0.0-demo",
    assumptions: ["风险分由船货状态和滞期天数确定", "到岸成本仅为煤价与海运费之和"],
    metrics: [
      { label: "船货数", value: String(totals.cargoes) },
      { label: "总货量", value: formatMt(totals.volume_mt) },
      { label: "延误船货", value: String(totals.delayed_cargoes), tone: totals.delayed_cargoes ? "warn" : "good" },
      { label: "平均到岸", value: `${formatMoney(totals.avg_landed_cost)}/t` },
    ],
    records,
  };
}

export function cofareSummary(db: Db = getDb()): ModuleSummary {
  const records = db.prepare(`
    SELECT
      r.route_name,
      fq.vessel_class,
      ROUND(AVG(fq.rate_usd_t), 2) AS avg_rate_usd_t,
      ROUND(AVG(fq.bunker_usd_t), 0) AS avg_bunker_usd_t,
      ROUND(AVG(fq.congestion_days), 2) AS avg_congestion_days,
      ROUND(AVG(fq.rate_usd_t + fq.congestion_days * 0.35), 2) AS risk_adjusted_rate
    FROM freight_quotes fq
    JOIN freight_routes r ON r.id = fq.route_id
    GROUP BY r.route_name, fq.vessel_class
    ORDER BY risk_adjusted_rate DESC
  `).all() as Record<string, unknown>[];
  const spread = db.prepare(`
    SELECT
      ROUND(MAX(rate_usd_t) - MIN(rate_usd_t), 2) AS rate_spread,
      ROUND(AVG(congestion_days), 2) AS avg_congestion
    FROM freight_quotes
  `).get() as { rate_spread: number; avg_congestion: number };

  return {
    id: "cofare",
    name: "COFARE",
    title: "航线运价与拥堵分析",
    description: "对比航线运价、船型、燃油和拥堵调整后的运费水平。",
    status: "公开演示模块",
    method: "historical-route-descriptive",
    version: "1.0.0-demo",
    assumptions: ["仅描述合成历史报价", "拥堵调整使用固定演示系数，不构成运价预测"],
    metrics: [
      { label: "航线数", value: String(records.length) },
      { label: "运价价差", value: `${formatMoney(spread.rate_spread)}/t`, tone: "warn" },
      { label: "平均拥堵", value: `${spread.avg_congestion.toFixed(1)} 天` },
      { label: "低价航线", value: String(records.at(-1)?.route_name ?? "n/a"), tone: "good" },
    ],
    records,
  };
}

export function coriceSummary(db: Db = getDb()): ModuleSummary {
  const records = db.prepare(`
    SELECT
      ct.contract_no,
      s.name AS supplier,
      cs.coal_type,
      ct.delivery_month,
      ct.volume_mt,
      ct.fixed_price_usd_t,
      pi.value_usd_t AS index_value_usd_t,
      ROUND(ct.fixed_price_usd_t - pi.value_usd_t, 2) AS fixed_vs_index_usd_t,
      ct.status
    FROM contracts ct
    JOIN suppliers s ON s.id = ct.supplier_id
    JOIN coal_specs cs ON cs.id = ct.coal_spec_id
    LEFT JOIN price_indices pi
      ON pi.index_date = ct.delivery_month || '-01'
     AND (
      (cs.origin = 'Indonesia' AND pi.index_name = 'ICI4 Indonesian 4200') OR
      (cs.origin = 'Australia' AND pi.index_name = 'API5 Newcastle 5500') OR
      (cs.origin = 'South Africa' AND pi.index_name = 'M42 South China 5500')
     )
    WHERE ct.status IN ('active', 'planned')
    ORDER BY ct.delivery_month
    LIMIT 10
  `).all() as Record<string, unknown>[];
  const totals = db.prepare(`
    SELECT
      SUM(volume_mt) AS open_volume_mt,
      ROUND(AVG(fixed_price_usd_t), 2) AS avg_fixed_price
    FROM contracts
    WHERE status IN ('active', 'planned')
  `).get() as { open_volume_mt: number; avg_fixed_price: number };

  return {
    id: "corice",
    name: "CORICE",
    title: "合同指数与滚动成本",
    description: "观察固定合同价格相对指数口径的采购成本差异。",
    status: "公开演示模块",
    method: "contract-index-spread-snapshot",
    version: "1.0.0-demo",
    assumptions: ["按煤源映射单一合成指数", "本摘要不是多期库存优化结果"],
    metrics: [
      { label: "未结货量", value: formatMt(totals.open_volume_mt) },
      { label: "平均合同价", value: `${formatMoney(totals.avg_fixed_price)}/t` },
      { label: "合同数", value: String(records.length) },
      { label: "指数口径", value: "合成样例", tone: "good" },
    ],
    records,
  };
}

export function coblopSummary(db: Db = getDb()): ModuleSummary {
  const records = db.prepare(`
    SELECT
      bp.plan_name,
      a.coal_type AS coal_a,
      b.coal_type AS coal_b,
      bp.ratio_a,
      bp.ratio_b,
      bp.target_nar,
      bp.blended_cost_usd_t,
      bp.sulfur_pct,
      bp.ash_pct,
      CASE
        WHEN bp.sulfur_pct <= 0.5 AND bp.ash_pct <= 10.0 THEN 'quality_ok'
        ELSE 'quality_watch'
      END AS quality_status
    FROM blend_plans bp
    JOIN coal_specs a ON a.id = bp.coal_a_id
    JOIN coal_specs b ON b.id = bp.coal_b_id
    ORDER BY bp.blended_cost_usd_t
  `).all() as Record<string, unknown>[];
  const eligibleRecords = records.filter((row) => row.quality_status === "quality_ok");
  const best = eligibleRecords[0] as { plan_name?: string; blended_cost_usd_t?: number } | undefined;
  const qualityOk = eligibleRecords.length;

  return {
    id: "coblop",
    name: "COBLOP",
    title: "配煤方案成本筛选",
    description: "在热值、硫分、灰分约束下筛选低成本配煤方案。",
    status: "公开演示模块",
    method: "precomputed-plan-filter",
    version: "1.0.0-demo",
    assumptions: ["仅筛选数据库中的预计算方案", "质量阈值为硫分 0.5% 与灰分 10%"],
    metrics: [
      { label: "配煤方案", value: String(records.length) },
      { label: "质量达标", value: String(qualityOk), tone: qualityOk ? "good" : "warn" },
      { label: "最低成本", value: `${formatMoney(Number(best?.blended_cost_usd_t ?? 0))}/t`, tone: "good" },
      { label: "优选方案", value: String(best?.plan_name ?? "n/a") },
    ],
    records,
  };
}

export function coswapSummary(db: Db = getDb()): ModuleSummary {
  const records = db.prepare(`
    WITH delayed AS (
      SELECT
        c.id,
        c.vessel_name,
        cs.coal_type,
        cs.nar_kcal,
        cs.sulfur_pct,
        cs.ash_pct,
        c.quantity_mt,
        c.eta,
        c.price_usd_t + c.freight_usd_t AS landed_cost_usd_t
      FROM cargoes c
      JOIN coal_specs cs ON cs.id = c.coal_spec_id
      WHERE c.status = 'delayed'
    ),
    candidates AS (
      SELECT
        c.id,
        c.vessel_name,
        cs.coal_type,
        cs.nar_kcal,
        cs.sulfur_pct,
        cs.ash_pct,
        c.quantity_mt,
        c.eta,
        c.price_usd_t + c.freight_usd_t AS landed_cost_usd_t
      FROM cargoes c
      JOIN coal_specs cs ON cs.id = c.coal_spec_id
      WHERE c.status IN ('open', 'fixed')
    )
    SELECT
      d.vessel_name AS delayed_vessel,
      c.vessel_name AS candidate_vessel,
      d.coal_type AS delayed_coal,
      c.coal_type AS candidate_coal,
      ROUND(c.landed_cost_usd_t - d.landed_cost_usd_t, 2) AS cost_delta_usd_t,
      ABS(c.nar_kcal - d.nar_kcal) AS nar_delta,
      ROUND(ABS(c.sulfur_pct - d.sulfur_pct), 3) AS sulfur_delta,
      ROUND(ABS(c.ash_pct - d.ash_pct), 2) AS ash_delta,
      ROUND(
        ABS(c.nar_kcal - d.nar_kcal) / 100.0 +
        ABS(c.sulfur_pct - d.sulfur_pct) * 30 +
        ABS(c.ash_pct - d.ash_pct) * 2 +
        MAX(c.landed_cost_usd_t - d.landed_cost_usd_t, 0) * 0.8,
        1
      ) AS swap_risk_score
    FROM delayed d
    CROSS JOIN candidates c
    WHERE d.id <> c.id
    ORDER BY swap_risk_score ASC
    LIMIT 10
  `).all() as Record<string, unknown>[];
  const bestRisk = Number(records[0]?.swap_risk_score ?? 0);

  return {
    id: "coswap",
    name: "COSWAP",
    title: "延误船货替代评估",
    description: "当延误船货影响交付节奏时，对候选替代船货进行风险评分。",
    status: "公开演示模块",
    method: "candidate-risk-heuristic",
    version: "1.0.0-demo",
    assumptions: ["当前摘要按质量差与正向成本差评分", "完整资格过滤由业务算法 API 提供"],
    metrics: [
      { label: "替代候选", value: String(records.length) },
      { label: "最低风险", value: bestRisk.toFixed(1), tone: toneForRisk(bestRisk) },
      { label: "质量字段", value: "NAR/S/Ash" },
      { label: "数据模式", value: "合成样例", tone: "good" },
    ],
    records,
  };
}

export function getAllModuleSummaries(db: Db = getDb()) {
  return [
    covistaSummary(db),
    cofareSummary(db),
    coriceSummary(db),
    coblopSummary(db),
    coswapSummary(db),
  ];
}

export function dashboardSummary(db: Db = getDb(), options: { now?: Date } = {}): DashboardSummary {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const freshness = dashboardFreshness(db, now);
  const cargo = db.prepare(`
    SELECT
      COUNT(*) AS cargo_count,
      COALESCE(SUM(quantity_mt), 0) AS cargo_volume_mt,
      COALESCE(AVG(price_usd_t + freight_usd_t), 0) AS avg_landed_cost,
      COALESCE(AVG(freight_usd_t), 0) AS avg_freight,
      COALESCE(SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END), 0) AS delayed_cargoes,
      COALESCE(SUM(quality_penalty_usd), 0) AS quality_penalty_usd
    FROM cargoes
  `).get() as Record<string, number>;
  const counts = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(stock_mt), 0) FROM inventory) AS inventory_mt,
      (SELECT COUNT(*) FROM contracts WHERE status IN ('active', 'planned')) AS active_contracts,
      (SELECT COUNT(*) FROM blend_plans) AS blend_plans,
      (SELECT COUNT(*) FROM suppliers) AS suppliers,
      (SELECT COUNT(*) FROM suppliers WHERE risk_rating = 'low') AS low_risk_suppliers
  `).get() as Record<string, number>;

  return {
    generatedAt,
    asOf: freshness.asOf,
    source: {
      kind: "synthetic-sqlite",
      label: "本地合成煤炭演示库",
    },
    stale: freshness.stale,
    error: null,
    freshness: {
      checkedAt: freshness.checkedAt,
      reason: freshness.reason,
      datasets: freshness.datasets,
    },
    kpis: {
      cargoVolumeMt: cargo.cargo_volume_mt,
      cargoCount: cargo.cargo_count,
      avgLandedCostUsdT: Number(cargo.avg_landed_cost.toFixed(2)),
      avgFreightUsdT: Number(cargo.avg_freight.toFixed(2)),
      delayedCargoes: cargo.delayed_cargoes,
      inventoryMt: counts.inventory_mt,
      activeContracts: counts.active_contracts,
      blendPlans: counts.blend_plans,
      suppliers: counts.suppliers,
      qualityPenaltyUsd: cargo.quality_penalty_usd,
      lowRiskSuppliers: counts.low_risk_suppliers,
      inventoryCoverDays: Number((counts.inventory_mt / 16000).toFixed(1)),
    },
    indexTrend: db.prepare(`
      SELECT strftime('%Y-%m', index_date) AS month, ROUND(AVG(value_usd_t), 2) AS index_value
      FROM price_indices
      WHERE index_name = 'ICI4 Indonesian 4200'
      GROUP BY month
      ORDER BY month
    `).all() as Record<string, unknown>[],
    routes: db.prepare(`
      SELECT r.load_region AS route, ROUND(AVG(fq.rate_usd_t), 2) AS rate
      FROM freight_quotes fq
      JOIN freight_routes r ON r.id = fq.route_id
      GROUP BY r.load_region
      ORDER BY rate
    `).all() as Record<string, unknown>[],
    statuses: db.prepare(`
      SELECT status, COUNT(*) AS cargoes
      FROM cargoes
      GROUP BY status
      ORDER BY status
    `).all() as Record<string, unknown>[],
    inventory: db.prepare(`
      SELECT cs.coal_type, SUM(i.stock_mt) AS stock_mt
      FROM inventory i
      JOIN coal_specs cs ON cs.id = i.coal_spec_id
      GROUP BY cs.coal_type
      ORDER BY stock_mt DESC
    `).all() as Record<string, unknown>[],
    blends: db.prepare(`
      SELECT plan_name AS plan, blended_cost_usd_t AS cost, target_nar AS nar,
        CASE WHEN sulfur_pct <= 0.5 AND ash_pct <= 10 THEN 'quality_ok' ELSE 'quality_watch' END AS quality_status
      FROM blend_plans
      ORDER BY blended_cost_usd_t
    `).all() as Record<string, unknown>[],
    watchlist: db.prepare(`
      SELECT vessel_name AS vessel, quantity_mt AS cargo_mt, demurrage_days,
        CASE
          WHEN status = 'delayed' THEN 80 + demurrage_days * 4
          WHEN status = 'open' THEN 45
          WHEN status = 'fixed' THEN 35
          ELSE 20
        END AS risk_score,
        status
      FROM cargoes
      WHERE status IN ('delayed', 'open', 'fixed')
      ORDER BY risk_score DESC, eta
      LIMIT 8
    `).all() as Record<string, unknown>[],
  };
}
