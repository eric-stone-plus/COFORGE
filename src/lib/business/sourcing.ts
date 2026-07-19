export interface CoalQuality {
  narKcalPerKg: number;
  sulfurPct: number;
  ashPct: number;
  totalMoisturePct: number;
  volatileMatterPct?: number;
  hgi?: number;
  ashFusionDtC?: number;
}

export interface PlantCoalRequirements {
  minNarKcalPerKg: number;
  maxSulfurPct: number;
  maxAshPct: number;
  maxTotalMoisturePct: number;
  volatileMatterRangePct?: [number, number];
  hgiRange?: [number, number];
  minAshFusionDtC?: number;
}

export interface QualityWeights {
  heat: number;
  sulfur: number;
  ash: number;
  moisture: number;
  volatile: number;
  hgi: number;
}

export interface QualityMatchInput {
  coal: CoalQuality;
  requirements: PlantCoalRequirements;
  weights?: QualityWeights;
}

export class SourcingValidationError extends Error {
  readonly code = "SOURCING_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "SourcingValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_QUALITY_WEIGHTS: QualityWeights = {
  heat: 0.35,
  sulfur: 0.25,
  ash: 0.15,
  moisture: 0.1,
  volatile: 0.1,
  hgi: 0.05,
};

function fail(message: string): never {
  throw new SourcingValidationError(message);
}

function objectValue(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function stringValue(record: UnknownRecord, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function numberValue(
  record: UnknownRecord,
  key: string,
  options: {
    label?: string;
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    defaultValue?: number;
  } = {},
): number {
  const raw = record[key];
  const value = raw === undefined && options.defaultValue !== undefined
    ? options.defaultValue
    : raw;
  const label = options.label ?? key;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  if (options.min !== undefined) {
    const invalid = options.exclusiveMin ? value <= options.min : value < options.min;
    if (invalid) fail(`${label} must be ${options.exclusiveMin ? ">" : ">="} ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) fail(`${label} must be <= ${options.max}.`);
  return value;
}

function optionalNumber(
  record: UnknownRecord,
  key: string,
  options: { label?: string; min?: number; max?: number; exclusiveMin?: boolean } = {},
): number | undefined {
  if (record[key] === undefined) return undefined;
  return numberValue(record, key, options);
}

function fractionValue(record: UnknownRecord, key: string, defaultValue: number): number {
  return numberValue(record, key, {
    label: `${key} (decimal fraction)`,
    min: 0,
    max: 1,
    defaultValue,
  });
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseRange(record: UnknownRecord, key: string, min: number, max: number): [number, number] | undefined {
  const raw = record[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length !== 2) fail(`${key} must be a two-number [min, max] range.`);
  const [lower, upper] = raw;
  if (
    typeof lower !== "number" || !Number.isFinite(lower)
    || typeof upper !== "number" || !Number.isFinite(upper)
    || lower < min || upper > max || lower > upper
  ) {
    fail(`${key} must be an ordered finite range within ${min}..${max}.`);
  }
  return [lower, upper];
}

function parseCoalQuality(value: unknown): CoalQuality {
  const record = objectValue(value, "coal");
  return {
    narKcalPerKg: numberValue(record, "narKcalPerKg", { min: 1000, max: 9000 }),
    sulfurPct: numberValue(record, "sulfurPct", { min: 0, max: 100 }),
    ashPct: numberValue(record, "ashPct", { min: 0, max: 100 }),
    totalMoisturePct: numberValue(record, "totalMoisturePct", { min: 0, max: 100 }),
    volatileMatterPct: optionalNumber(record, "volatileMatterPct", { min: 0, max: 100 }),
    hgi: optionalNumber(record, "hgi", { min: 0, max: 200 }),
    ashFusionDtC: optionalNumber(record, "ashFusionDtC", { min: 500, max: 3000 }),
  };
}

function parseRequirements(value: unknown): PlantCoalRequirements {
  const record = objectValue(value, "requirements");
  return {
    minNarKcalPerKg: numberValue(record, "minNarKcalPerKg", { min: 1000, max: 9000 }),
    maxSulfurPct: numberValue(record, "maxSulfurPct", { min: 0, max: 100 }),
    maxAshPct: numberValue(record, "maxAshPct", { min: 0, max: 100 }),
    maxTotalMoisturePct: numberValue(record, "maxTotalMoisturePct", { min: 0, max: 100 }),
    volatileMatterRangePct: parseRange(record, "volatileMatterRangePct", 0, 100),
    hgiRange: parseRange(record, "hgiRange", 0, 200),
    minAshFusionDtC: optionalNumber(record, "minAshFusionDtC", { min: 500, max: 3000 }),
  };
}

function parseWeights(value: unknown): QualityWeights {
  if (value === undefined) return DEFAULT_QUALITY_WEIGHTS;
  const record = objectValue(value, "weights");
  const weights: QualityWeights = {
    heat: numberValue(record, "heat", { min: 0, max: 1 }),
    sulfur: numberValue(record, "sulfur", { min: 0, max: 1 }),
    ash: numberValue(record, "ash", { min: 0, max: 1 }),
    moisture: numberValue(record, "moisture", { min: 0, max: 1 }),
    volatile: numberValue(record, "volatile", { min: 0, max: 1 }),
    hgi: numberValue(record, "hgi", { min: 0, max: 1 }),
  };
  const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);
  if (Math.abs(sum - 1) > 1e-9) fail("quality weights must sum to 1.0; ash-fusion DT is a hard constraint, not a weight.");
  return weights;
}

export type IndicatorDirection = "lower" | "closer" | "range";

export function scoreQualityIndicator(
  actual: number,
  target: number | [number, number],
  direction: IndicatorDirection,
): number {
  if (!Number.isFinite(actual) || actual < 0) fail("actual quality value must be finite and non-negative.");
  if (direction === "range") {
    if (!Array.isArray(target) || target.length !== 2) fail("range scoring requires a [min, max] target.");
    const [lower, upper] = target;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || lower > upper) {
      fail("range target must be finite, non-negative, and ordered.");
    }
    if (actual >= lower && actual <= upper) return 100;
    const width = Math.max(upper - lower, Math.max(upper, 1) * 0.1);
    const distance = actual < lower ? lower - actual : actual - upper;
    return round(Math.max(0, 100 * (1 - distance / width)));
  }
  if (Array.isArray(target) || !Number.isFinite(target) || target <= 0) {
    fail(`${direction} scoring requires a finite target > 0.`);
  }
  if (direction === "lower") {
    if (actual <= target * 0.3) return 100;
    if (actual <= target) return round(100 - 50 * (actual - target * 0.3) / (target * 0.7));
    return 0;
  }
  const tolerance = Math.max(target * 0.1, 1);
  return round(Math.max(0, 100 * (1 - Math.abs(actual - target) / tolerance)));
}

export function matchCoalQuality(value: QualityMatchInput) {
  const record = objectValue(value, "qualityMatch");
  const coal = parseCoalQuality(record.coal);
  const requirements = parseRequirements(record.requirements);
  const weights = parseWeights(record.weights);
  const failures: string[] = [];

  if (coal.narKcalPerKg < requirements.minNarKcalPerKg) failures.push("NAR_BELOW_MINIMUM");
  if (coal.sulfurPct > requirements.maxSulfurPct) failures.push("SULFUR_ABOVE_MAXIMUM");
  if (coal.ashPct > requirements.maxAshPct) failures.push("ASH_ABOVE_MAXIMUM");
  if (coal.totalMoisturePct > requirements.maxTotalMoisturePct) failures.push("MOISTURE_ABOVE_MAXIMUM");
  if (
    requirements.minAshFusionDtC !== undefined
    && (coal.ashFusionDtC === undefined || coal.ashFusionDtC < requirements.minAshFusionDtC)
  ) failures.push("ASH_FUSION_DT_BELOW_MINIMUM");
  if (requirements.volatileMatterRangePct && coal.volatileMatterPct === undefined) {
    failures.push("VOLATILE_MATTER_MISSING");
  }
  if (requirements.hgiRange && coal.hgi === undefined) failures.push("HGI_MISSING");

  const dimensionScores: Record<keyof QualityWeights, number | null> = {
    heat: scoreQualityIndicator(coal.narKcalPerKg, requirements.minNarKcalPerKg, "closer"),
    sulfur: scoreQualityIndicator(coal.sulfurPct, requirements.maxSulfurPct, "lower"),
    ash: scoreQualityIndicator(coal.ashPct, requirements.maxAshPct, "lower"),
    moisture: scoreQualityIndicator(coal.totalMoisturePct, requirements.maxTotalMoisturePct, "lower"),
    volatile: requirements.volatileMatterRangePct && coal.volatileMatterPct !== undefined
      ? scoreQualityIndicator(coal.volatileMatterPct, requirements.volatileMatterRangePct, "range")
      : null,
    hgi: requirements.hgiRange && coal.hgi !== undefined
      ? scoreQualityIndicator(coal.hgi, requirements.hgiRange, "range")
      : null,
  };

  const availableWeights = (Object.keys(weights) as (keyof QualityWeights)[])
    .filter((key) => dimensionScores[key] !== null);
  const availableWeightTotal = availableWeights.reduce((sum, key) => sum + weights[key], 0);
  if (availableWeightTotal <= 0) fail("No scoreable coal-quality dimensions are available.");
  const score = availableWeights.reduce(
    (sum, key) => sum + (dimensionScores[key] as number) * weights[key] / availableWeightTotal,
    0,
  );

  let ashFusionRisk: "unknown" | "high" | "medium" | "low" = "unknown";
  if (requirements.minAshFusionDtC !== undefined && coal.ashFusionDtC !== undefined) {
    const margin = coal.ashFusionDtC - requirements.minAshFusionDtC;
    ashFusionRisk = margin < 0 ? "high" : margin < 50 ? "medium" : "low";
  }

  return {
    units: { score: "0-100", heat: "kcal/kg NAR", qualityPercentages: "percent" },
    eligible: failures.length === 0,
    hardConstraintFailures: failures,
    score: failures.length === 0 ? round(score) : 0,
    dimensionScores,
    ashFusionRisk,
    weights,
  };
}

export interface DomesticCoalCostInput {
  minePriceCnyPerMt: number;
  railFreightCnyPerMt?: number;
  coastalFreightCnyPerMt?: number;
  portChargesCnyPerMt?: number;
  portConstructionFeeCnyPerMt?: number;
  shortHaulCnyPerMt?: number;
  otherCnyPerMt?: number;
  narKcalPerKg: number;
}

export interface ImportedCoalCostInput {
  fobUsdPerMt: number;
  oceanFreightUsdPerMt: number;
  exchangeRateCnyPerUsd: number;
  insuranceRate?: number;
  insuranceMarkupRate?: number;
  importDutyRate?: number;
  portChargesCnyPerMt?: number;
  portConstructionFeeCnyPerMt?: number;
  shortHaulCnyPerMt?: number;
  inspectionCnyPerMt?: number;
  storageCnyPerMt?: number;
  annualFinanceRate?: number;
  financingDays?: number;
  lcFeeRate?: number;
  vatRate?: number;
  vatRecoveryDays?: number;
  narKcalPerKg: number;
}

export interface TradeEconomicsInput {
  domestic: DomesticCoalCostInput;
  imported: ImportedCoalCostInput;
  inversionAlertThresholdCnyPerMillionKcal?: number;
}

function parseDomesticCost(value: unknown): Required<DomesticCoalCostInput> {
  const record = objectValue(value, "domestic");
  return {
    minePriceCnyPerMt: numberValue(record, "minePriceCnyPerMt", { min: 0 }),
    railFreightCnyPerMt: numberValue(record, "railFreightCnyPerMt", { min: 0, defaultValue: 0 }),
    coastalFreightCnyPerMt: numberValue(record, "coastalFreightCnyPerMt", { min: 0, defaultValue: 0 }),
    portChargesCnyPerMt: numberValue(record, "portChargesCnyPerMt", { min: 0, defaultValue: 0 }),
    portConstructionFeeCnyPerMt: numberValue(record, "portConstructionFeeCnyPerMt", { min: 0, defaultValue: 0 }),
    shortHaulCnyPerMt: numberValue(record, "shortHaulCnyPerMt", { min: 0, defaultValue: 0 }),
    otherCnyPerMt: numberValue(record, "otherCnyPerMt", { min: 0, defaultValue: 0 }),
    narKcalPerKg: numberValue(record, "narKcalPerKg", { min: 1000, max: 9000 }),
  };
}

function parseImportedCost(value: unknown): Required<ImportedCoalCostInput> {
  const record = objectValue(value, "imported");
  return {
    fobUsdPerMt: numberValue(record, "fobUsdPerMt", { min: 0 }),
    oceanFreightUsdPerMt: numberValue(record, "oceanFreightUsdPerMt", { min: 0 }),
    exchangeRateCnyPerUsd: numberValue(record, "exchangeRateCnyPerUsd", { min: 0, exclusiveMin: true }),
    insuranceRate: fractionValue(record, "insuranceRate", 0.002),
    insuranceMarkupRate: fractionValue(record, "insuranceMarkupRate", 0.1),
    importDutyRate: fractionValue(record, "importDutyRate", 0),
    portChargesCnyPerMt: numberValue(record, "portChargesCnyPerMt", { min: 0, defaultValue: 0 }),
    portConstructionFeeCnyPerMt: numberValue(record, "portConstructionFeeCnyPerMt", { min: 0, defaultValue: 0 }),
    shortHaulCnyPerMt: numberValue(record, "shortHaulCnyPerMt", { min: 0, defaultValue: 0 }),
    inspectionCnyPerMt: numberValue(record, "inspectionCnyPerMt", { min: 0, defaultValue: 0 }),
    storageCnyPerMt: numberValue(record, "storageCnyPerMt", { min: 0, defaultValue: 0 }),
    annualFinanceRate: fractionValue(record, "annualFinanceRate", 0),
    financingDays: numberValue(record, "financingDays", { min: 0, max: 3650, defaultValue: 0 }),
    lcFeeRate: fractionValue(record, "lcFeeRate", 0),
    vatRate: fractionValue(record, "vatRate", 0.13),
    vatRecoveryDays: numberValue(record, "vatRecoveryDays", { min: 0, max: 3650, defaultValue: 0 }),
    narKcalPerKg: numberValue(record, "narKcalPerKg", { min: 1000, max: 9000 }),
  };
}

function domesticTotal(input: Required<DomesticCoalCostInput>): number {
  return input.minePriceCnyPerMt
    + input.railFreightCnyPerMt
    + input.coastalFreightCnyPerMt
    + input.portChargesCnyPerMt
    + input.portConstructionFeeCnyPerMt
    + input.shortHaulCnyPerMt
    + input.otherCnyPerMt;
}

function importedTotal(input: Required<ImportedCoalCostInput>) {
  const cfrUsdPerMt = input.fobUsdPerMt + input.oceanFreightUsdPerMt;
  const insuranceDenominator = 1 - (1 + input.insuranceMarkupRate) * input.insuranceRate;
  if (insuranceDenominator <= 0) fail("insurance parameters produce a non-positive CIF denominator.");
  const cifUsdPerMt = cfrUsdPerMt / insuranceDenominator;
  const cifCnyPerMt = cifUsdPerMt * input.exchangeRateCnyPerUsd;
  const dutyCnyPerMt = cifCnyPerMt * input.importDutyRate;
  const vatCnyPerMt = (cifCnyPerMt + dutyCnyPerMt) * input.vatRate;
  const financePrincipal = cifCnyPerMt + dutyCnyPerMt;
  const financeCostCnyPerMt = financePrincipal * input.lcFeeRate
    + financePrincipal * input.annualFinanceRate * input.financingDays / 365
    + vatCnyPerMt * input.annualFinanceRate * input.vatRecoveryDays / 365;
  const nonTaxCostsCnyPerMt = input.portChargesCnyPerMt
    + input.portConstructionFeeCnyPerMt
    + input.shortHaulCnyPerMt
    + input.inspectionCnyPerMt
    + input.storageCnyPerMt;
  return {
    cfrUsdPerMt,
    cifUsdPerMt,
    cifCnyPerMt,
    dutyCnyPerMt,
    vatCnyPerMt,
    financeCostCnyPerMt,
    totalCnyPerMt: cifCnyPerMt + dutyCnyPerMt + nonTaxCostsCnyPerMt + financeCostCnyPerMt,
  };
}

function unitHeatCost(totalCnyPerMt: number, narKcalPerKg: number): number {
  return totalCnyPerMt / (narKcalPerKg / 1000);
}

export function compareDomesticAndImported(value: TradeEconomicsInput) {
  const record = objectValue(value, "tradeEconomics");
  const domestic = parseDomesticCost(record.domestic);
  const imported = parseImportedCost(record.imported);
  const threshold = numberValue(record, "inversionAlertThresholdCnyPerMillionKcal", {
    min: 0,
    defaultValue: 0,
  });
  const domesticTotalCnyPerMt = domesticTotal(domestic);
  const importBreakdown = importedTotal(imported);
  const domesticUnit = unitHeatCost(domesticTotalCnyPerMt, domestic.narKcalPerKg);
  const importedUnit = unitHeatCost(importBreakdown.totalCnyPerMt, imported.narKcalPerKg);
  const spread = domesticUnit - importedUnit;

  const importedAtFxOne = importedTotal({ ...imported, exchangeRateCnyPerUsd: 1 });
  const fixedCnyPerMt = imported.portChargesCnyPerMt
    + imported.portConstructionFeeCnyPerMt
    + imported.shortHaulCnyPerMt
    + imported.inspectionCnyPerMt
    + imported.storageCnyPerMt;
  const fxSensitiveAtOne = importedAtFxOne.totalCnyPerMt - fixedCnyPerMt;
  const targetImportedCnyPerMt = domesticUnit * (imported.narKcalPerKg / 1000);
  const breakEvenExchangeRate = fxSensitiveAtOne <= 0
    ? null
    : (targetImportedCnyPerMt - fixedCnyPerMt) / fxSensitiveAtOne;

  return {
    units: {
      totalCost: "CNY/MT",
      unitHeatCost: "CNY per million kcal",
      exchangeRate: "CNY/USD",
      rates: "decimal fraction",
    },
    domestic: {
      totalCostCnyPerMt: round(domesticTotalCnyPerMt),
      unitHeatCostCnyPerMillionKcal: round(domesticUnit),
    },
    imported: {
      totalCostCnyPerMt: round(importBreakdown.totalCnyPerMt),
      unitHeatCostCnyPerMillionKcal: round(importedUnit),
      cfrUsdPerMt: round(importBreakdown.cfrUsdPerMt),
      cifUsdPerMt: round(importBreakdown.cifUsdPerMt),
      cifCnyPerMt: round(importBreakdown.cifCnyPerMt),
      dutyCnyPerMt: round(importBreakdown.dutyCnyPerMt),
      recoverableVatFundingBaseCnyPerMt: round(importBreakdown.vatCnyPerMt),
      financeCostCnyPerMt: round(importBreakdown.financeCostCnyPerMt),
    },
    spreadDomesticMinusImportedCnyPerMillionKcal: round(spread),
    lowerCostSource: spread > 0 ? "imported" as const : spread < 0 ? "domestic" as const : "equal" as const,
    // Inversion means imported coal costs more than domestic per unit of
    // heat (negative spread); alert only on that side of the threshold.
    inversionAlert: spread < 0 && Math.abs(spread) >= threshold,
    breakEvenExchangeRateCnyPerUsd: breakEvenExchangeRate === null || breakEvenExchangeRate < 0
      ? null
      : round(breakEvenExchangeRate),
    vatTreatment: "VAT is excluded from economic purchase cost; only its funding period is charged.",
  };
}

export interface InventoryPositionInput {
  inventoryMt: number;
  dailyConsumptionMt: number;
  inboundConfirmedMt?: number;
  targetDays?: number;
  priceTrend?: "falling" | "stable" | "rising";
  trendConfidence?: number;
  pricePercentile?: number;
  longTermContractFulfillmentPct?: number;
}

export function recommendInventoryPosition(value: InventoryPositionInput) {
  const record = objectValue(value, "inventoryPosition");
  const inventoryMt = numberValue(record, "inventoryMt", { min: 0 });
  const dailyConsumptionMt = numberValue(record, "dailyConsumptionMt", { min: 0, exclusiveMin: true });
  const inboundConfirmedMt = numberValue(record, "inboundConfirmedMt", { min: 0, defaultValue: 0 });
  const targetDays = numberValue(record, "targetDays", { min: 25, max: 45, defaultValue: 35 });
  const rawTrend = record.priceTrend ?? "stable";
  if (!(["falling", "stable", "rising"] as unknown[]).includes(rawTrend)) {
    fail("priceTrend must be falling, stable, or rising.");
  }
  const priceTrend = rawTrend as "falling" | "stable" | "rising";
  const trendConfidence = fractionValue(record, "trendConfidence", 0);
  const pricePercentile = numberValue(record, "pricePercentile", { min: 0, max: 100, defaultValue: 50 });
  const longTermContractFulfillmentPct = numberValue(record, "longTermContractFulfillmentPct", {
    min: 0,
    max: 100,
    defaultValue: 100,
  });
  const effectiveInventoryMt = inventoryMt + inboundConfirmedMt;
  const coverageDays = effectiveInventoryMt / dailyConsumptionMt;

  let status: "emergency" | "warning" | "normal" | "sufficient";
  let action: string;
  if (coverageDays < 15) {
    status = "emergency";
    action = "Replenish immediately; prioritize executable spot and overdue contract volumes.";
  } else if (coverageDays < 25) {
    status = "warning";
    action = "Replenish to plan and verify long-term contract fulfillment first.";
  } else if (coverageDays <= 45) {
    status = "normal";
    action = "Maintain procurement cadence; normal coverage does not imply a zero-order recommendation.";
  } else {
    status = "sufficient";
    action = "Pause incremental procurement or consume excess inventory.";
  }

  let desiredDays = targetDays;
  if (priceTrend === "rising" && trendConfidence >= 0.6 && pricePercentile <= 70) desiredDays = Math.min(45, targetDays + 5);
  if (priceTrend === "falling" && trendConfidence >= 0.6 && pricePercentile >= 30) desiredDays = Math.max(25, targetDays - 5);
  if (longTermContractFulfillmentPct < 90) desiredDays = Math.min(45, desiredDays + 3);
  const recommendedPurchaseMt = Math.max(0, desiredDays * dailyConsumptionMt - effectiveInventoryMt);

  return {
    units: { inventoryAndPurchase: "MT", dailyConsumption: "MT/day", coverage: "days" },
    status,
    coverageDays: round(coverageDays),
    desiredCoverageDays: desiredDays,
    recommendedPurchaseMt: round(recommendedPurchaseMt),
    action,
    reviewLongTermContract: longTermContractFulfillmentPct < 90,
  };
}

export interface SupplierPerformance {
  supplierId: string;
  qualityScore: number;
  landedCostCnyPerMillionKcal: number;
  deliveryScore: number;
  complianceScore: number;
  importedCoal?: boolean;
}

export interface SupplierScoringInput {
  suppliers: SupplierPerformance[];
  weights?: {
    quality: number;
    price: number;
    delivery: number;
    compliance: number;
  };
  importedComplianceWeight?: number;
}

type SupplierWeights = Required<NonNullable<SupplierScoringInput["weights"]>>;

function parseSupplierWeights(value: unknown): SupplierWeights {
  if (value === undefined) return { quality: 0.35, price: 0.3, delivery: 0.25, compliance: 0.1 };
  const record = objectValue(value, "weights");
  const weights = {
    quality: numberValue(record, "quality", { min: 0, max: 1 }),
    price: numberValue(record, "price", { min: 0, max: 1 }),
    delivery: numberValue(record, "delivery", { min: 0, max: 1 }),
    compliance: numberValue(record, "compliance", { min: 0, max: 1 }),
  };
  if (Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9) {
    fail("supplier weights must sum to 1.0.");
  }
  return weights;
}

function importedWeights(base: SupplierWeights, complianceWeight: number): SupplierWeights {
  if (complianceWeight <= base.compliance) return base;
  const nonComplianceBase = 1 - base.compliance;
  const remaining = 1 - complianceWeight;
  return {
    quality: base.quality / nonComplianceBase * remaining,
    price: base.price / nonComplianceBase * remaining,
    delivery: base.delivery / nonComplianceBase * remaining,
    compliance: complianceWeight,
  };
}

export function scoreSuppliers(value: SupplierScoringInput) {
  const record = objectValue(value, "supplierScoring");
  if (!Array.isArray(record.suppliers) || record.suppliers.length === 0 || record.suppliers.length > 1000) {
    fail("suppliers must contain between 1 and 1000 entries.");
  }
  const weights = parseSupplierWeights(record.weights);
  const importedComplianceWeight = numberValue(record, "importedComplianceWeight", {
    min: 0.15,
    max: 1,
    defaultValue: 0.15,
  });
  const seen = new Set<string>();
  const suppliers = record.suppliers.map((raw, index) => {
    const supplier = objectValue(raw, `suppliers[${index}]`);
    const supplierId = stringValue(supplier, "supplierId", `suppliers[${index}].supplierId`);
    if (seen.has(supplierId)) fail(`Duplicate supplierId: ${supplierId}.`);
    seen.add(supplierId);
    return {
      supplierId,
      qualityScore: numberValue(supplier, "qualityScore", { min: 0, max: 100 }),
      landedCostCnyPerMillionKcal: numberValue(supplier, "landedCostCnyPerMillionKcal", { min: 0 }),
      deliveryScore: numberValue(supplier, "deliveryScore", { min: 0, max: 100 }),
      complianceScore: numberValue(supplier, "complianceScore", { min: 0, max: 100 }),
      importedCoal: supplier.importedCoal === true,
    };
  });
  const costs = suppliers.map((supplier) => supplier.landedCostCnyPerMillionKcal);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const rows = suppliers.map((supplier) => {
    const priceScore = maxCost === minCost
      ? 100
      : 100 * (maxCost - supplier.landedCostCnyPerMillionKcal) / (maxCost - minCost);
    const appliedWeights = supplier.importedCoal
      ? importedWeights(weights, importedComplianceWeight)
      : weights;
    const totalScore = supplier.qualityScore * appliedWeights.quality
      + priceScore * appliedWeights.price
      + supplier.deliveryScore * appliedWeights.delivery
      + supplier.complianceScore * appliedWeights.compliance;
    const grade = totalScore >= 90 ? "A" : totalScore >= 80 ? "B" : totalScore >= 70 ? "C" : totalScore >= 60 ? "D" : "E";
    return {
      ...supplier,
      priceScore: round(priceScore),
      totalScore: round(totalScore),
      grade,
      appliedWeights: Object.fromEntries(
        Object.entries(appliedWeights).map(([key, weight]) => [key, round(weight)]),
      ),
    };
  }).sort((left, right) => right.totalScore - left.totalScore);

  return {
    units: { score: "0-100", landedCost: "CNY per million kcal" },
    suppliers: rows.map((row, index) => ({ rank: index + 1, ...row })),
  };
}

export type SourcingOperation = "quality_match" | "trade_economics" | "inventory_position" | "supplier_score";

export function executeSourcingRequest(value: unknown): unknown {
  const request = objectValue(value, "request");
  const operation = stringValue(request, "operation") as SourcingOperation;
  const input = request.input;
  switch (operation) {
    case "quality_match":
      return matchCoalQuality(input as QualityMatchInput);
    case "trade_economics":
      return compareDomesticAndImported(input as TradeEconomicsInput);
    case "inventory_position":
      return recommendInventoryPosition(input as InventoryPositionInput);
    case "supplier_score":
      return scoreSuppliers(input as SupplierScoringInput);
    default:
      fail("operation must be quality_match, trade_economics, inventory_position, or supplier_score.");
  }
}
