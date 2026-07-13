export type Incoterm = "FOB" | "CFR" | "CIF" | "DES";

export type FreightQuote =
  | { rateUsdPerMt: number; lumpSumUsd?: never }
  | { rateUsdPerMt?: never; lumpSumUsd: number };

export interface FinanceTerms {
  annualRate: number;
  financingDays: number;
  lcFeeRate?: number;
  vatRecoveryDays?: number;
}

export interface DomesticCostItems {
  destinationPortChargesCnyPerMt?: number;
  inlandWaterwayFreightCnyPerMt?: number;
  roadFreightCnyPerMt?: number;
  storageCnyPerMt?: number;
  inspectionCnyPerMt?: number;
  otherCnyPerMt?: number;
}

export interface LandedCostInput {
  incoterm: Incoterm;
  priceUsdPerMt: number;
  quantityMt: number;
  narKcalPerKg: number;
  freight?: FreightQuote;
  exchangeRateCnyPerUsd: number;
  insuranceRate?: number;
  insuranceMarkupRate?: number;
  destinationPortChargesUsdPerMt?: number;
  importDutyRate?: number;
  vatRate?: number;
  domesticCosts?: DomesticCostItems;
  finance?: FinanceTerms;
  sellingPriceCnyPerMt?: number;
  operatingCostCnyPerMt?: number;
}

export interface LandedCostResult {
  units: Record<string, string>;
  incotermsUsdPerMt: Record<Lowercase<Incoterm>, number>;
  freightUsdPerMt: number;
  insuranceUsdPerMt: number;
  cifCnyPerMt: number;
  importDutyCnyPerMt: number;
  vatCnyPerMt: number;
  cashOutlayCnyPerMt: number;
  destinationPortChargesCnyPerMt: number;
  domesticCostsCnyPerMt: number;
  financeCostCnyPerMt: number;
  plantCostCnyPerMt: number;
  costCnyPerMillionKcal: number;
  marginCnyPerMt: number | null;
  marginPctOfSellingPrice: number | null;
  vatTreatment: string;
  warnings: string[];
}

export class BiddingValidationError extends Error {
  readonly code = "BIDDING_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "BiddingValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const INCOTERMS: Incoterm[] = ["FOB", "CFR", "CIF", "DES"];
const DOMESTIC_COST_KEYS: (keyof DomesticCostItems)[] = [
  "destinationPortChargesCnyPerMt",
  "inlandWaterwayFreightCnyPerMt",
  "roadFreightCnyPerMt",
  "storageCnyPerMt",
  "inspectionCnyPerMt",
  "otherCnyPerMt",
];

function fail(message: string): never {
  throw new BiddingValidationError(message);
}

function objectValue(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function stringValue(record: UnknownRecord, key: string, label = key): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
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
    if (invalid) {
      fail(`${label} must be ${options.exclusiveMin ? ">" : ">="} ${options.min}.`);
    }
  }
  if (options.max !== undefined && value > options.max) {
    fail(`${label} must be <= ${options.max}.`);
  }
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
    min: 0,
    max: 1,
    defaultValue,
    label: `${key} (decimal fraction)`,
  });
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseIncoterm(record: UnknownRecord): Incoterm {
  const raw = stringValue(record, "incoterm").toUpperCase();
  if (!INCOTERMS.includes(raw as Incoterm)) {
    fail("incoterm must be one of FOB, CFR, CIF, or DES.");
  }
  return raw as Incoterm;
}

function resolveFreightUsdPerMt(
  input: UnknownRecord,
  quantityMt: number,
): { freightUsdPerMt: number; freight: FreightQuote } {
  if (input.freight === undefined) {
    return { freightUsdPerMt: 0, freight: { rateUsdPerMt: 0 } };
  }

  const freight = objectValue(input.freight, "freight");
  const rate = optionalNumber(freight, "rateUsdPerMt", { min: 0 });
  const lumpSum = optionalNumber(freight, "lumpSumUsd", { min: 0 });
  if ((rate === undefined) === (lumpSum === undefined)) {
    fail("freight must contain exactly one of rateUsdPerMt or lumpSumUsd.");
  }
  if (rate !== undefined) {
    return { freightUsdPerMt: rate, freight: { rateUsdPerMt: rate } };
  }
  return {
    freightUsdPerMt: (lumpSum as number) / quantityMt,
    freight: { lumpSumUsd: lumpSum as number },
  };
}

interface NormalizedLandedCostInput extends LandedCostInput {
  freight: FreightQuote;
  insuranceRate: number;
  insuranceMarkupRate: number;
  destinationPortChargesUsdPerMt: number;
  importDutyRate: number;
  vatRate: number;
  domesticCosts: Required<DomesticCostItems>;
  operatingCostCnyPerMt: number;
}

function normalizeLandedCostInput(value: unknown): {
  input: NormalizedLandedCostInput;
  freightUsdPerMt: number;
} {
  const record = objectValue(value, "input");
  const incoterm = parseIncoterm(record);
  const priceUsdPerMt = numberValue(record, "priceUsdPerMt", { min: 0, exclusiveMin: true });
  const quantityMt = numberValue(record, "quantityMt", { min: 0, exclusiveMin: true });
  const narKcalPerKg = numberValue(record, "narKcalPerKg", {
    min: 1000,
    max: 9000,
    label: "narKcalPerKg",
  });
  const exchangeRateCnyPerUsd = numberValue(record, "exchangeRateCnyPerUsd", {
    min: 0,
    exclusiveMin: true,
  });
  const insuranceRate = fractionValue(record, "insuranceRate", 0.002);
  const insuranceMarkupRate = fractionValue(record, "insuranceMarkupRate", 0.1);
  const destinationPortChargesUsdPerMt = numberValue(record, "destinationPortChargesUsdPerMt", {
    min: 0,
    defaultValue: 0,
  });
  const importDutyRate = fractionValue(record, "importDutyRate", 0);
  const vatRate = fractionValue(record, "vatRate", 0.13);
  const sellingPriceCnyPerMt = optionalNumber(record, "sellingPriceCnyPerMt", { min: 0 });
  const operatingCostCnyPerMt = numberValue(record, "operatingCostCnyPerMt", {
    min: 0,
    defaultValue: 0,
  });
  const resolvedFreight = resolveFreightUsdPerMt(record, quantityMt);

  const domesticRecord = record.domesticCosts === undefined
    ? {}
    : objectValue(record.domesticCosts, "domesticCosts");
  const domesticCosts = Object.fromEntries(
    DOMESTIC_COST_KEYS.map((key) => [
      key,
      numberValue(domesticRecord, key, { min: 0, defaultValue: 0 }),
    ]),
  ) as unknown as Required<DomesticCostItems>;

  let finance: FinanceTerms | undefined;
  if (record.finance !== undefined) {
    const financeRecord = objectValue(record.finance, "finance");
    finance = {
      annualRate: fractionValue(financeRecord, "annualRate", 0),
      financingDays: numberValue(financeRecord, "financingDays", { min: 0, max: 3650 }),
      lcFeeRate: fractionValue(financeRecord, "lcFeeRate", 0),
      vatRecoveryDays: numberValue(financeRecord, "vatRecoveryDays", {
        min: 0,
        max: 3650,
        defaultValue: 0,
      }),
    };
  }

  return {
    freightUsdPerMt: resolvedFreight.freightUsdPerMt,
    input: {
      incoterm,
      priceUsdPerMt,
      quantityMt,
      narKcalPerKg,
      freight: resolvedFreight.freight,
      exchangeRateCnyPerUsd,
      insuranceRate,
      insuranceMarkupRate,
      destinationPortChargesUsdPerMt,
      importDutyRate,
      vatRate,
      domesticCosts,
      finance,
      sellingPriceCnyPerMt,
      operatingCostCnyPerMt,
    },
  };
}

function deriveIncoterms(
  input: NormalizedLandedCostInput,
  freightUsdPerMt: number,
): Record<Lowercase<Incoterm>, number> {
  const insuranceFactor = (1 + input.insuranceMarkupRate) * input.insuranceRate;
  const denominator = 1 - insuranceFactor;
  if (denominator <= 0) {
    fail("insuranceRate and insuranceMarkupRate produce a non-positive CIF denominator.");
  }

  let fob: number;
  let cfr: number;
  let cif: number;
  let des: number;

  switch (input.incoterm) {
    case "FOB":
      fob = input.priceUsdPerMt;
      cfr = fob + freightUsdPerMt;
      cif = cfr / denominator;
      des = cif + input.destinationPortChargesUsdPerMt;
      break;
    case "CFR":
      cfr = input.priceUsdPerMt;
      fob = cfr - freightUsdPerMt;
      cif = cfr / denominator;
      des = cif + input.destinationPortChargesUsdPerMt;
      break;
    case "CIF":
      cif = input.priceUsdPerMt;
      cfr = cif * denominator;
      fob = cfr - freightUsdPerMt;
      des = cif + input.destinationPortChargesUsdPerMt;
      break;
    case "DES":
      des = input.priceUsdPerMt;
      cif = des - input.destinationPortChargesUsdPerMt;
      cfr = cif * denominator;
      fob = cfr - freightUsdPerMt;
      break;
  }

  if ([fob, cfr, cif, des].some((value) => !Number.isFinite(value) || value < 0)) {
    fail("The quote, freight, and port charges imply a negative Incoterm value.");
  }

  return { fob, cfr, cif, des };
}

export function costPerMillionKcal(priceCnyPerMt: number, narKcalPerKg: number): number {
  if (!Number.isFinite(priceCnyPerMt) || priceCnyPerMt < 0) {
    fail("priceCnyPerMt must be a finite non-negative number.");
  }
  if (!Number.isFinite(narKcalPerKg) || narKcalPerKg <= 0) {
    fail("narKcalPerKg must be a finite number > 0.");
  }
  return round(priceCnyPerMt / (narKcalPerKg / 1000));
}

export function normalizePriceByHeat(
  pricePerMt: number,
  actualNarKcalPerKg: number,
  targetNarKcalPerKg: number,
): number {
  if (!Number.isFinite(pricePerMt) || pricePerMt < 0) {
    fail("pricePerMt must be a finite non-negative number.");
  }
  for (const [label, value] of [
    ["actualNarKcalPerKg", actualNarKcalPerKg],
    ["targetNarKcalPerKg", targetNarKcalPerKg],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) fail(`${label} must be a finite number > 0.`);
  }
  return round(pricePerMt * targetNarKcalPerKg / actualNarKcalPerKg);
}

export function calculateLandedCost(value: LandedCostInput): LandedCostResult {
  const { input, freightUsdPerMt } = normalizeLandedCostInput(value);
  const incoterms = deriveIncoterms(input, freightUsdPerMt);
  const insuranceUsdPerMt = incoterms.cif - incoterms.cfr;
  const cifCnyPerMt = incoterms.cif * input.exchangeRateCnyPerUsd;
  const importDutyCnyPerMt = cifCnyPerMt * input.importDutyRate;
  const vatCnyPerMt = (cifCnyPerMt + importDutyCnyPerMt) * input.vatRate;
  const destinationPortChargesCnyPerMt = input.destinationPortChargesUsdPerMt
    * input.exchangeRateCnyPerUsd;
  const domesticCostsCnyPerMt = DOMESTIC_COST_KEYS.reduce(
    (sum, key) => sum + input.domesticCosts[key],
    0,
  );

  const financePrincipal = cifCnyPerMt + importDutyCnyPerMt;
  const financeCostCnyPerMt = input.finance
    ? financePrincipal * (
      input.finance.lcFeeRate ?? 0
    ) + financePrincipal * input.finance.annualRate * input.finance.financingDays / 365
      + vatCnyPerMt * input.finance.annualRate * (input.finance.vatRecoveryDays ?? 0) / 365
    : 0;

  const plantCostCnyPerMt = cifCnyPerMt
    + importDutyCnyPerMt
    + destinationPortChargesCnyPerMt
    + domesticCostsCnyPerMt
    + financeCostCnyPerMt;
  const cashOutlayCnyPerMt = plantCostCnyPerMt + vatCnyPerMt;
  const marginCnyPerMt = input.sellingPriceCnyPerMt === undefined
    ? null
    : input.sellingPriceCnyPerMt - plantCostCnyPerMt - input.operatingCostCnyPerMt;
  const marginPct = marginCnyPerMt === null || !input.sellingPriceCnyPerMt
    ? null
    : marginCnyPerMt / input.sellingPriceCnyPerMt * 100;

  return {
    units: {
      incoterms: "USD/MT",
      freight: "USD/MT",
      costs: "CNY/MT",
      heat: "kcal/kg NAR",
      heatAdjustedCost: "CNY per million kcal",
      rates: "decimal fraction",
    },
    incotermsUsdPerMt: {
      fob: round(incoterms.fob),
      cfr: round(incoterms.cfr),
      cif: round(incoterms.cif),
      des: round(incoterms.des),
    },
    freightUsdPerMt: round(freightUsdPerMt),
    insuranceUsdPerMt: round(insuranceUsdPerMt),
    cifCnyPerMt: round(cifCnyPerMt),
    importDutyCnyPerMt: round(importDutyCnyPerMt),
    vatCnyPerMt: round(vatCnyPerMt),
    cashOutlayCnyPerMt: round(cashOutlayCnyPerMt),
    destinationPortChargesCnyPerMt: round(destinationPortChargesCnyPerMt),
    domesticCostsCnyPerMt: round(domesticCostsCnyPerMt),
    financeCostCnyPerMt: round(financeCostCnyPerMt),
    plantCostCnyPerMt: round(plantCostCnyPerMt),
    costCnyPerMillionKcal: costPerMillionKcal(plantCostCnyPerMt, input.narKcalPerKg),
    marginCnyPerMt: marginCnyPerMt === null ? null : round(marginCnyPerMt),
    marginPctOfSellingPrice: marginPct === null ? null : round(marginPct),
    vatTreatment: "Recoverable VAT is excluded from economic plant cost; only its funding period is charged.",
    warnings: [],
  };
}

export interface BidSource {
  id: string;
  label?: string;
  landedCost: LandedCostInput;
}

export interface MultiSourceComparisonInput {
  targetNarKcalPerKg: number;
  sources: BidSource[];
}

export function compareBidSources(value: MultiSourceComparisonInput) {
  const record = objectValue(value, "comparison");
  const targetNarKcalPerKg = numberValue(record, "targetNarKcalPerKg", {
    min: 1000,
    max: 9000,
  });
  if (!Array.isArray(record.sources) || record.sources.length < 2 || record.sources.length > 100) {
    fail("sources must contain between 2 and 100 entries.");
  }

  const seen = new Set<string>();
  const rows = record.sources.map((rawSource, index) => {
    const source = objectValue(rawSource, `sources[${index}]`);
    const id = stringValue(source, "id", `sources[${index}].id`);
    if (seen.has(id)) fail(`Duplicate source id: ${id}.`);
    seen.add(id);
    const label = source.label === undefined ? id : stringValue(source, "label");
    const landedCost = calculateLandedCost(source.landedCost as LandedCostInput);
    const costInput = normalizeLandedCostInput(source.landedCost).input;
    const heatNormalizedCostCnyPerMt = normalizePriceByHeat(
      landedCost.plantCostCnyPerMt,
      costInput.narKcalPerKg,
      targetNarKcalPerKg,
    );
    return { id, label, heatNormalizedCostCnyPerMt, ...landedCost };
  }).sort((a, b) => a.heatNormalizedCostCnyPerMt - b.heatNormalizedCostCnyPerMt);

  const best = rows[0].heatNormalizedCostCnyPerMt;
  return {
    units: { cost: "CNY/MT at target NAR", heat: "kcal/kg NAR" },
    targetNarKcalPerKg,
    bestSourceId: rows[0].id,
    sources: rows.map((row) => ({
      ...row,
      spreadVsBestCnyPerMt: round(row.heatNormalizedCostCnyPerMt - best),
    })),
  };
}

export interface BidSensitivityInput {
  base: LandedCostInput;
  coalPriceChangesPct?: number[];
  freightChangesPct?: number[];
  exchangeRateChangesPct?: number[];
}

function percentageScenarios(record: UnknownRecord, key: string): number[] {
  const raw = record[key];
  if (raw === undefined) return [0];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 25) {
    fail(`${key} must contain between 1 and 25 percentage-point values.`);
  }
  return raw.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= -100 || value > 1000) {
      fail(`${key}[${index}] must be finite, > -100, and <= 1000.`);
    }
    return value;
  });
}

function changedFreight(base: LandedCostInput, changePct: number): FreightQuote {
  if (!base.freight) return { rateUsdPerMt: 0 };
  const multiplier = 1 + changePct / 100;
  if (base.freight.rateUsdPerMt !== undefined) {
    return { rateUsdPerMt: base.freight.rateUsdPerMt * multiplier };
  }
  return { lumpSumUsd: (base.freight.lumpSumUsd as number) * multiplier };
}

export function analyzeBidSensitivity(value: BidSensitivityInput) {
  const record = objectValue(value, "sensitivity");
  const base = normalizeLandedCostInput(record.base).input;
  const coalChanges = percentageScenarios(record, "coalPriceChangesPct");
  const freightChanges = percentageScenarios(record, "freightChangesPct");
  const fxChanges = percentageScenarios(record, "exchangeRateChangesPct");
  if (coalChanges.length * freightChanges.length * fxChanges.length > 1000) {
    fail("The sensitivity matrix may contain at most 1000 scenarios.");
  }

  const scenarios = coalChanges.flatMap((coalPriceChangePct) =>
    freightChanges.flatMap((freightChangePct) =>
      fxChanges.map((exchangeRateChangePct) => {
        const scenarioInput: LandedCostInput = {
          ...base,
          priceUsdPerMt: base.priceUsdPerMt * (1 + coalPriceChangePct / 100),
          freight: changedFreight(base, freightChangePct),
          exchangeRateCnyPerUsd: base.exchangeRateCnyPerUsd * (1 + exchangeRateChangePct / 100),
        };
        const result = calculateLandedCost(scenarioInput);
        return {
          coalPriceChangePct,
          freightChangePct,
          exchangeRateChangePct,
          plantCostCnyPerMt: result.plantCostCnyPerMt,
          marginCnyPerMt: result.marginCnyPerMt,
          marginPctOfSellingPrice: result.marginPctOfSellingPrice,
          profitable: result.marginCnyPerMt === null ? null : result.marginCnyPerMt >= 0,
        };
      }),
    ),
  );

  return {
    units: { changes: "percent", costAndMargin: "CNY/MT" },
    scenarioCount: scenarios.length,
    scenarios,
  };
}

export interface FreightBreakEvenInput {
  base: LandedCostInput;
  sellingPriceCnyPerMt: number;
  operatingCostCnyPerMt?: number;
  maxSearchFreightUsdPerMt?: number;
}

export function findFreightBreakEven(value: FreightBreakEvenInput) {
  const record = objectValue(value, "breakEven");
  const normalized = normalizeLandedCostInput(record.base).input;
  if (normalized.incoterm !== "FOB") {
    fail("Freight break-even requires an FOB base quote so freight changes affect cost.");
  }
  const sellingPriceCnyPerMt = numberValue(record, "sellingPriceCnyPerMt", {
    min: 0,
    exclusiveMin: true,
  });
  const operatingCostCnyPerMt = numberValue(record, "operatingCostCnyPerMt", {
    min: 0,
    defaultValue: normalized.operatingCostCnyPerMt,
  });
  const maxSearch = numberValue(record, "maxSearchFreightUsdPerMt", {
    min: 0,
    exclusiveMin: true,
    defaultValue: 1000,
  });

  const marginAt = (freightUsdPerMt: number) => calculateLandedCost({
    ...normalized,
    freight: { rateUsdPerMt: freightUsdPerMt },
    sellingPriceCnyPerMt,
    operatingCostCnyPerMt,
  }).marginCnyPerMt as number;

  const marginAtZero = marginAt(0);
  const currentFreight = resolveFreightUsdPerMt(
    objectValue(record.base, "base"),
    normalized.quantityMt,
  ).freightUsdPerMt;
  const currentMargin = marginAt(currentFreight);
  if (marginAtZero <= 0) {
    return {
      units: { freight: "USD/MT", margin: "CNY/MT" },
      status: "already_unprofitable_at_zero_freight" as const,
      breakEvenFreightUsdPerMt: 0,
      currentFreightUsdPerMt: round(currentFreight),
      currentMarginCnyPerMt: round(currentMargin),
      headroomPct: currentFreight === 0 ? 0 : -100,
    };
  }
  if (marginAt(maxSearch) > 0) {
    return {
      units: { freight: "USD/MT", margin: "CNY/MT" },
      status: "not_reached_within_search_limit" as const,
      breakEvenFreightUsdPerMt: null,
      currentFreightUsdPerMt: round(currentFreight),
      currentMarginCnyPerMt: round(currentMargin),
      headroomPct: null,
    };
  }

  let low = 0;
  let high = maxSearch;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (marginAt(midpoint) > 0) low = midpoint;
    else high = midpoint;
  }
  const breakEven = (low + high) / 2;
  const headroomPct = currentFreight === 0
    ? null
    : (breakEven - currentFreight) / currentFreight * 100;
  return {
    units: { freight: "USD/MT", margin: "CNY/MT" },
    status: currentMargin < 0 ? "current_freight_above_break_even" as const : "ok" as const,
    breakEvenFreightUsdPerMt: round(breakEven),
    currentFreightUsdPerMt: round(currentFreight),
    currentMarginCnyPerMt: round(currentMargin),
    headroomPct: headroomPct === null ? null : round(headroomPct),
  };
}

export type AlertLevel = "info" | "warning" | "critical";

export interface FreightProfitWarningInput {
  currentFreightUsdPerMt: number;
  predictedFreightUsdPerMt: number;
  breakEvenFreightUsdPerMt: number;
  volatilityPct?: number;
  criticalHeadroomPct?: number;
  surgeThresholdPct?: number;
  highVolatilityPct?: number;
}

export function freightProfitWarnings(value: FreightProfitWarningInput) {
  const record = objectValue(value, "warningInput");
  const current = numberValue(record, "currentFreightUsdPerMt", { min: 0 });
  const predicted = numberValue(record, "predictedFreightUsdPerMt", { min: 0 });
  const breakEven = numberValue(record, "breakEvenFreightUsdPerMt", {
    min: 0,
    exclusiveMin: true,
  });
  const volatilityPct = numberValue(record, "volatilityPct", { min: 0, defaultValue: 0 });
  const criticalHeadroomPct = numberValue(record, "criticalHeadroomPct", {
    min: 0,
    max: 100,
    defaultValue: 5,
  });
  const surgeThresholdPct = numberValue(record, "surgeThresholdPct", {
    min: 0,
    defaultValue: 20,
  });
  const highVolatilityPct = numberValue(record, "highVolatilityPct", {
    min: 0,
    defaultValue: 15,
  });

  const headroomPct = (breakEven - predicted) / breakEven * 100;
  const predictedChangePct = current === 0 ? null : (predicted - current) / current * 100;
  const alerts: Array<{ code: string; level: AlertLevel; message: string }> = [];

  if (predicted >= breakEven) {
    alerts.push({
      code: "BREAKEVEN_CROSSED",
      level: "critical",
      message: "Predicted freight is at or above the freight break-even point.",
    });
  } else if (headroomPct <= criticalHeadroomPct) {
    alerts.push({
      code: "BREAKEVEN_NEAR",
      level: "critical",
      message: "Predicted freight is within the configured break-even headroom.",
    });
  }
  if (predictedChangePct !== null && predictedChangePct >= surgeThresholdPct) {
    alerts.push({
      code: "FREIGHT_SURGE",
      level: "warning",
      message: "Predicted freight increase exceeds the configured surge threshold.",
    });
  }
  if (volatilityPct >= highVolatilityPct) {
    alerts.push({
      code: "HIGH_VOLATILITY",
      level: "info",
      message: "Freight volatility exceeds the configured threshold.",
    });
  }

  return {
    units: { freight: "USD/MT", percentages: "percent" },
    headroomPct: round(headroomPct),
    predictedChangePct: predictedChangePct === null ? null : round(predictedChangePct),
    alerts,
  };
}

export interface VesselBetaObservation {
  indexLevel: number;
  freightUsdPerMt: number;
}

export interface VesselBetaSeries {
  vesselType: string;
  observations: VesselBetaObservation[];
}

export interface VesselBetaInput {
  series: VesselBetaSeries[];
}

function covariance(left: number[], right: number[]): number {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  return left.reduce(
    (sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean),
    0,
  ) / (left.length - 1);
}

export function analyzeVesselTypeBetas(value: VesselBetaInput) {
  const record = objectValue(value, "betaInput");
  if (!Array.isArray(record.series) || record.series.length === 0 || record.series.length > 20) {
    fail("series must contain between 1 and 20 vessel types.");
  }
  const seen = new Set<string>();
  const results = record.series.map((rawSeries, seriesIndex) => {
    const series = objectValue(rawSeries, `series[${seriesIndex}]`);
    const vesselType = stringValue(series, "vesselType", `series[${seriesIndex}].vesselType`);
    if (seen.has(vesselType)) fail(`Duplicate vesselType: ${vesselType}.`);
    seen.add(vesselType);
    if (!Array.isArray(series.observations) || series.observations.length < 3 || series.observations.length > 5000) {
      fail(`${vesselType} observations must contain between 3 and 5000 points.`);
    }
    const observations = series.observations.map((raw, index) => {
      const observation = objectValue(raw, `${vesselType}.observations[${index}]`);
      return {
        indexLevel: numberValue(observation, "indexLevel", { min: 0, exclusiveMin: true }),
        freightUsdPerMt: numberValue(observation, "freightUsdPerMt", { min: 0, exclusiveMin: true }),
      };
    });
    const indexReturns: number[] = [];
    const freightReturns: number[] = [];
    for (let index = 1; index < observations.length; index += 1) {
      indexReturns.push(observations[index].indexLevel / observations[index - 1].indexLevel - 1);
      freightReturns.push(observations[index].freightUsdPerMt / observations[index - 1].freightUsdPerMt - 1);
    }
    const indexVariance = covariance(indexReturns, indexReturns);
    const freightVariance = covariance(freightReturns, freightReturns);
    if (indexVariance <= Number.EPSILON) {
      fail(`${vesselType} index returns have zero variance; beta is undefined.`);
    }
    const crossCovariance = covariance(freightReturns, indexReturns);
    const correlation = freightVariance <= Number.EPSILON
      ? 0
      : crossCovariance / Math.sqrt(indexVariance * freightVariance);
    return {
      vesselType,
      beta: round(crossCovariance / indexVariance),
      correlation: round(Math.max(-1, Math.min(1, correlation))),
      returnObservationCount: indexReturns.length,
    };
  });

  return {
    units: { beta: "dimensionless return sensitivity", freight: "USD/MT" },
    vesselTypes: results.sort((a, b) => b.beta - a.beta),
  };
}

export type BiddingOperation =
  | "calculate"
  | "compare_sources"
  | "sensitivity"
  | "freight_break_even"
  | "profit_warning"
  | "vessel_beta";

export function executeBiddingRequest(value: unknown): unknown {
  const request = objectValue(value, "request");
  const operation = stringValue(request, "operation") as BiddingOperation;
  const input = request.input;
  switch (operation) {
    case "calculate":
      return calculateLandedCost(input as LandedCostInput);
    case "compare_sources":
      return compareBidSources(input as MultiSourceComparisonInput);
    case "sensitivity":
      return analyzeBidSensitivity(input as BidSensitivityInput);
    case "freight_break_even":
      return findFreightBreakEven(input as FreightBreakEvenInput);
    case "profit_warning":
      return freightProfitWarnings(input as FreightProfitWarningInput);
    case "vessel_beta":
      return analyzeVesselTypeBetas(input as VesselBetaInput);
    default:
      fail("operation must be calculate, compare_sources, sensitivity, freight_break_even, profit_warning, or vessel_beta.");
  }
}
