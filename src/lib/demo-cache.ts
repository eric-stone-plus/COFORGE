import type { QueryRow } from "./query-types";

export type DemoCacheEntry = {
  thinking: string;
  intent: string;
  sql: string;
  chartConfig: { type: string; x_key: string; y_key: string; title: string };
  renderExplanation: (rows: QueryRow[]) => string;
};

const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INVENTORY_DAILY_CONSUMPTION_MT = 16_000;
const BLEND_MAX_SULFUR_PCT = 0.5;
const BLEND_MAX_ASH_PCT = 10;

function numeric(row: QueryRow | undefined, key: string) {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function text(row: QueryRow | undefined, key: string, fallback = "未命名") {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function noRows(subject: string) {
  return `数据结论：本次查询没有返回${subject}，因此不沿用旧排名或静态数字。经营动作上，请先确认当前数据库、筛选条件和数据日期，再决定是否扩大范围。局限是公开环境只含合成 demo 数据，不能替代真实合同、船期和化验口径。`;
}

function incomplete(subject: string) {
  return `数据结论：本次返回了${subject}，但缺少生成可靠结论所需的字段，因此不沿用旧排名或静态数字。经营动作上，请先检查数据完整性和查询口径，再据此决策。局限是公开环境只含合成 demo 数据，不能替代真实合同、船期和化验口径。`;
}

function renderCargoRisk(rows: QueryRow[]) {
  if (!rows.length) return noRows("符合条件的在途船货");
  const first = rows[0];
  const matching = numeric(first, "matching_cargoes");
  const demurrageDays = numeric(first, "demurrage_days");
  const quantityMt = numeric(first, "quantity_mt");
  if (matching === undefined || demurrageDays === undefined || quantityMt === undefined) {
    return incomplete("在途船货记录");
  }
  return `数据结论：本次识别到 ${integer.format(matching)} 条 delayed/open/fixed 船货，并返回风险排序前 ${integer.format(rows.length)} 条；${text(first, "vessel_name")} 以 ${decimal.format(demurrageDays)} 天滞期排在首位，货量 ${integer.format(quantityMt)} 吨，ETA 为 ${text(first, "eta", "未知")}。经营动作上，应先核对卸港排队、滞期责任和补库影响，再用 open/fixed 船衔接采购窗口。局限是公开样例没有实时港口排队、合同条款和质检结果。`;
}

function renderLandedCost(rows: QueryRow[]) {
  if (!rows.length) return noRows("煤种到岸成本记录");
  const indonesia = rows.find((row) => text(row, "coal_type", "").includes("Indonesian"));
  const australia = rows.find((row) => text(row, "coal_type", "").includes("Australian"));
  if (!indonesia || !australia) {
    const listed = rows
      .map((row) => {
        const cost = numeric(row, "avg_landed_cost");
        return cost === undefined ? text(row, "coal_type") : `${text(row, "coal_type")} $${money.format(cost)}/吨`;
      })
      .join("、");
    return `数据结论：本次只返回了 ${listed}，不足以形成印尼 4200 与澳煤 5500 的完整双边对比。经营动作上，应补齐两个煤种同口径的煤价、运费和热值数据后再排序。局限是公开样例没有锅炉效率、化验偏差和质量罚则。`;
  }
  const indonesiaCost = numeric(indonesia, "avg_landed_cost");
  const australiaCost = numeric(australia, "avg_landed_cost");
  if (indonesiaCost === undefined || australiaCost === undefined) return incomplete("煤种到岸成本记录");
  const gap = Math.abs(australiaCost - indonesiaCost);
  let comparison = "两者到岸成本持平";
  if (gap >= 0.005) {
    const indonesiaCheaper = indonesiaCost < australiaCost;
    const lowerLabel = indonesiaCheaper ? "印尼 4200" : "澳煤 5500";
    const higherLabel = indonesiaCheaper ? "澳煤 5500" : "印尼 4200";
    const lowerCost = Math.min(indonesiaCost, australiaCost);
    const gapPct = lowerCost > 0 ? `（${decimal.format((gap / lowerCost) * 100)}%）` : "";
    comparison = `${lowerLabel}比${higherLabel}低 $${money.format(gap)}/吨${gapPct}`;
  }
  return `数据结论：印尼 4200 平均到岸成本为 $${money.format(indonesiaCost)}/吨，澳煤 5500 为 $${money.format(australiaCost)}/吨，${comparison}。经营动作上，不能只按美元/吨判断，应折算到有效热值并结合硫灰约束，检验高卡煤的热值收益能否覆盖价差。局限是公开样例没有锅炉效率、实际化验偏差和质量罚则。`;
}

function renderInventory(rows: QueryRow[]) {
  if (!rows.length) return noRows("库存记录");
  const completeRows = rows.filter((row) => numeric(row, "stock_mt") !== undefined);
  const totalStock = numeric(rows[0], "total_stock_mt");
  if (totalStock === undefined || !completeRows.length) return incomplete("库存记录");
  const totalCoverDays = totalStock / INVENTORY_DAILY_CONSUMPTION_MT;
  const largest = completeRows.reduce((best, row) => numeric(row, "stock_mt")! > numeric(best, "stock_mt")! ? row : best);
  const smallest = completeRows.reduce((best, row) => numeric(row, "stock_mt")! < numeric(best, "stock_mt")! ? row : best);
  return `数据结论：按 ${integer.format(INVENTORY_DAILY_CONSUMPTION_MT)} 吨/日的演示日耗，本次查询的总库存 ${integer.format(totalStock)} 吨可覆盖约 ${decimal.format(totalCoverDays)} 天。${text(largest, "coal_type")} 库存最高，为 ${integer.format(numeric(largest, "stock_mt")!)} 吨；${text(smallest, "coal_type")} 最薄，为 ${integer.format(numeric(smallest, "stock_mt")!)} 吨。经营动作上，应按煤种和质量约束拆分覆盖天数，并用在途船 ETA 校验补库缺口。局限是日耗为演示假设，真实模型还需接入机组负荷和生产计划。`;
}

function renderBlendPlans(rows: QueryRow[]) {
  if (!rows.length) return noRows("满足硫灰约束的配煤方案");
  const completeRows = rows.filter((row) => numeric(row, "blended_cost_usd_t") !== undefined);
  const matchingPlans = numeric(rows[0], "matching_plans");
  if (!completeRows.length || matchingPlans === undefined) return incomplete("配煤方案记录");
  const cheapest = completeRows.reduce((best, row) => (
    numeric(row, "blended_cost_usd_t")! < numeric(best, "blended_cost_usd_t")! ? row : best
  ));
  const cost = numeric(cheapest, "blended_cost_usd_t");
  const targetNar = numeric(cheapest, "target_nar");
  const sulfurPct = numeric(cheapest, "sulfur_pct");
  const ashPct = numeric(cheapest, "ash_pct");
  if (cost === undefined || targetNar === undefined || sulfurPct === undefined || ashPct === undefined) {
    return incomplete("配煤方案记录");
  }
  return `数据结论：本次有 ${integer.format(matchingPlans)} 个方案满足硫分不高于 ${BLEND_MAX_SULFUR_PCT}%、灰分不高于 ${BLEND_MAX_ASH_PCT}% 的条件；最低成本是「${text(cheapest, "plan_name")}」，成本 $${money.format(cost)}/吨，目标热值 ${integer.format(targetNar)} kcal，硫分 ${money.format(sulfurPct)}%，灰分 ${money.format(ashPct)}%。经营动作上，可将它作为达标基准，再比较其他方案的边际热值收益。局限是样例未纳入实时库存、设备适配、化验误差和最低提货量。`;
}

function renderFreight(rows: QueryRow[]) {
  if (!rows.length) return noRows("航线运价记录");
  const completeRows = rows.filter((row) => numeric(row, "avg_rate_usd_t") !== undefined);
  if (!completeRows.length) return incomplete("航线运价记录");
  const highest = completeRows.reduce((best, row) => numeric(row, "avg_rate_usd_t")! > numeric(best, "avg_rate_usd_t")! ? row : best);
  const lowest = completeRows.reduce((best, row) => numeric(row, "avg_rate_usd_t")! < numeric(best, "avg_rate_usd_t")! ? row : best);
  const highestRate = numeric(highest, "avg_rate_usd_t")!;
  const lowestRate = numeric(lowest, "avg_rate_usd_t")!;
  const highestCongestion = numeric(highest, "avg_congestion_days");
  if (highestCongestion === undefined) return incomplete("航线运价记录");
  const gap = highestRate - lowestRate;
  const comparison = gap < 0.005
    ? `本次 ${integer.format(completeRows.length)} 条航线记录的平均运价持平，均为 $${money.format(highestRate)}/吨`
    : `${text(highest, "route_name")} 平均运价最高，为 $${money.format(highestRate)}/吨，平均拥堵 ${decimal.format(highestCongestion)} 天；${text(lowest, "route_name")} 最低，为 $${money.format(lowestRate)}/吨，两者相差 $${money.format(gap)}/吨`;
  return `数据结论：${comparison}。经营动作上，应把运价、拥堵和煤价合并为到岸成本，远程高卡煤还需验证热值收益。局限是运价为合成月度报价，未接入实时船期、FFA 和燃油附加。`;
}

export const CACHED_RESULTS: Record<string, DemoCacheEntry> = {
  "哪些在途船最需要关注？": {
    thinking: "船货风险优先看状态、ETA、滞期天数、到岸成本和货量。delayed 船应排在最前面，open/fixed 船用于后续排产和补库判断。",
    intent: "识别最需要运营关注的在途船货和风险排序",
    sql: `SELECT c.vessel_name, cs.coal_type, c.quantity_mt, c.eta, c.status, c.demurrage_days, ROUND(c.price_usd_t + c.freight_usd_t, 2) AS landed_cost_usd_t, (SELECT COUNT(c2.id) FROM cargoes c2 WHERE c2.status IN ('delayed', 'open', 'fixed')) AS matching_cargoes FROM cargoes c JOIN coal_specs cs ON cs.id = c.coal_spec_id WHERE c.status IN ('delayed', 'open', 'fixed') ORDER BY c.demurrage_days DESC, c.eta LIMIT 10`,
    chartConfig: { type: "bar", x_key: "vessel_name", y_key: "landed_cost_usd_t", title: "在途船风险清单" },
    renderExplanation: renderCargoRisk,
  },
  "印尼 4200 和澳煤 5500 的到岸成本怎么比？": {
    thinking: "到岸成本按煤价加海运费比较。印尼 4200 通常热值低但航距短，澳煤 5500 热值高但运价和基础煤价更高，需要同时看美元/吨和热值价值。",
    intent: "比较印尼 4200 与澳煤 5500 的平均到岸成本差异",
    sql: `SELECT cs.coal_type, cs.origin, cs.nar_kcal, COUNT(*) AS cargoes, ROUND(AVG(c.price_usd_t), 2) AS avg_price_usd_t, ROUND(AVG(c.freight_usd_t), 2) AS avg_freight_usd_t, ROUND(AVG(c.price_usd_t + c.freight_usd_t), 2) AS avg_landed_cost FROM cargoes c JOIN coal_specs cs ON cs.id = c.coal_spec_id WHERE cs.coal_type IN ('Indonesian NAR4200', 'Australian NAR5500') GROUP BY cs.coal_type, cs.origin, cs.nar_kcal ORDER BY avg_landed_cost`,
    chartConfig: { type: "bar", x_key: "coal_type", y_key: "avg_landed_cost", title: "印尼 4200 vs 澳煤 5500 到岸成本" },
    renderExplanation: renderLandedCost,
  },
  "库存还能覆盖多少天？": {
    thinking: "库存覆盖天数等于总库存除以日耗。公开 demo 没有真实日耗表，按 16,000 吨/日做演示假设，同时展示分煤种库存结构。",
    intent: "估算当前煤炭库存覆盖天数并识别结构风险",
    sql: `SELECT cs.coal_type, i.yard, i.stock_mt, ROUND(i.avg_cost_usd_t, 2) AS avg_cost_usd_t, ROUND(i.stock_mt / ${INVENTORY_DAILY_CONSUMPTION_MT}.0, 1) AS cover_days_at_16k_tpd, (SELECT SUM(i2.stock_mt) FROM inventory i2) AS total_stock_mt FROM inventory i JOIN coal_specs cs ON cs.id = i.coal_spec_id ORDER BY i.stock_mt DESC`,
    chartConfig: { type: "bar", x_key: "coal_type", y_key: "cover_days_at_16k_tpd", title: "库存覆盖天数（按 16k t/day）" },
    renderExplanation: renderInventory,
  },
  "哪个配煤方案成本最低且硫灰可控？": {
    thinking: "配煤方案需要同时比较成本、目标热值、硫分和灰分。最低成本不一定满足质量约束，所以先按 blended_cost 排序，再看 sulfur_pct 和 ash_pct。",
    intent: "筛选成本最低且质量指标可接受的配煤方案",
    sql: `SELECT bp.plan_name, bp.target_nar, bp.blended_cost_usd_t, bp.sulfur_pct, bp.ash_pct, (SELECT COUNT(bp2.id) FROM blend_plans bp2 WHERE bp2.sulfur_pct <= ${BLEND_MAX_SULFUR_PCT} AND bp2.ash_pct <= ${BLEND_MAX_ASH_PCT}) AS matching_plans FROM blend_plans bp WHERE bp.sulfur_pct <= ${BLEND_MAX_SULFUR_PCT} AND bp.ash_pct <= ${BLEND_MAX_ASH_PCT} ORDER BY bp.blended_cost_usd_t LIMIT 10`,
    chartConfig: { type: "bar", x_key: "plan_name", y_key: "blended_cost_usd_t", title: "低硫灰配煤方案成本" },
    renderExplanation: renderBlendPlans,
  },
  "航线运价对比": {
    thinking: "航线运价需要看平均 rate、拥堵天数和船型。Kalimantan/Sumatra 到华南通常短航程，Newcastle 和 Richards Bay 路线成本更高。",
    intent: "对比不同煤炭航线的平均运价和拥堵风险",
    sql: `SELECT r.route_name, fq.vessel_class, ROUND(AVG(fq.rate_usd_t), 2) AS avg_rate_usd_t, ROUND(AVG(fq.congestion_days), 2) AS avg_congestion_days FROM freight_quotes fq JOIN freight_routes r ON r.id = fq.route_id GROUP BY r.route_name, fq.vessel_class ORDER BY avg_rate_usd_t DESC`,
    chartConfig: { type: "bar", x_key: "route_name", y_key: "avg_rate_usd_t", title: "航线平均运价对比" },
    renderExplanation: renderFreight,
  },
};
