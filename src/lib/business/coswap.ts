import {
  type EngineMetadata,
  arrayValue,
  assertAllowedKeys,
  isoInstantValue,
  numberValue,
  objectValue,
  optionalNumber,
  round,
  stringValue,
  uniqueIds,
  validationFail,
} from "./domain-utils";

export interface SwapQualityRequirements {
  minNarKcalPerKg: number;
  maxSulfurPct: number;
  maxAshPct: number;
}

export interface DelayedShipmentInput {
  id: string;
  deliveryWindowStart: string;
  deliveryWindowEnd: string;
  allowedPorts: string[];
  requiredQuantityMt: number;
  quantityTolerancePct?: number;
  originalCostUsdPerMt?: number;
  qualityRequirements?: SwapQualityRequirements;
}

export interface SwapCandidateInput {
  id: string;
  deliveryTime: string;
  port: string;
  quantityMt: number;
  costUsdPerMt: number;
  reliabilityScore?: number;
  narKcalPerKg?: number;
  sulfurPct?: number;
  ashPct?: number;
}

export interface SwapRankingWeights {
  cost: number;
  schedule: number;
  quantity: number;
  reliability: number;
}

export interface SwapAnalysisInput {
  delayedShipments: DelayedShipmentInput[];
  candidates: SwapCandidateInput[];
  rankingWeights?: SwapRankingWeights;
}

const fail = validationFail("coswap");
export const MAX_SWAP_EVALUATIONS = 4_000;

const METADATA: EngineMetadata = {
  method: "per-delayed-shipment hard qualification followed by normalized weighted candidate ranking",
  version: "coswap-v1.0.0",
  assumptions: [
    "Delivery-time eligibility is inclusive of both delivery-window boundaries.",
    "Port codes/names are compared case-insensitively after trimming.",
    "Candidate cargo quantity must fall inside the delayed shipment's configured tolerance band.",
    "Rankings are independent what-if lists; this version does not reserve a candidate or solve one-to-one fleet assignment.",
  ],
};

const UNITS = {
  timestamp: "ISO-8601 instant with explicit timezone; compared as UTC instants",
  quantity: "metric tonne",
  quality: "mass percent except heat",
  heat: "kcal/kg NAR",
  cost: "USD/metric tonne",
  costImpact: "USD",
  score: "0-100",
  tolerance: "decimal fraction",
} as const;

interface QualityRequirements extends SwapQualityRequirements {}

interface DelayedShipment {
  id: string;
  deliveryWindowStart: string;
  deliveryWindowEnd: string;
  startMs: number;
  endMs: number;
  allowedPorts: string[];
  requiredQuantityMt: number;
  quantityTolerancePct: number;
  originalCostUsdPerMt: number | null;
  qualityRequirements: QualityRequirements | null;
}

interface Candidate {
  id: string;
  deliveryTime: string;
  deliveryMs: number;
  port: string;
  normalizedPort: string;
  quantityMt: number;
  costUsdPerMt: number;
  reliabilityScore: number;
  narKcalPerKg: number | null;
  sulfurPct: number | null;
  ashPct: number | null;
}

const DEFAULT_WEIGHTS: SwapRankingWeights = {
  cost: 0.4,
  schedule: 0.25,
  quantity: 0.15,
  reliability: 0.2,
};

function normalizePort(value: string): string {
  return value.trim().toLocaleUpperCase("en-US");
}

function normalizeQualityRequirements(value: unknown, label: string): QualityRequirements {
  const record = objectValue(value, label, fail);
  assertAllowedKeys(record, ["minNarKcalPerKg", "maxSulfurPct", "maxAshPct"], label, fail);
  return {
    minNarKcalPerKg: numberValue(record, "minNarKcalPerKg", fail, { min: 1000, max: 9000 }),
    maxSulfurPct: numberValue(record, "maxSulfurPct", fail, { min: 0, max: 100 }),
    maxAshPct: numberValue(record, "maxAshPct", fail, { min: 0, max: 100 }),
  };
}

function normalizeDelayed(value: unknown, index: number): DelayedShipment {
  const record = objectValue(value, `delayedShipments[${index}]`, fail);
  assertAllowedKeys(record, [
    "id", "deliveryWindowStart", "deliveryWindowEnd", "allowedPorts", "requiredQuantityMt",
    "quantityTolerancePct", "originalCostUsdPerMt", "qualityRequirements",
  ], `delayedShipments[${index}]`, fail);
  const start = isoInstantValue(record, "deliveryWindowStart", fail);
  const end = isoInstantValue(record, "deliveryWindowEnd", fail);
  if (end.epochMs < start.epochMs) {
    fail(`delayedShipments[${index}].deliveryWindowEnd must be >= deliveryWindowStart.`);
  }
  const allowedPorts = arrayValue(record.allowedPorts, `delayedShipments[${index}].allowedPorts`, fail, {
    minLength: 1,
    maxLength: 100,
  }).map((raw, portIndex) => {
    const wrapper = { port: raw };
    return normalizePort(stringValue(wrapper, "port", fail, {
      label: `delayedShipments[${index}].allowedPorts[${portIndex}]`,
      maxLength: 100,
    }));
  });
  uniqueIds(allowedPorts, `delayedShipments[${index}].allowedPorts`, fail);
  return {
    id: stringValue(record, "id", fail, { label: `delayedShipments[${index}].id`, maxLength: 100 }),
    deliveryWindowStart: start.iso,
    deliveryWindowEnd: end.iso,
    startMs: start.epochMs,
    endMs: end.epochMs,
    allowedPorts,
    requiredQuantityMt: numberValue(record, "requiredQuantityMt", fail, { min: 0, exclusiveMin: true }),
    quantityTolerancePct: numberValue(record, "quantityTolerancePct", fail, {
      min: 0,
      max: 1,
      defaultValue: 0.05,
    }),
    originalCostUsdPerMt: optionalNumber(record, "originalCostUsdPerMt", fail, { min: 0 }) ?? null,
    qualityRequirements: record.qualityRequirements === undefined
      ? null
      : normalizeQualityRequirements(record.qualityRequirements, `delayedShipments[${index}].qualityRequirements`),
  };
}

function normalizeCandidate(value: unknown, index: number): Candidate {
  const record = objectValue(value, `candidates[${index}]`, fail);
  assertAllowedKeys(record, [
    "id", "deliveryTime", "port", "quantityMt", "costUsdPerMt", "reliabilityScore",
    "narKcalPerKg", "sulfurPct", "ashPct",
  ], `candidates[${index}]`, fail);
  const delivery = isoInstantValue(record, "deliveryTime", fail);
  const port = stringValue(record, "port", fail, { label: `candidates[${index}].port`, maxLength: 100 });
  return {
    id: stringValue(record, "id", fail, { label: `candidates[${index}].id`, maxLength: 100 }),
    deliveryTime: delivery.iso,
    deliveryMs: delivery.epochMs,
    port,
    normalizedPort: normalizePort(port),
    quantityMt: numberValue(record, "quantityMt", fail, { min: 0, exclusiveMin: true }),
    costUsdPerMt: numberValue(record, "costUsdPerMt", fail, { min: 0 }),
    reliabilityScore: numberValue(record, "reliabilityScore", fail, { min: 0, max: 100, defaultValue: 50 }),
    narKcalPerKg: optionalNumber(record, "narKcalPerKg", fail, { min: 1000, max: 9000 }) ?? null,
    sulfurPct: optionalNumber(record, "sulfurPct", fail, { min: 0, max: 100 }) ?? null,
    ashPct: optionalNumber(record, "ashPct", fail, { min: 0, max: 100 }) ?? null,
  };
}

function normalizeWeights(value: unknown): SwapRankingWeights {
  if (value === undefined) return DEFAULT_WEIGHTS;
  const record = objectValue(value, "rankingWeights", fail);
  assertAllowedKeys(record, ["cost", "schedule", "quantity", "reliability"], "rankingWeights", fail);
  const weights = {
    cost: numberValue(record, "cost", fail, { min: 0, max: 1 }),
    schedule: numberValue(record, "schedule", fail, { min: 0, max: 1 }),
    quantity: numberValue(record, "quantity", fail, { min: 0, max: 1 }),
    reliability: numberValue(record, "reliability", fail, { min: 0, max: 1 }),
  };
  const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);
  if (Math.abs(sum - 1) > 1e-9) fail("rankingWeights must sum to 1.0.");
  return weights;
}

function qualityReasons(delayed: DelayedShipment, candidate: Candidate): string[] {
  const requirements = delayed.qualityRequirements;
  if (requirements === null) return [];
  const reasons: string[] = [];
  if (candidate.narKcalPerKg === null || candidate.sulfurPct === null || candidate.ashPct === null) {
    return ["QUALITY_DATA_MISSING"];
  }
  if (candidate.narKcalPerKg < requirements.minNarKcalPerKg) reasons.push("HEAT_BELOW_MINIMUM");
  if (candidate.sulfurPct > requirements.maxSulfurPct) reasons.push("SULFUR_ABOVE_MAXIMUM");
  if (candidate.ashPct > requirements.maxAshPct) reasons.push("ASH_ABOVE_MAXIMUM");
  return reasons;
}

export function rankCoalSwaps(value: SwapAnalysisInput) {
  const record = objectValue(value, "swapAnalysis", fail);
  assertAllowedKeys(record, ["delayedShipments", "candidates", "rankingWeights"], "swapAnalysis", fail);
  const delayedShipments = arrayValue(record.delayedShipments, "delayedShipments", fail, {
    minLength: 1,
    maxLength: 100,
  }).map((item, index) => normalizeDelayed(item, index));
  const candidates = arrayValue(record.candidates, "candidates", fail, {
    minLength: 1,
    maxLength: 500,
  }).map((item, index) => normalizeCandidate(item, index));
  uniqueIds(delayedShipments.map((shipment) => shipment.id), "delayedShipments", fail);
  uniqueIds(candidates.map((candidate) => candidate.id), "candidates", fail);
  if (delayedShipments.length * candidates.length > MAX_SWAP_EVALUATIONS) {
    fail(`delayedShipments x candidates must not exceed ${MAX_SWAP_EVALUATIONS} evaluations.`);
  }
  const weights = normalizeWeights(record.rankingWeights);

  const results = delayedShipments.map((delayed) => {
    const minimumQuantityMt = delayed.requiredQuantityMt * (1 - delayed.quantityTolerancePct);
    const maximumQuantityMt = delayed.requiredQuantityMt * (1 + delayed.quantityTolerancePct);
    const evaluations = candidates.map((candidate) => {
      const disqualificationReasons: string[] = [];
      if (candidate.deliveryMs < delayed.startMs || candidate.deliveryMs > delayed.endMs) {
        disqualificationReasons.push("OUTSIDE_DELIVERY_WINDOW");
      }
      if (!delayed.allowedPorts.includes(candidate.normalizedPort)) {
        disqualificationReasons.push("PORT_NOT_ALLOWED");
      }
      if (candidate.quantityMt < minimumQuantityMt - 1e-9 || candidate.quantityMt > maximumQuantityMt + 1e-9) {
        disqualificationReasons.push("QUANTITY_OUTSIDE_TOLERANCE");
      }
      disqualificationReasons.push(...qualityReasons(delayed, candidate));
      const midpoint = (delayed.startMs + delayed.endMs) / 2;
      const halfWindow = (delayed.endMs - delayed.startMs) / 2;
      const scheduleScore = halfWindow === 0
        ? 100
        : Math.max(0, 100 * (1 - Math.abs(candidate.deliveryMs - midpoint) / halfWindow));
      const toleranceMt = delayed.requiredQuantityMt * delayed.quantityTolerancePct;
      const quantityScore = toleranceMt === 0
        ? candidate.quantityMt === delayed.requiredQuantityMt ? 100 : 0
        : Math.max(0, 100 * (1 - Math.abs(candidate.quantityMt - delayed.requiredQuantityMt) / toleranceMt));
      const costDeltaUsdPerMt = delayed.originalCostUsdPerMt === null
        ? null
        : candidate.costUsdPerMt - delayed.originalCostUsdPerMt;
      return {
        candidate,
        eligible: disqualificationReasons.length === 0,
        disqualificationReasons,
        scheduleScore,
        quantityScore,
        costDeltaUsdPerMt,
        costImpactUsd: costDeltaUsdPerMt === null ? null : costDeltaUsdPerMt * delayed.requiredQuantityMt,
      };
    });
    const eligible = evaluations.filter((evaluation) => evaluation.eligible);
    const eligibleCosts = eligible.map((evaluation) => evaluation.candidate.costUsdPerMt);
    const minimumCost = eligibleCosts.length > 0 ? Math.min(...eligibleCosts) : null;
    const maximumCost = eligibleCosts.length > 0 ? Math.max(...eligibleCosts) : null;
    const ranked = eligible.map((evaluation) => {
      const costScore = minimumCost === maximumCost
        ? 100
        : 100 * ((maximumCost as number) - evaluation.candidate.costUsdPerMt)
          / ((maximumCost as number) - (minimumCost as number));
      const rankingScore = costScore * weights.cost
        + evaluation.scheduleScore * weights.schedule
        + evaluation.quantityScore * weights.quantity
        + evaluation.candidate.reliabilityScore * weights.reliability;
      return { ...evaluation, costScore, rankingScore };
    }).sort((left, right) => right.rankingScore - left.rankingScore
      || left.candidate.costUsdPerMt - right.candidate.costUsdPerMt
      || left.candidate.id.localeCompare(right.candidate.id));

    const ranks = new Map(ranked.map((evaluation, index) => [evaluation.candidate.id, index + 1]));
    const scores = new Map(ranked.map((evaluation) => [evaluation.candidate.id, evaluation]));
    return {
      delayedShipmentId: delayed.id,
      qualification: {
        deliveryWindowStart: delayed.deliveryWindowStart,
        deliveryWindowEnd: delayed.deliveryWindowEnd,
        allowedPorts: delayed.allowedPorts,
        requiredQuantityMt: delayed.requiredQuantityMt,
        minimumQuantityMt: round(minimumQuantityMt),
        maximumQuantityMt: round(maximumQuantityMt),
        qualityRequirements: delayed.qualityRequirements,
      },
      eligibleCandidateCount: eligible.length,
      candidateEvaluations: evaluations.map((evaluation) => {
        const score = scores.get(evaluation.candidate.id);
        return {
          candidateId: evaluation.candidate.id,
          eligible: evaluation.eligible,
          rank: ranks.get(evaluation.candidate.id) ?? null,
          disqualificationReasons: evaluation.disqualificationReasons,
          deliveryTime: evaluation.candidate.deliveryTime,
          port: evaluation.candidate.port,
          quantityMt: evaluation.candidate.quantityMt,
          costUsdPerMt: evaluation.candidate.costUsdPerMt,
          costDeltaUsdPerMt: evaluation.costDeltaUsdPerMt === null ? null : round(evaluation.costDeltaUsdPerMt),
          costImpactUsd: evaluation.costImpactUsd === null ? null : round(evaluation.costImpactUsd),
          componentScores: score === undefined ? null : {
            cost: round(score.costScore),
            schedule: round(score.scheduleScore),
            quantity: round(score.quantityScore),
            reliability: round(score.candidate.reliabilityScore),
          },
          rankingScore: score === undefined ? null : round(score.rankingScore),
        };
      }).sort((left, right) => {
        if (left.rank !== null && right.rank !== null) return left.rank - right.rank;
        if (left.rank !== null) return -1;
        if (right.rank !== null) return 1;
        return left.candidateId.localeCompare(right.candidateId);
      }),
    };
  });

  return {
    metadata: METADATA,
    units: UNITS,
    rankingWeights: weights,
    delayedShipmentCount: delayedShipments.length,
    candidateCount: candidates.length,
    results,
  };
}

export function executeCoswapRequest(value: unknown) {
  const record = objectValue(value, "request", fail);
  assertAllowedKeys(record, ["operation", "input"], "request", fail);
  if (record.operation !== "rank-swaps") fail("operation must be rank-swaps.");
  return rankCoalSwaps(record.input as SwapAnalysisInput);
}
