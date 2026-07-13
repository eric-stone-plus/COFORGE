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

export interface BlendCoalSourceInput {
  id: string;
  availableMt: number;
  costUsdPerMt: number;
  narKcalPerKg: number;
  sulfurPct: number;
  ashPct: number;
  totalMoisturePct: number;
  minSharePct?: number;
  maxSharePct?: number;
}

export interface BlendRequirementsInput {
  targetMt: number;
  stepMt: number;
  minNarKcalPerKg: number;
  maxSulfurPct: number;
  maxAshPct: number;
  maxTotalMoisturePct: number;
}

export interface BlendOptimizationInput {
  sources: BlendCoalSourceInput[];
  requirements: BlendRequirementsInput;
  maxSolutions?: number;
}

const fail = validationFail("blending");
// This engine runs synchronously in the request process. Keep exhaustive
// enumeration bounded so an otherwise valid input cannot monopolize a core.
export const MAX_ENUMERATED_SOLUTIONS = 25_000;

const METADATA: EngineMetadata = {
  method: "exact discrete linear blend enumeration with mass-balance and weighted-quality constraints",
  version: "blending-v1.0.0",
  assumptions: [
    "All blend quantities are exact multiples of stepMt.",
    "NAR, sulfur, ash, moisture, and unit cost are mass-weighted linear properties.",
    "Source availability and configured share bounds apply to the single target batch.",
    "The returned optimum is global over the declared discrete search space.",
  ],
};

const UNITS = {
  quantity: "metric tonne",
  heat: "kcal/kg NAR",
  quality: "mass percent",
  share: "percent of target mass",
  unitCost: "USD/metric tonne",
  totalCost: "USD",
} as const;

interface Source {
  id: string;
  availableMt: number;
  costUsdPerMt: number;
  narKcalPerKg: number;
  sulfurPct: number;
  ashPct: number;
  totalMoisturePct: number;
  minSharePct: number;
  maxSharePct: number;
  minUnits: number;
  maxUnits: number;
}

interface Requirements extends BlendRequirementsInput {
  targetUnits: number;
}

function normalizeSource(value: unknown, index: number, requirements: Requirements): Source {
  const record = objectValue(value, `sources[${index}]`, fail);
  assertAllowedKeys(record, [
    "id", "availableMt", "costUsdPerMt", "narKcalPerKg", "sulfurPct", "ashPct",
    "totalMoisturePct", "minSharePct", "maxSharePct",
  ], `sources[${index}]`, fail);
  const availableMt = numberValue(record, "availableMt", fail, { min: 0 });
  const availableUnits = quantityToUnits(availableMt, requirements.stepMt, `sources[${index}].availableMt`, fail);
  const minSharePct = numberValue(record, "minSharePct", fail, { min: 0, max: 100, defaultValue: 0 });
  const maxSharePct = numberValue(record, "maxSharePct", fail, { min: 0, max: 100, defaultValue: 100 });
  if (minSharePct > maxSharePct) fail(`sources[${index}].minSharePct must be <= maxSharePct.`);
  const minUnits = Math.ceil(requirements.targetUnits * minSharePct / 100 - 1e-10);
  const maxShareUnits = Math.floor(requirements.targetUnits * maxSharePct / 100 + 1e-10);
  const maxUnits = Math.min(availableUnits, maxShareUnits);
  if (minUnits > maxUnits) {
    fail(`sources[${index}] cannot meet its minimum share within availability and maximum share.`);
  }
  return {
    id: stringValue(record, "id", fail, { label: `sources[${index}].id`, maxLength: 100 }),
    availableMt,
    costUsdPerMt: numberValue(record, "costUsdPerMt", fail, { min: 0 }),
    narKcalPerKg: numberValue(record, "narKcalPerKg", fail, { min: 1000, max: 9000 }),
    sulfurPct: numberValue(record, "sulfurPct", fail, { min: 0, max: 100 }),
    ashPct: numberValue(record, "ashPct", fail, { min: 0, max: 100 }),
    totalMoisturePct: numberValue(record, "totalMoisturePct", fail, { min: 0, max: 100 }),
    minSharePct,
    maxSharePct,
    minUnits,
    maxUnits,
  };
}

function normalizeInput(value: unknown) {
  const record = objectValue(value, "blendOptimization", fail);
  assertAllowedKeys(record, ["sources", "requirements", "maxSolutions"], "blendOptimization", fail);
  const requirementsRecord = objectValue(record.requirements, "requirements", fail);
  assertAllowedKeys(requirementsRecord, [
    "targetMt", "stepMt", "minNarKcalPerKg", "maxSulfurPct", "maxAshPct", "maxTotalMoisturePct",
  ], "requirements", fail);
  const targetMt = numberValue(requirementsRecord, "targetMt", fail, { min: 0, exclusiveMin: true });
  const stepMt = numberValue(requirementsRecord, "stepMt", fail, { min: 0, exclusiveMin: true });
  if (stepMt > targetMt) fail("stepMt must be <= targetMt.");
  const targetUnits = quantityToUnits(targetMt, stepMt, "requirements.targetMt", fail);
  if (targetUnits > 2000) fail("targetMt/stepMt must not exceed 2000 discrete units.");
  const requirements: Requirements = {
    targetMt,
    stepMt,
    targetUnits,
    minNarKcalPerKg: numberValue(requirementsRecord, "minNarKcalPerKg", fail, { min: 1000, max: 9000 }),
    maxSulfurPct: numberValue(requirementsRecord, "maxSulfurPct", fail, { min: 0, max: 100 }),
    maxAshPct: numberValue(requirementsRecord, "maxAshPct", fail, { min: 0, max: 100 }),
    maxTotalMoisturePct: numberValue(requirementsRecord, "maxTotalMoisturePct", fail, { min: 0, max: 100 }),
  };
  const sources = arrayValue(record.sources, "sources", fail, { minLength: 1, maxLength: 12 })
    .map((source, index) => normalizeSource(source, index, requirements));
  uniqueIds(sources.map((source) => source.id), "sources", fail);
  const maxSolutions = numberValue(record, "maxSolutions", fail, { min: 1, max: 20, integer: true, defaultValue: 5 });
  return { requirements, sources, maxSolutions };
}

function countAllocations(sources: Source[], targetUnits: number): number {
  let counts = new Array<number>(targetUnits + 1).fill(0);
  counts[0] = 1;
  for (const source of sources) {
    const next = new Array<number>(targetUnits + 1).fill(0);
    for (let current = 0; current <= targetUnits; current += 1) {
      if (counts[current] === 0) continue;
      for (let units = source.minUnits; units <= source.maxUnits && current + units <= targetUnits; units += 1) {
        next[current + units] = Math.min(
          MAX_ENUMERATED_SOLUTIONS + 1,
          next[current + units] + counts[current],
        );
      }
    }
    counts = next;
  }
  return counts[targetUnits];
}

function qualityForAllocation(sources: Source[], allocation: number[], requirements: Requirements) {
  const weighted = (selector: (source: Source) => number) => sources.reduce(
    (sum, source, index) => sum + allocation[index] * selector(source),
    0,
  ) / requirements.targetUnits;
  return {
    narKcalPerKg: weighted((source) => source.narKcalPerKg),
    sulfurPct: weighted((source) => source.sulfurPct),
    ashPct: weighted((source) => source.ashPct),
    totalMoisturePct: weighted((source) => source.totalMoisturePct),
  };
}

function propertyEnvelope(
  sources: Source[],
  targetUnits: number,
  selector: (source: Source) => number,
  ascending: boolean,
): number | null {
  const allocation = sources.map((source) => source.minUnits);
  let remaining = targetUnits - allocation.reduce((sum, units) => sum + units, 0);
  const order = sources
    .map((source, index) => ({ source, index }))
    .sort((left, right) => {
      const difference = selector(left.source) - selector(right.source);
      return (ascending ? difference : -difference) || left.source.id.localeCompare(right.source.id);
    });
  for (const { source, index } of order) {
    const addition = Math.min(remaining, source.maxUnits - allocation[index]);
    allocation[index] += addition;
    remaining -= addition;
  }
  if (remaining !== 0) return null;
  return sources.reduce((sum, source, index) => sum + allocation[index] * selector(source), 0) / targetUnits;
}

export function optimizeCoalBlend(value: BlendOptimizationInput) {
  const { sources, requirements, maxSolutions } = normalizeInput(value);
  const minTotalUnits = sources.reduce((sum, source) => sum + source.minUnits, 0);
  const maxTotalUnits = sources.reduce((sum, source) => sum + source.maxUnits, 0);
  const envelope = {
    narKcalPerKg: {
      min: propertyEnvelope(sources, requirements.targetUnits, (source) => source.narKcalPerKg, true),
      max: propertyEnvelope(sources, requirements.targetUnits, (source) => source.narKcalPerKg, false),
    },
    sulfurPct: {
      min: propertyEnvelope(sources, requirements.targetUnits, (source) => source.sulfurPct, true),
      max: propertyEnvelope(sources, requirements.targetUnits, (source) => source.sulfurPct, false),
    },
    ashPct: {
      min: propertyEnvelope(sources, requirements.targetUnits, (source) => source.ashPct, true),
      max: propertyEnvelope(sources, requirements.targetUnits, (source) => source.ashPct, false),
    },
    totalMoisturePct: {
      min: propertyEnvelope(sources, requirements.targetUnits, (source) => source.totalMoisturePct, true),
      max: propertyEnvelope(sources, requirements.targetUnits, (source) => source.totalMoisturePct, false),
    },
  };
  const infeasibilityReasons: string[] = [];
  if (minTotalUnits > requirements.targetUnits) infeasibilityReasons.push("MINIMUM_SHARES_EXCEED_TARGET");
  if (maxTotalUnits < requirements.targetUnits) infeasibilityReasons.push("INSUFFICIENT_AVAILABLE_MASS");
  if (envelope.narKcalPerKg.max !== null && envelope.narKcalPerKg.max < requirements.minNarKcalPerKg - 1e-9) {
    infeasibilityReasons.push("HEAT_MINIMUM_UNATTAINABLE");
  }
  if (envelope.sulfurPct.min !== null && envelope.sulfurPct.min > requirements.maxSulfurPct + 1e-9) {
    infeasibilityReasons.push("SULFUR_MAXIMUM_UNATTAINABLE");
  }
  if (envelope.ashPct.min !== null && envelope.ashPct.min > requirements.maxAshPct + 1e-9) {
    infeasibilityReasons.push("ASH_MAXIMUM_UNATTAINABLE");
  }
  if (
    envelope.totalMoisturePct.min !== null
    && envelope.totalMoisturePct.min > requirements.maxTotalMoisturePct + 1e-9
  ) infeasibilityReasons.push("MOISTURE_MAXIMUM_UNATTAINABLE");

  const searchSpaceSize = minTotalUnits <= requirements.targetUnits && maxTotalUnits >= requirements.targetUnits
    ? countAllocations(sources, requirements.targetUnits)
    : 0;
  if (searchSpaceSize > MAX_ENUMERATED_SOLUTIONS) {
    fail(`discrete search space exceeds ${MAX_ENUMERATED_SOLUTIONS} allocations; increase stepMt or tighten share bounds.`);
  }

  const solutions: Array<{
    totalCostUsd: number;
    unitCostUsdPerMt: number;
    quality: ReturnType<typeof qualityForAllocation>;
    allocation: number[];
  }> = [];
  const allocation = new Array<number>(sources.length).fill(0);
  const suffixMin = new Array<number>(sources.length + 1).fill(0);
  const suffixMax = new Array<number>(sources.length + 1).fill(0);
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    suffixMin[index] = suffixMin[index + 1] + sources[index].minUnits;
    suffixMax[index] = suffixMax[index + 1] + sources[index].maxUnits;
  }

  function visit(index: number, remaining: number): void {
    if (index === sources.length) {
      if (remaining !== 0) return;
      const quality = qualityForAllocation(sources, allocation, requirements);
      if (
        quality.narKcalPerKg + 1e-9 < requirements.minNarKcalPerKg
        || quality.sulfurPct - 1e-9 > requirements.maxSulfurPct
        || quality.ashPct - 1e-9 > requirements.maxAshPct
        || quality.totalMoisturePct - 1e-9 > requirements.maxTotalMoisturePct
      ) return;
      const totalCostUsd = sources.reduce(
        (sum, source, sourceIndex) => sum + allocation[sourceIndex] * requirements.stepMt * source.costUsdPerMt,
        0,
      );
      solutions.push({
        totalCostUsd,
        unitCostUsdPerMt: totalCostUsd / requirements.targetMt,
        quality,
        allocation: allocation.slice(),
      });
      solutions.sort((left, right) => left.totalCostUsd - right.totalCostUsd
        || left.allocation.join(",").localeCompare(right.allocation.join(",")));
      if (solutions.length > maxSolutions) solutions.pop();
      return;
    }
    const source = sources[index];
    const lower = Math.max(source.minUnits, remaining - suffixMax[index + 1]);
    const upper = Math.min(source.maxUnits, remaining - suffixMin[index + 1]);
    for (let units = lower; units <= upper; units += 1) {
      allocation[index] = units;
      visit(index + 1, remaining - units);
    }
  }
  if (searchSpaceSize > 0) visit(0, requirements.targetUnits);
  if (solutions.length === 0 && infeasibilityReasons.length === 0) {
    infeasibilityReasons.push("COMBINED_QUALITY_CONSTRAINTS_INFEASIBLE");
  }

  return {
    metadata: METADATA,
    units: UNITS,
    status: solutions.length > 0 ? "optimal" : "infeasible",
    targetMt: requirements.targetMt,
    stepMt: requirements.stepMt,
    searchSpaceSize,
    evaluatedAllAllocations: true,
    qualityEnvelope: Object.fromEntries(Object.entries(envelope).map(([key, range]) => [
      key,
      {
        min: range.min === null ? null : round(range.min),
        max: range.max === null ? null : round(range.max),
      },
    ])),
    infeasibilityReasons,
    solutions: solutions.map((solution, rank) => ({
      rank: rank + 1,
      totalCostUsd: round(solution.totalCostUsd),
      unitCostUsdPerMt: round(solution.unitCostUsdPerMt),
      quality: Object.fromEntries(Object.entries(solution.quality).map(([key, metric]) => [key, round(metric)])),
      constraintMargins: {
        heatAboveMinimumKcalPerKg: round(solution.quality.narKcalPerKg - requirements.minNarKcalPerKg),
        sulfurBelowMaximumPct: round(requirements.maxSulfurPct - solution.quality.sulfurPct),
        ashBelowMaximumPct: round(requirements.maxAshPct - solution.quality.ashPct),
        moistureBelowMaximumPct: round(requirements.maxTotalMoisturePct - solution.quality.totalMoisturePct),
      },
      allocations: sources.map((source, index) => ({
        sourceId: source.id,
        quantityMt: solution.allocation[index] * requirements.stepMt,
        sharePct: round(solution.allocation[index] / requirements.targetUnits * 100),
        costUsd: round(solution.allocation[index] * requirements.stepMt * source.costUsdPerMt),
      })),
    })),
  };
}

export function executeBlendingRequest(value: unknown) {
  const record = objectValue(value, "request", fail);
  assertAllowedKeys(record, ["operation", "input"], "request", fail);
  if (record.operation !== "optimize") fail("operation must be optimize.");
  return optimizeCoalBlend(record.input as BlendOptimizationInput);
}
