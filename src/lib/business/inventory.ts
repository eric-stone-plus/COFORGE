import {
  type EngineMetadata,
  arrayValue,
  assertAllowedKeys,
  numberValue,
  objectValue,
  optionalNumber,
  quantityToUnits,
  round,
  stringValue,
  uniqueIds,
  validationFail,
} from "./domain-utils";

export interface InventoryPeriodInput {
  id: string;
  demandMt: number;
  purchaseCostUsdPerMt: number;
  maxPurchaseMt: number;
  minPurchaseMt?: number;
  holdingCostUsdPerMt?: number;
  storageCapacityMt?: number;
}

export interface RollingInventoryInput {
  initialInventoryMt: number;
  initialInventoryCostUsdPerMt?: number;
  terminalMinInventoryMt?: number;
  stepMt: number;
  defaultStorageCapacityMt: number;
  shortagePenaltyUsdPerMt?: number;
  allowShortage?: boolean;
  periods: InventoryPeriodInput[];
}

const fail = validationFail("inventory");
// The DP stores full audit paths for each state, so keep synchronous request
// work well below the point where path copying becomes a memory/CPU amplifier.
export const MAX_DP_TRANSITIONS = 500_000;

const METADATA: EngineMetadata = {
  method: "finite-horizon discrete dynamic programming with exact period inventory conservation",
  version: "inventory-v1.0.0",
  assumptions: [
    "Purchases arrive before demand in each period and ending inventory carries into the next period.",
    "All quantities are exact multiples of stepMt and no inventory shrinkage occurs.",
    "Holding cost is charged on each period's ending inventory; shortage penalty is charged on unmet period demand.",
    "Weighted-average rolling inventory cost tracks purchase value only and is conserved with physical inventory.",
    "If opening inventory cost is omitted, the first-period purchase price is disclosed and used as its cost-basis proxy.",
    "The optimization objective is incremental purchase, holding, and shortage cost; opening inventory value is a sunk cost.",
  ],
};

const UNITS = {
  quantity: "metric tonne",
  unitCost: "USD/metric tonne",
  totalCost: "USD",
  balanceEquation: "beginning + purchase - fulfilled demand = ending inventory",
} as const;

interface Period {
  id: string;
  demandMt: number;
  demandUnits: number;
  purchaseCostUsdPerMt: number;
  maxPurchaseMt: number;
  maxPurchaseUnits: number;
  minPurchaseMt: number;
  minPurchaseUnits: number;
  holdingCostUsdPerMt: number;
  storageCapacityMt: number;
  storageCapacityUnits: number;
}

interface State {
  inventoryUnits: number;
  purchaseCostUsd: number;
  holdingCostUsd: number;
  shortageCostUsd: number;
  totalCostUsd: number;
  inventoryBookValueUsd: number;
  periods: Array<{
    id: string;
    beginningInventoryUnits: number;
    purchaseUnits: number;
    demandUnits: number;
    fulfilledDemandUnits: number;
    shortageUnits: number;
    endingInventoryUnits: number;
    purchaseCostUsd: number;
    holdingCostUsd: number;
    shortageCostUsd: number;
    consumedInventoryBookValueUsd: number;
    endingInventoryBookValueUsd: number;
    rollingAverageCostUsdPerMt: number | null;
  }>;
}

export interface InventoryPlanPeriod {
  periodId: string;
  beginningInventoryMt: number;
  purchaseMt: number;
  demandMt: number;
  fulfilledDemandMt: number;
  shortageMt: number;
  endingInventoryMt: number;
  balanceResidualMt: number;
  purchaseCostUsd: number;
  holdingCostUsd: number;
  shortageCostUsd: number;
  consumedInventoryBookValueUsd: number;
  endingInventoryBookValueUsd: number;
  rollingAverageCostUsdPerMt: number | null;
}

interface InventoryResultBase {
  metadata: EngineMetadata;
  units: typeof UNITS;
  transitionsEvaluated: number;
  plan: InventoryPlanPeriod[];
  infeasibilityReasons: string[];
  openingInventoryCostBasis: {
    costUsdPerMt: number;
    source: "provided" | "first-period-purchase-cost-proxy";
  };
}

export interface InfeasibleInventoryResult extends InventoryResultBase {
  status: "infeasible";
}

export interface OptimalInventoryResult extends InventoryResultBase {
  status: "optimal";
  initialInventoryMt: number;
  terminalMinInventoryMt: number;
  endingInventoryMt: number;
  costs: {
    purchaseCostUsd: number;
    holdingCostUsd: number;
    shortageCostUsd: number;
    totalCostUsd: number;
    endingInventoryBookValueUsd: number;
    endingRollingAverageCostUsdPerMt: number | null;
  };
}

export type RollingInventoryResult = InfeasibleInventoryResult | OptimalInventoryResult;

function normalizePeriod(value: unknown, index: number, stepMt: number, defaultCapacityMt: number): Period {
  const record = objectValue(value, `periods[${index}]`, fail);
  assertAllowedKeys(record, [
    "id", "demandMt", "purchaseCostUsdPerMt", "maxPurchaseMt", "minPurchaseMt",
    "holdingCostUsdPerMt", "storageCapacityMt",
  ], `periods[${index}]`, fail);
  const demandMt = numberValue(record, "demandMt", fail, { min: 0 });
  const maxPurchaseMt = numberValue(record, "maxPurchaseMt", fail, { min: 0 });
  const minPurchaseMt = numberValue(record, "minPurchaseMt", fail, { min: 0, defaultValue: 0 });
  if (minPurchaseMt > maxPurchaseMt) fail(`periods[${index}].minPurchaseMt must be <= maxPurchaseMt.`);
  const storageCapacityMt = numberValue(record, "storageCapacityMt", fail, {
    min: 0,
    defaultValue: defaultCapacityMt,
  });
  return {
    id: stringValue(record, "id", fail, { label: `periods[${index}].id`, maxLength: 100 }),
    demandMt,
    demandUnits: quantityToUnits(demandMt, stepMt, `periods[${index}].demandMt`, fail),
    purchaseCostUsdPerMt: numberValue(record, "purchaseCostUsdPerMt", fail, { min: 0 }),
    maxPurchaseMt,
    maxPurchaseUnits: quantityToUnits(maxPurchaseMt, stepMt, `periods[${index}].maxPurchaseMt`, fail),
    minPurchaseMt,
    minPurchaseUnits: quantityToUnits(minPurchaseMt, stepMt, `periods[${index}].minPurchaseMt`, fail),
    holdingCostUsdPerMt: numberValue(record, "holdingCostUsdPerMt", fail, { min: 0, defaultValue: 0 }),
    storageCapacityMt,
    storageCapacityUnits: quantityToUnits(storageCapacityMt, stepMt, `periods[${index}].storageCapacityMt`, fail),
  };
}

function normalizeInput(value: unknown) {
  const record = objectValue(value, "rollingInventory", fail);
  assertAllowedKeys(record, [
    "initialInventoryMt", "initialInventoryCostUsdPerMt", "terminalMinInventoryMt", "stepMt", "defaultStorageCapacityMt",
    "shortagePenaltyUsdPerMt", "allowShortage", "periods",
  ], "rollingInventory", fail);
  const stepMt = numberValue(record, "stepMt", fail, { min: 0, exclusiveMin: true });
  const initialInventoryMt = numberValue(record, "initialInventoryMt", fail, { min: 0 });
  const providedInitialInventoryCostUsdPerMt = optionalNumber(
    record,
    "initialInventoryCostUsdPerMt",
    fail,
    { min: 0 },
  );
  const terminalMinInventoryMt = numberValue(record, "terminalMinInventoryMt", fail, { min: 0, defaultValue: 0 });
  const defaultStorageCapacityMt = numberValue(record, "defaultStorageCapacityMt", fail, {
    min: 0,
    exclusiveMin: true,
  });
  if (initialInventoryMt > defaultStorageCapacityMt) {
    fail("initialInventoryMt must be <= defaultStorageCapacityMt.");
  }
  if (terminalMinInventoryMt > defaultStorageCapacityMt) {
    fail("terminalMinInventoryMt must be <= defaultStorageCapacityMt.");
  }
  const shortagePenaltyUsdPerMt = numberValue(record, "shortagePenaltyUsdPerMt", fail, {
    min: 0,
    defaultValue: 0,
  });
  const allowShortage = record.allowShortage === undefined ? false : record.allowShortage;
  if (typeof allowShortage !== "boolean") fail("allowShortage must be a boolean.");
  const initialInventoryUnits = quantityToUnits(initialInventoryMt, stepMt, "initialInventoryMt", fail);
  const terminalMinInventoryUnits = quantityToUnits(
    terminalMinInventoryMt,
    stepMt,
    "terminalMinInventoryMt",
    fail,
  );
  const capacityUnits = quantityToUnits(defaultStorageCapacityMt, stepMt, "defaultStorageCapacityMt", fail);
  if (capacityUnits > 5000) fail("defaultStorageCapacityMt/stepMt must not exceed 5000 states.");
  const periods = arrayValue(record.periods, "periods", fail, { minLength: 1, maxLength: 120 })
    .map((period, index) => normalizePeriod(period, index, stepMt, defaultStorageCapacityMt));
  uniqueIds(periods.map((period) => period.id), "periods", fail);
  const initialInventoryCostUsdPerMt = providedInitialInventoryCostUsdPerMt
    ?? periods[0].purchaseCostUsdPerMt;
  const transitionEstimate = periods.reduce(
    (sum, period) => sum + (period.storageCapacityUnits + 1) * (period.maxPurchaseUnits - period.minPurchaseUnits + 1),
    0,
  );
  if (transitionEstimate > MAX_DP_TRANSITIONS) {
    fail(`estimated search exceeds ${MAX_DP_TRANSITIONS} transitions; increase stepMt or tighten capacity/purchase bounds.`);
  }
  return {
    stepMt,
    initialInventoryMt,
    initialInventoryCostUsdPerMt,
    initialInventoryCostBasisSource: providedInitialInventoryCostUsdPerMt === undefined
      ? "first-period-purchase-cost-proxy" as const
      : "provided" as const,
    initialInventoryUnits,
    terminalMinInventoryMt,
    terminalMinInventoryUnits,
    defaultStorageCapacityMt,
    shortagePenaltyUsdPerMt,
    allowShortage,
    periods,
  };
}

function betterState(candidate: State, current: State | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.totalCostUsd < current.totalCostUsd - 1e-9) return true;
  if (candidate.totalCostUsd > current.totalCostUsd + 1e-9) return false;
  if (candidate.shortageCostUsd < current.shortageCostUsd - 1e-9) return true;
  if (candidate.shortageCostUsd > current.shortageCostUsd + 1e-9) return false;
  const candidatePurchases = candidate.periods.reduce((sum, period) => sum + period.purchaseUnits, 0);
  const currentPurchases = current.periods.reduce((sum, period) => sum + period.purchaseUnits, 0);
  return candidatePurchases < currentPurchases;
}

export function optimizeRollingInventory(value: RollingInventoryInput): RollingInventoryResult {
  const input = normalizeInput(value);
  let states = new Map<number, State>();
  states.set(input.initialInventoryUnits, {
    inventoryUnits: input.initialInventoryUnits,
    purchaseCostUsd: 0,
    holdingCostUsd: 0,
    shortageCostUsd: 0,
    totalCostUsd: 0,
    inventoryBookValueUsd: input.initialInventoryMt * input.initialInventoryCostUsdPerMt,
    periods: [],
  });
  let transitionsEvaluated = 0;

  for (const period of input.periods) {
    const nextStates = new Map<number, State>();
    for (const state of states.values()) {
      for (let purchaseUnits = period.minPurchaseUnits; purchaseUnits <= period.maxPurchaseUnits; purchaseUnits += 1) {
        transitionsEvaluated += 1;
        const availableUnits = state.inventoryUnits + purchaseUnits;
        const fulfilledDemandUnits = Math.min(availableUnits, period.demandUnits);
        const shortageUnits = period.demandUnits - fulfilledDemandUnits;
        if (!input.allowShortage && shortageUnits > 0) continue;
        // Purchases arrive before demand, so capacity applies to peak available inventory.
        if (availableUnits > period.storageCapacityUnits) continue;
        const endingInventoryUnits = availableUnits - fulfilledDemandUnits;
        const purchaseMt = purchaseUnits * input.stepMt;
        const endingInventoryMt = endingInventoryUnits * input.stepMt;
        const shortageMt = shortageUnits * input.stepMt;
        const purchaseCostUsd = purchaseMt * period.purchaseCostUsdPerMt;
        const holdingCostUsd = endingInventoryMt * period.holdingCostUsdPerMt;
        const shortageCostUsd = shortageMt * input.shortagePenaltyUsdPerMt;
        const availableBookValueUsd = state.inventoryBookValueUsd + purchaseCostUsd;
        const averageCost = availableUnits === 0 ? 0 : availableBookValueUsd / (availableUnits * input.stepMt);
        const consumedInventoryBookValueUsd = fulfilledDemandUnits * input.stepMt * averageCost;
        const endingInventoryBookValueUsd = availableBookValueUsd - consumedInventoryBookValueUsd;
        const candidate: State = {
          inventoryUnits: endingInventoryUnits,
          purchaseCostUsd: state.purchaseCostUsd + purchaseCostUsd,
          holdingCostUsd: state.holdingCostUsd + holdingCostUsd,
          shortageCostUsd: state.shortageCostUsd + shortageCostUsd,
          totalCostUsd: state.totalCostUsd + purchaseCostUsd + holdingCostUsd + shortageCostUsd,
          inventoryBookValueUsd: endingInventoryBookValueUsd,
          periods: [...state.periods, {
            id: period.id,
            beginningInventoryUnits: state.inventoryUnits,
            purchaseUnits,
            demandUnits: period.demandUnits,
            fulfilledDemandUnits,
            shortageUnits,
            endingInventoryUnits,
            purchaseCostUsd,
            holdingCostUsd,
            shortageCostUsd,
            consumedInventoryBookValueUsd,
            endingInventoryBookValueUsd,
            rollingAverageCostUsdPerMt: endingInventoryUnits === 0
              ? null
              : endingInventoryBookValueUsd / endingInventoryMt,
          }],
        };
        if (betterState(candidate, nextStates.get(endingInventoryUnits))) {
          nextStates.set(endingInventoryUnits, candidate);
        }
      }
    }
    states = nextStates;
    if (states.size === 0) break;
  }

  const feasible = [...states.values()]
    .filter((state) => state.inventoryUnits >= input.terminalMinInventoryUnits)
    .sort((left, right) => left.totalCostUsd - right.totalCostUsd
      || left.inventoryUnits - right.inventoryUnits);
  const best = feasible[0];
  if (best === undefined) {
    return {
      metadata: METADATA,
      units: UNITS,
      status: "infeasible",
      transitionsEvaluated,
      openingInventoryCostBasis: {
        costUsdPerMt: input.initialInventoryCostUsdPerMt,
        source: input.initialInventoryCostBasisSource,
      },
      infeasibilityReasons: [states.size === 0 ? "NO_FEASIBLE_PERIOD_BALANCE" : "TERMINAL_INVENTORY_UNATTAINABLE"],
      plan: [],
    };
  }

  const plan = best.periods.map((period) => ({
    periodId: period.id,
    beginningInventoryMt: period.beginningInventoryUnits * input.stepMt,
    purchaseMt: period.purchaseUnits * input.stepMt,
    demandMt: period.demandUnits * input.stepMt,
    fulfilledDemandMt: period.fulfilledDemandUnits * input.stepMt,
    shortageMt: period.shortageUnits * input.stepMt,
    endingInventoryMt: period.endingInventoryUnits * input.stepMt,
    balanceResidualMt: round(
      (period.beginningInventoryUnits + period.purchaseUnits - period.fulfilledDemandUnits - period.endingInventoryUnits)
      * input.stepMt,
    ),
    purchaseCostUsd: round(period.purchaseCostUsd),
    holdingCostUsd: round(period.holdingCostUsd),
    shortageCostUsd: round(period.shortageCostUsd),
    consumedInventoryBookValueUsd: round(period.consumedInventoryBookValueUsd),
    endingInventoryBookValueUsd: round(period.endingInventoryBookValueUsd),
    rollingAverageCostUsdPerMt: period.rollingAverageCostUsdPerMt === null
      ? null
      : round(period.rollingAverageCostUsdPerMt),
  }));

  return {
    metadata: METADATA,
    units: UNITS,
    status: "optimal",
    transitionsEvaluated,
    openingInventoryCostBasis: {
      costUsdPerMt: input.initialInventoryCostUsdPerMt,
      source: input.initialInventoryCostBasisSource,
    },
    initialInventoryMt: input.initialInventoryMt,
    terminalMinInventoryMt: input.terminalMinInventoryMt,
    endingInventoryMt: best.inventoryUnits * input.stepMt,
    costs: {
      purchaseCostUsd: round(best.purchaseCostUsd),
      holdingCostUsd: round(best.holdingCostUsd),
      shortageCostUsd: round(best.shortageCostUsd),
      totalCostUsd: round(best.totalCostUsd),
      endingInventoryBookValueUsd: round(best.inventoryBookValueUsd),
      endingRollingAverageCostUsdPerMt: best.inventoryUnits === 0
        ? null
        : round(best.inventoryBookValueUsd / (best.inventoryUnits * input.stepMt)),
    },
    plan,
    infeasibilityReasons: [],
  };
}

export function executeInventoryRequest(value: unknown) {
  const record = objectValue(value, "request", fail);
  assertAllowedKeys(record, ["operation", "input"], "request", fail);
  if (record.operation !== "rolling-plan") fail("operation must be rolling-plan.");
  return optimizeRollingInventory(record.input as RollingInventoryInput);
}
