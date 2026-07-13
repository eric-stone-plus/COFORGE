"use client";

import { useState } from "react";

type ToolId = "bidding" | "sourcing" | "freight" | "laytime" | "blending" | "coswap" | "inventory";

type ToolDefinition = {
  label: string;
  endpoint: string;
  description: string;
  sample: Record<string, unknown>;
};

const TOOLS: Record<ToolId, ToolDefinition> = {
  bidding: {
    label: "投标到厂成本",
    endpoint: "/api/business/bidding",
    description: "Incoterm、运保费、资金占用与单位热值成本。",
    sample: {
      operation: "calculate",
      input: {
        incoterm: "FOB", priceUsdPerMt: 60, quantityMt: 50000, narKcalPerKg: 5000,
        freight: { rateUsdPerMt: 10 }, exchangeRateCnyPerUsd: 7.2, vatRate: 0.13,
        domesticCosts: { roadFreightCnyPerMt: 20 },
        finance: { annualRate: 0.0435, financingDays: 37, lcFeeRate: 0.001, vatRecoveryDays: 37 },
      },
    },
  },
  sourcing: {
    label: "内外贸成本",
    endpoint: "/api/business/sourcing",
    description: "按单位热值对比国内煤与进口煤的全成本。",
    sample: {
      operation: "trade_economics",
      input: {
        domestic: { minePriceCnyPerMt: 680, coastalFreightCnyPerMt: 35, narKcalPerKg: 5500 },
        imported: { fobUsdPerMt: 72, oceanFreightUsdPerMt: 13, exchangeRateCnyPerUsd: 7.2, narKcalPerKg: 5000, annualFinanceRate: 0.0435, financingDays: 37, vatRecoveryDays: 37 },
        inversionAlertThresholdCnyPerMillionKcal: 5,
      },
    },
  },
  freight: {
    label: "航次成本 / TCE",
    endpoint: "/api/business/freight",
    description: "按航程、航速、油耗和 VLSFO 价格计算确定性成本。",
    sample: {
      operation: "voyage-cost",
      input: { cargoMt: 70000, seaDistanceNm: 2400, ladenSpeedKnots: 12, portDays: 5, ladenConsumptionMtPerDay: 28, portConsumptionMtPerDay: 4, vlsfoPriceUsdPerMt: 650 },
    },
  },
  laytime: {
    label: "Laytime 核算",
    endpoint: "/api/business/laytime",
    description: "基于 SOF 时间线计算 Strict/Concession 口径。",
    sample: {
      operation: "calculate",
      input: { laytimeStart: "2026-07-01T00:00:00Z", operationsComplete: "2026-07-04T12:00:00Z", allowedHours: 60, demurrageRateUsdPerDay: 18000, events: [] },
    },
  },
  blending: {
    label: "配煤优化",
    endpoint: "/api/business/blending",
    description: "在库存和质量硬约束下求最低成本配比。",
    sample: {
      operation: "optimize",
      input: {
        sources: [
          { id: "A", availableMt: 60000, costUsdPerMt: 55, narKcalPerKg: 4200, sulfurPct: 0.3, ashPct: 7, totalMoisturePct: 30 },
          { id: "B", availableMt: 60000, costUsdPerMt: 88, narKcalPerKg: 5600, sulfurPct: 0.55, ashPct: 12, totalMoisturePct: 12 },
        ],
        requirements: { targetMt: 50000, stepMt: 5000, minNarKcalPerKg: 4700, maxSulfurPct: 0.5, maxAshPct: 10, maxTotalMoisturePct: 25 },
      },
    },
  },
  coswap: {
    label: "换船资格排名",
    endpoint: "/api/business/coswap",
    description: "按交付窗口、港口和数量先过滤，再逐延误船排名。",
    sample: {
      operation: "rank-swaps",
      input: {
        delayedShipments: [{ id: "D-1", deliveryWindowStart: "2026-07-01T00:00:00Z", deliveryWindowEnd: "2026-07-10T00:00:00Z", allowedPorts: ["Guangzhou"], requiredQuantityMt: 50000 }],
        candidates: [
          { id: "C-1", deliveryTime: "2026-07-08T00:00:00Z", port: "Guangzhou", quantityMt: 55000, costUsdPerMt: 75 },
          { id: "C-2", deliveryTime: "2026-07-12T00:00:00Z", port: "Guangzhou", quantityMt: 60000, costUsdPerMt: 70 },
        ],
      },
    },
  },
  inventory: {
    label: "滚动库存成本",
    endpoint: "/api/business/inventory",
    description: "多期库存守恒、采购、持有与缺货成本优化。",
    sample: {
      operation: "rolling-plan",
      input: {
        initialInventoryMt: 20000, stepMt: 5000, defaultStorageCapacityMt: 80000,
        periods: [
          { id: "M1", demandMt: 30000, purchaseCostUsdPerMt: 70, maxPurchaseMt: 50000, holdingCostUsdPerMt: 0.5 },
          { id: "M2", demandMt: 45000, purchaseCostUsdPerMt: 73, maxPurchaseMt: 60000, holdingCostUsdPerMt: 0.5 },
        ],
        terminalMinInventoryMt: 10000,
      },
    },
  },
};

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export default function BusinessCalculator() {
  const [tool, setTool] = useState<ToolId>("bidding");
  const [input, setInput] = useState(() => pretty(TOOLS.bidding.sample));
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const definition = TOOLS[tool];

  function chooseTool(next: ToolId) {
    setTool(next);
    setInput(pretty(TOOLS[next].sample));
    setResult("");
    setError(null);
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const payload = JSON.parse(input);
      const response = await fetch(definition.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
      setResult(pretty(data.data));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "计算失败");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold" style={{ color: "var(--text)" }}>业务计算实验台</h3>
          <p className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>{definition.description}</p>
        </div>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px]" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>合成输入</span>
      </div>

      <div className="no-scrollbar mb-2 flex gap-1 overflow-x-auto">
        {(Object.keys(TOOLS) as ToolId[]).map((id) => (
          <button key={id} type="button" onClick={() => chooseTool(id)} className="shrink-0 rounded-md px-2 py-1 text-[10px]" style={{ background: tool === id ? "var(--accent)" : "var(--surface-hover)", color: tool === id ? "#fff" : "var(--text-secondary)" }}>
            {TOOLS[id].label}
          </button>
        ))}
      </div>

      <textarea
        aria-label="业务计算 JSON 输入"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        spellCheck={false}
        className="h-44 w-full resize-y rounded-lg border p-2 font-mono text-[10px] outline-none"
        style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--text-secondary)" }}
      />
      <button type="button" onClick={run} disabled={running} className="mt-2 h-8 w-full rounded-lg text-xs font-medium text-white disabled:opacity-60" style={{ background: "var(--accent)" }}>
        {running ? "计算中…" : `运行${definition.label}`}
      </button>

      {error && <p className="mt-2 rounded-lg px-2 py-1.5 text-[10px]" style={{ background: "var(--error-soft)", color: "var(--error)" }}>{error}</p>}
      {result && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border p-2 text-[10px]" style={{ borderColor: "var(--border)", background: "var(--bg)", color: "var(--text-secondary)" }}>{result}</pre>}
    </div>
  );
}
