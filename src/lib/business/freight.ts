import {
  type EngineMetadata,
  arrayValue,
  assertAllowedKeys,
  numberValue,
  objectValue,
  optionalNumber,
  round,
  validationFail,
} from "./domain-utils";

export interface VoyageCostInput {
  cargoMt: number;
  seaDistanceNm: number;
  ballastDistanceNm?: number;
  ladenSpeedKnots: number;
  ballastSpeedKnots?: number;
  portDays: number;
  idleDays?: number;
  ladenConsumptionMtPerDay: number;
  ballastConsumptionMtPerDay?: number;
  portConsumptionMtPerDay: number;
  idleConsumptionMtPerDay?: number;
  vlsfoPriceUsdPerMt: number;
  bunkerMarginPct?: number;
  portCostsUsd?: number;
  canalCostsUsd?: number;
  otherVoyageCostsUsd?: number;
  commissionPctOfFreight?: number;
  freightRevenueUsd?: number;
  dailyHireUsd?: number;
}

const fail = validationFail("freight");

const VOYAGE_METADATA: EngineMetadata = {
  method: "deterministic distance-speed-consumption voyage cost and net TCE",
  version: "freight-v1.0.0",
  assumptions: [
    "Speeds and consumption rates are constant within laden, ballast, port, and idle phases.",
    "VLSFO price and bunker margin apply uniformly to all voyage fuel consumption.",
    "TCE is net voyage revenue after voyage costs and freight commission divided by total voyage days.",
  ],
};

const UNITS = {
  cargo: "metric tonne",
  distance: "nautical mile",
  speed: "knot (nautical mile/hour)",
  duration: "day (24 hours)",
  consumption: "metric tonne VLSFO/day",
  bunkerPrice: "USD/metric tonne VLSFO",
  cost: "USD",
  unitCost: "USD/cargo metric tonne",
  tce: "USD/day",
  rate: "decimal fraction",
} as const;

function normalizeVoyageCostInput(value: unknown): Required<Omit<VoyageCostInput, "freightRevenueUsd" | "dailyHireUsd">> & Pick<VoyageCostInput, "freightRevenueUsd" | "dailyHireUsd"> {
  const record = objectValue(value, "voyageCost", fail);
  assertAllowedKeys(record, [
    "cargoMt", "seaDistanceNm", "ballastDistanceNm", "ladenSpeedKnots", "ballastSpeedKnots",
    "portDays", "idleDays", "ladenConsumptionMtPerDay", "ballastConsumptionMtPerDay",
    "portConsumptionMtPerDay", "idleConsumptionMtPerDay", "vlsfoPriceUsdPerMt",
    "bunkerMarginPct", "portCostsUsd", "canalCostsUsd", "otherVoyageCostsUsd",
    "commissionPctOfFreight", "freightRevenueUsd", "dailyHireUsd",
  ], "voyageCost", fail);

  const cargoMt = numberValue(record, "cargoMt", fail, { min: 0, exclusiveMin: true });
  const seaDistanceNm = numberValue(record, "seaDistanceNm", fail, { min: 0 });
  const ballastDistanceNm = numberValue(record, "ballastDistanceNm", fail, { min: 0, defaultValue: 0 });
  const ladenSpeedKnots = numberValue(record, "ladenSpeedKnots", fail, { min: 0, exclusiveMin: true, max: 40 });
  const ballastSpeedKnots = numberValue(record, "ballastSpeedKnots", fail, {
    min: 0,
    exclusiveMin: true,
    max: 40,
    defaultValue: ladenSpeedKnots,
  });
  const portDays = numberValue(record, "portDays", fail, { min: 0, max: 3650 });
  const idleDays = numberValue(record, "idleDays", fail, { min: 0, max: 3650, defaultValue: 0 });
  const ladenConsumptionMtPerDay = numberValue(record, "ladenConsumptionMtPerDay", fail, { min: 0, max: 1000 });
  const ballastConsumptionMtPerDay = numberValue(record, "ballastConsumptionMtPerDay", fail, {
    min: 0,
    max: 1000,
    defaultValue: ladenConsumptionMtPerDay,
  });
  const portConsumptionMtPerDay = numberValue(record, "portConsumptionMtPerDay", fail, { min: 0, max: 1000 });
  const idleConsumptionMtPerDay = numberValue(record, "idleConsumptionMtPerDay", fail, {
    min: 0,
    max: 1000,
    defaultValue: portConsumptionMtPerDay,
  });
  const vlsfoPriceUsdPerMt = numberValue(record, "vlsfoPriceUsdPerMt", fail, { min: 0 });
  const bunkerMarginPct = numberValue(record, "bunkerMarginPct", fail, { min: 0, max: 1, defaultValue: 0 });
  const portCostsUsd = numberValue(record, "portCostsUsd", fail, { min: 0, defaultValue: 0 });
  const canalCostsUsd = numberValue(record, "canalCostsUsd", fail, { min: 0, defaultValue: 0 });
  const otherVoyageCostsUsd = numberValue(record, "otherVoyageCostsUsd", fail, { min: 0, defaultValue: 0 });
  const commissionPctOfFreight = numberValue(record, "commissionPctOfFreight", fail, {
    min: 0,
    max: 1,
    defaultValue: 0,
  });
  const freightRevenueUsd = optionalNumber(record, "freightRevenueUsd", fail, { min: 0 });
  const dailyHireUsd = optionalNumber(record, "dailyHireUsd", fail, { min: 0 });

  if (seaDistanceNm + ballastDistanceNm === 0 && portDays + idleDays === 0) {
    fail("voyage must include positive sailing distance or port/idle time.");
  }

  return {
    cargoMt,
    seaDistanceNm,
    ballastDistanceNm,
    ladenSpeedKnots,
    ballastSpeedKnots,
    portDays,
    idleDays,
    ladenConsumptionMtPerDay,
    ballastConsumptionMtPerDay,
    portConsumptionMtPerDay,
    idleConsumptionMtPerDay,
    vlsfoPriceUsdPerMt,
    bunkerMarginPct,
    portCostsUsd,
    canalCostsUsd,
    otherVoyageCostsUsd,
    commissionPctOfFreight,
    freightRevenueUsd,
    dailyHireUsd,
  };
}

export function calculateVoyageCost(value: VoyageCostInput) {
  const input = normalizeVoyageCostInput(value);
  const ladenDays = input.seaDistanceNm / input.ladenSpeedKnots / 24;
  const ballastDays = input.ballastDistanceNm / input.ballastSpeedKnots / 24;
  const totalVoyageDays = ladenDays + ballastDays + input.portDays + input.idleDays;
  const ladenFuelMt = ladenDays * input.ladenConsumptionMtPerDay;
  const ballastFuelMt = ballastDays * input.ballastConsumptionMtPerDay;
  const portFuelMt = input.portDays * input.portConsumptionMtPerDay;
  const idleFuelMt = input.idleDays * input.idleConsumptionMtPerDay;
  const totalFuelMt = ladenFuelMt + ballastFuelMt + portFuelMt + idleFuelMt;
  const effectiveVlsfoPriceUsdPerMt = input.vlsfoPriceUsdPerMt * (1 + input.bunkerMarginPct);
  const bunkerCostUsd = totalFuelMt * effectiveVlsfoPriceUsdPerMt;
  const totalVoyageCostUsd = bunkerCostUsd + input.portCostsUsd + input.canalCostsUsd + input.otherVoyageCostsUsd;
  const voyageCostUsdPerCargoMt = totalVoyageCostUsd / input.cargoMt;
  const commissionUsd = input.freightRevenueUsd === undefined
    ? null
    : input.freightRevenueUsd * input.commissionPctOfFreight;
  const netVoyageRevenueUsd = input.freightRevenueUsd === undefined
    ? null
    : input.freightRevenueUsd - (commissionUsd as number) - totalVoyageCostUsd;
  const tceUsdPerDay = netVoyageRevenueUsd === null ? null : netVoyageRevenueUsd / totalVoyageDays;
  const voyageHireCostUsd = input.dailyHireUsd === undefined ? null : input.dailyHireUsd * totalVoyageDays;
  const profitAfterHireUsd = netVoyageRevenueUsd === null || voyageHireCostUsd === null
    ? null
    : netVoyageRevenueUsd - voyageHireCostUsd;

  return {
    metadata: VOYAGE_METADATA,
    units: UNITS,
    durations: {
      ladenDays: round(ladenDays),
      ballastDays: round(ballastDays),
      portDays: round(input.portDays),
      idleDays: round(input.idleDays),
      totalVoyageDays: round(totalVoyageDays),
    },
    fuel: {
      ladenFuelMt: round(ladenFuelMt),
      ballastFuelMt: round(ballastFuelMt),
      portFuelMt: round(portFuelMt),
      idleFuelMt: round(idleFuelMt),
      totalFuelMt: round(totalFuelMt),
      effectiveVlsfoPriceUsdPerMt: round(effectiveVlsfoPriceUsdPerMt),
    },
    costs: {
      bunkerCostUsd: round(bunkerCostUsd),
      portCostsUsd: round(input.portCostsUsd),
      canalCostsUsd: round(input.canalCostsUsd),
      otherVoyageCostsUsd: round(input.otherVoyageCostsUsd),
      totalVoyageCostUsd: round(totalVoyageCostUsd),
      voyageCostUsdPerCargoMt: round(voyageCostUsdPerCargoMt),
      commissionUsd: commissionUsd === null ? null : round(commissionUsd),
      voyageHireCostUsd: voyageHireCostUsd === null ? null : round(voyageHireCostUsd),
    },
    earnings: {
      netVoyageRevenueUsd: netVoyageRevenueUsd === null ? null : round(netVoyageRevenueUsd),
      tceUsdPerDay: tceUsdPerDay === null ? null : round(tceUsdPerDay),
      profitAfterHireUsd: profitAfterHireUsd === null ? null : round(profitAfterHireUsd),
    },
  };
}

export interface VlsfoScenarioInput {
  voyage: VoyageCostInput;
  pricesUsdPerMt: number[];
}

export function analyzeVlsfoScenarios(value: VlsfoScenarioInput) {
  const record = objectValue(value, "vlsfoScenarios", fail);
  assertAllowedKeys(record, ["voyage", "pricesUsdPerMt"], "vlsfoScenarios", fail);
  const prices = arrayValue(record.pricesUsdPerMt, "pricesUsdPerMt", fail, { minLength: 1, maxLength: 100 })
    .map((raw, index) => {
      const item = { value: raw };
      return numberValue(item, "value", fail, { label: `pricesUsdPerMt[${index}]`, min: 0 });
    });
  const uniquePrices = [...new Set(prices)];
  if (uniquePrices.length !== prices.length) fail("pricesUsdPerMt must not contain duplicates.");
  const voyage = normalizeVoyageCostInput(record.voyage);
  const scenarios = prices.map((price) => {
    const result = calculateVoyageCost({ ...voyage, vlsfoPriceUsdPerMt: price });
    return {
      vlsfoPriceUsdPerMt: price,
      bunkerCostUsd: result.costs.bunkerCostUsd,
      voyageCostUsdPerCargoMt: result.costs.voyageCostUsdPerCargoMt,
      tceUsdPerDay: result.earnings.tceUsdPerDay,
      profitAfterHireUsd: result.earnings.profitAfterHireUsd,
    };
  });
  return {
    metadata: {
      ...VOYAGE_METADATA,
      method: "deterministic one-factor VLSFO scenario revaluation",
    },
    units: UNITS,
    scenarios,
  };
}

export function executeFreightRequest(value: unknown) {
  const record = objectValue(value, "request", fail);
  assertAllowedKeys(record, ["operation", "input"], "request", fail);
  const operationRecord = { operation: record.operation };
  const operation = typeof operationRecord.operation === "string" ? operationRecord.operation : "";
  if (operation === "voyage-cost") return calculateVoyageCost(record.input as VoyageCostInput);
  if (operation === "vlsfo-scenarios") return analyzeVlsfoScenarios(record.input as VlsfoScenarioInput);
  fail("operation must be one of voyage-cost, vlsfo-scenarios.");
}
