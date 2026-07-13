import { createHash, randomUUID } from "crypto";
import { executeBiddingRequest } from "../business/bidding";
import { executeBlendingRequest } from "../business/blending";
import { executeCoswapRequest } from "../business/coswap";
import { executeFreightRequest } from "../business/freight";
import { executeInventoryRequest } from "../business/inventory";
import { executeLaytimeRequest } from "../business/laytime";
import { executeSourcingRequest } from "../business/sourcing";
import { publicSchemaPayload } from "../data-catalog";
import { queryPublicDb } from "../db";
import { JsonSchema, assertJsonSchema, operationShape, strictObject } from "./mcp-schema";
import { appendMcpAuditEvent } from "./mcp-audit";

export const MCP_MAX_ARGUMENT_BYTES = 1024 * 1024;
export const MCP_MAX_RESULT_BYTES = 2 * 1024 * 1024;

type McpRole = "analyst" | "admin" | "desktop";

export interface CoforgeMcpContext {
  role: McpRole;
  auditPath: string;
}

export interface CoforgeMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
    title: string;
  };
  execute: (argumentsValue: unknown) => unknown | Promise<unknown>;
}

export class CoforgeMcpToolNotFoundError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown COFORGE tool: ${toolName}`);
    this.name = "CoforgeMcpToolNotFoundError";
  }
}

const number = (minimum?: number, maximum?: number): JsonSchema => ({
  type: "number",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const positive = (maximum?: number): JsonSchema => ({
  type: "number",
  exclusiveMinimum: 0,
  ...(maximum === undefined ? {} : { maximum }),
});
const text = (maxLength = 100): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const timestamp: JsonSchema = { type: "string", format: "date-time", maxLength: 40 };
const array = (items: JsonSchema, minItems: number, maxItems: number): JsonSchema => ({
  type: "array", items, minItems, maxItems,
});
const optionalEnum = (...values: readonly string[]): JsonSchema => ({ enum: values });

const freightQuote: JsonSchema = {
  oneOf: [
    strictObject({ rateUsdPerMt: number(0) }, ["rateUsdPerMt"]),
    strictObject({ lumpSumUsd: number(0) }, ["lumpSumUsd"]),
  ],
};

const financeTerms = strictObject({
  annualRate: number(0, 1), financingDays: number(0, 3650), lcFeeRate: number(0, 1), vatRecoveryDays: number(0, 3650),
}, ["annualRate", "financingDays"]);

const domesticCosts = strictObject({
  destinationPortChargesCnyPerMt: number(0), inlandWaterwayFreightCnyPerMt: number(0), roadFreightCnyPerMt: number(0),
  storageCnyPerMt: number(0), inspectionCnyPerMt: number(0), otherCnyPerMt: number(0),
});

const landedCost = strictObject({
  incoterm: optionalEnum("FOB", "CFR", "CIF", "DES"), priceUsdPerMt: positive(), quantityMt: positive(),
  narKcalPerKg: number(1000, 9000), freight: freightQuote, exchangeRateCnyPerUsd: positive(),
  insuranceRate: number(0, 1), insuranceMarkupRate: number(0, 1), destinationPortChargesUsdPerMt: number(0),
  importDutyRate: number(0, 1), vatRate: number(0, 1), domesticCosts, finance: financeTerms,
  sellingPriceCnyPerMt: number(0), operatingCostCnyPerMt: number(0),
}, ["incoterm", "priceUsdPerMt", "quantityMt", "narKcalPerKg", "exchangeRateCnyPerUsd"]);

const biddingSchema: JsonSchema = { oneOf: [
  operationShape("calculate", landedCost),
  operationShape("compare_sources", strictObject({
    targetNarKcalPerKg: number(1000, 9000),
    sources: array(strictObject({ id: text(), label: text(200), landedCost }, ["id", "landedCost"]), 2, 100),
  }, ["targetNarKcalPerKg", "sources"])),
  operationShape("sensitivity", strictObject({
    base: landedCost,
    coalPriceChangesPct: array(number(-99.999999, 1000), 1, 25),
    freightChangesPct: array(number(-99.999999, 1000), 1, 25),
    exchangeRateChangesPct: array(number(-99.999999, 1000), 1, 25),
  }, ["base"])),
  operationShape("freight_break_even", strictObject({
    base: landedCost, sellingPriceCnyPerMt: positive(), operatingCostCnyPerMt: number(0), maxSearchFreightUsdPerMt: positive(),
  }, ["base", "sellingPriceCnyPerMt"])),
  operationShape("profit_warning", strictObject({
    currentFreightUsdPerMt: number(0), predictedFreightUsdPerMt: number(0), breakEvenFreightUsdPerMt: positive(),
    volatilityPct: number(0), criticalHeadroomPct: number(0, 100), surgeThresholdPct: number(0), highVolatilityPct: number(0),
  }, ["currentFreightUsdPerMt", "predictedFreightUsdPerMt", "breakEvenFreightUsdPerMt"])),
  operationShape("vessel_beta", strictObject({
    series: array(strictObject({
      vesselType: text(),
      observations: array(strictObject({ indexLevel: positive(), freightUsdPerMt: positive() }, ["indexLevel", "freightUsdPerMt"]), 3, 5000),
    }, ["vesselType", "observations"]), 1, 20),
  }, ["series"])),
] };

const coalQuality = strictObject({
  narKcalPerKg: number(1000, 9000), sulfurPct: number(0, 100), ashPct: number(0, 100), totalMoisturePct: number(0, 100),
  volatileMatterPct: number(0, 100), hgi: number(0, 200), ashFusionDtC: number(500, 3000),
}, ["narKcalPerKg", "sulfurPct", "ashPct", "totalMoisturePct"]);
const qualityRequirements = strictObject({
  minNarKcalPerKg: number(1000, 9000), maxSulfurPct: number(0, 100), maxAshPct: number(0, 100), maxTotalMoisturePct: number(0, 100),
  volatileMatterRangePct: { type: "array", items: number(0, 100), minItems: 2, maxItems: 2 },
  hgiRange: { type: "array", items: number(0, 200), minItems: 2, maxItems: 2 }, minAshFusionDtC: number(500, 3000),
}, ["minNarKcalPerKg", "maxSulfurPct", "maxAshPct", "maxTotalMoisturePct"]);
const qualityWeights = strictObject({
  heat: number(0, 1), sulfur: number(0, 1), ash: number(0, 1), moisture: number(0, 1), volatile: number(0, 1), hgi: number(0, 1),
}, ["heat", "sulfur", "ash", "moisture", "volatile", "hgi"]);

const domesticCoal = strictObject({
  minePriceCnyPerMt: number(0), railFreightCnyPerMt: number(0), coastalFreightCnyPerMt: number(0), portChargesCnyPerMt: number(0),
  portConstructionFeeCnyPerMt: number(0), shortHaulCnyPerMt: number(0), otherCnyPerMt: number(0), narKcalPerKg: number(1000, 9000),
}, ["minePriceCnyPerMt", "narKcalPerKg"]);
const importedCoal = strictObject({
  fobUsdPerMt: number(0), oceanFreightUsdPerMt: number(0), exchangeRateCnyPerUsd: positive(), insuranceRate: number(0, 1),
  insuranceMarkupRate: number(0, 1), importDutyRate: number(0, 1), portChargesCnyPerMt: number(0), portConstructionFeeCnyPerMt: number(0),
  shortHaulCnyPerMt: number(0), inspectionCnyPerMt: number(0), storageCnyPerMt: number(0), annualFinanceRate: number(0, 1),
  financingDays: number(0, 3650), lcFeeRate: number(0, 1), vatRate: number(0, 1), vatRecoveryDays: number(0, 3650), narKcalPerKg: number(1000, 9000),
}, ["fobUsdPerMt", "oceanFreightUsdPerMt", "exchangeRateCnyPerUsd", "narKcalPerKg"]);
const supplier = strictObject({
  supplierId: text(), qualityScore: number(0, 100), landedCostCnyPerMillionKcal: number(0), deliveryScore: number(0, 100),
  complianceScore: number(0, 100), importedCoal: { type: "boolean" },
}, ["supplierId", "qualityScore", "landedCostCnyPerMillionKcal", "deliveryScore", "complianceScore"]);
const supplierWeights = strictObject({
  quality: number(0, 1), price: number(0, 1), delivery: number(0, 1), compliance: number(0, 1),
}, ["quality", "price", "delivery", "compliance"]);

const sourcingSchema: JsonSchema = { oneOf: [
  operationShape("quality_match", strictObject({ coal: coalQuality, requirements: qualityRequirements, weights: qualityWeights }, ["coal", "requirements"])),
  operationShape("trade_economics", strictObject({
    domestic: domesticCoal, imported: importedCoal, inversionAlertThresholdCnyPerMillionKcal: number(0),
  }, ["domestic", "imported"])),
  operationShape("inventory_position", strictObject({
    inventoryMt: number(0), dailyConsumptionMt: positive(), inboundConfirmedMt: number(0), targetDays: number(25, 45),
    priceTrend: optionalEnum("falling", "stable", "rising"), trendConfidence: number(0, 1), pricePercentile: number(0, 100),
    longTermContractFulfillmentPct: number(0, 100),
  }, ["inventoryMt", "dailyConsumptionMt"])),
  operationShape("supplier_score", strictObject({
    suppliers: array(supplier, 1, 1000), weights: supplierWeights, importedComplianceWeight: number(0.15, 1),
  }, ["suppliers"])),
] };

const voyage = strictObject({
  cargoMt: positive(), seaDistanceNm: number(0), ballastDistanceNm: number(0), ladenSpeedKnots: positive(40), ballastSpeedKnots: positive(40),
  portDays: number(0, 3650), idleDays: number(0, 3650), ladenConsumptionMtPerDay: number(0, 1000), ballastConsumptionMtPerDay: number(0, 1000),
  portConsumptionMtPerDay: number(0, 1000), idleConsumptionMtPerDay: number(0, 1000), vlsfoPriceUsdPerMt: number(0), bunkerMarginPct: number(0, 1),
  portCostsUsd: number(0), canalCostsUsd: number(0), otherVoyageCostsUsd: number(0), commissionPctOfFreight: number(0, 1),
  freightRevenueUsd: number(0), dailyHireUsd: number(0),
}, ["cargoMt", "seaDistanceNm", "ladenSpeedKnots", "portDays", "ladenConsumptionMtPerDay", "portConsumptionMtPerDay", "vlsfoPriceUsdPerMt"]);
const freightSchema: JsonSchema = { oneOf: [
  operationShape("voyage-cost", voyage),
  operationShape("vlsfo-scenarios", strictObject({
    voyage,
    pricesUsdPerMt: { ...array(number(0), 1, 100), uniqueItems: true },
  }, ["voyage", "pricesUsdPerMt"])),
] };

const laytimeEvent = strictObject({
  id: text(), start: timestamp, end: timestamp, reason: text(500), sourceRef: text(200),
  strictTreatment: optionalEnum("COUNT", "DEDUCT"), concessionTreatment: optionalEnum("COUNT", "DEDUCT"),
}, ["id", "start", "end", "reason", "strictTreatment"]);
const laytimeSchema = operationShape("calculate", strictObject({
  laytimeStart: timestamp, operationsComplete: timestamp, allowedHours: number(0, 87600), demurrageRateUsdPerDay: number(0),
  despatchRateUsdPerDay: number(0), onceOnDemurrageAlwaysOnDemurrage: { type: "boolean" }, concessionOverridesDemurrage: { type: "boolean" },
  events: array(laytimeEvent, 0, 500), counterpartyClaim: strictObject({ usedHours: number(0), amountUsd: number() }),
}, ["laytimeStart", "operationsComplete", "allowedHours", "demurrageRateUsdPerDay", "events"]));

const inventoryPeriod = strictObject({
  id: text(), demandMt: number(0), purchaseCostUsdPerMt: number(0), maxPurchaseMt: number(0), minPurchaseMt: number(0),
  holdingCostUsdPerMt: number(0), storageCapacityMt: number(0),
}, ["id", "demandMt", "purchaseCostUsdPerMt", "maxPurchaseMt"]);
const inventorySchema = operationShape("rolling-plan", strictObject({
  initialInventoryMt: number(0), initialInventoryCostUsdPerMt: number(0), terminalMinInventoryMt: number(0), stepMt: positive(),
  defaultStorageCapacityMt: positive(), shortagePenaltyUsdPerMt: number(0), allowShortage: { type: "boolean" }, periods: array(inventoryPeriod, 1, 120),
}, ["initialInventoryMt", "stepMt", "defaultStorageCapacityMt", "periods"]));

const blendSource = strictObject({
  id: text(), availableMt: number(0), costUsdPerMt: number(0), narKcalPerKg: number(1000, 9000), sulfurPct: number(0, 100),
  ashPct: number(0, 100), totalMoisturePct: number(0, 100), minSharePct: number(0, 100), maxSharePct: number(0, 100),
}, ["id", "availableMt", "costUsdPerMt", "narKcalPerKg", "sulfurPct", "ashPct", "totalMoisturePct"]);
const blendRequirements = strictObject({
  targetMt: positive(), stepMt: positive(), minNarKcalPerKg: number(1000, 9000), maxSulfurPct: number(0, 100),
  maxAshPct: number(0, 100), maxTotalMoisturePct: number(0, 100),
}, ["targetMt", "stepMt", "minNarKcalPerKg", "maxSulfurPct", "maxAshPct", "maxTotalMoisturePct"]);
const blendingSchema = operationShape("optimize", strictObject({
  sources: array(blendSource, 1, 12), requirements: blendRequirements, maxSolutions: { type: "integer", minimum: 1, maximum: 20 },
}, ["sources", "requirements"]));

const swapRequirements = strictObject({ minNarKcalPerKg: number(1000, 9000), maxSulfurPct: number(0, 100), maxAshPct: number(0, 100) }, ["minNarKcalPerKg", "maxSulfurPct", "maxAshPct"]);
const delayedShipment = strictObject({
  id: text(), deliveryWindowStart: timestamp, deliveryWindowEnd: timestamp,
  allowedPorts: { ...array(text(), 1, 100), uniqueItems: true }, requiredQuantityMt: positive(),
  quantityTolerancePct: number(0, 1), originalCostUsdPerMt: number(0), qualityRequirements: swapRequirements,
}, ["id", "deliveryWindowStart", "deliveryWindowEnd", "allowedPorts", "requiredQuantityMt"]);
const swapCandidate = strictObject({
  id: text(), deliveryTime: timestamp, port: text(), quantityMt: positive(), costUsdPerMt: number(0), reliabilityScore: number(0, 100),
  narKcalPerKg: number(1000, 9000), sulfurPct: number(0, 100), ashPct: number(0, 100),
}, ["id", "deliveryTime", "port", "quantityMt", "costUsdPerMt"]);
const swapWeights = strictObject({ cost: number(0, 1), schedule: number(0, 1), quantity: number(0, 1), reliability: number(0, 1) }, ["cost", "schedule", "quantity", "reliability"]);
const coswapSchema = operationShape("rank-swaps", strictObject({
  delayedShipments: array(delayedShipment, 1, 500), candidates: array(swapCandidate, 1, 500), rankingWeights: swapWeights,
}, ["delayedShipments", "candidates"]));

const querySchema = strictObject({
  sql: { type: "string", minLength: 1, maxLength: 12_000, description: "One read-only SELECT over the advertised public catalog." },
  maxRows: { type: "integer", minimum: 1, maximum: 500 },
}, ["sql"]);

function tool(name: string, title: string, description: string, inputSchema: JsonSchema, execute: CoforgeMcpTool["execute"]): CoforgeMcpTool {
  return {
    name, title, description, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title },
    execute,
  };
}

export const COFORGE_MCP_TOOLS: readonly CoforgeMcpTool[] = Object.freeze([
  tool("schema", "Public data schema", "List the fixed public tables and columns available to the guarded query tool. No storage location or database path is exposed.", strictObject({}), () => publicSchemaPayload()),
  tool("query", "Guarded public query", "Run one read-only SELECT against only the advertised public tables and columns. SQL is parsed, row/column/byte/time bounded, isolated, and audited.", querySchema, async (value) => {
    const args = value as { sql: string; maxRows?: number };
    return queryPublicDb(args.sql, { source: "agent", maxRows: args.maxRows });
  }),
  tool("bidding", "Bidding engine", "Calculate landed cost, compare bids, and run bounded bidding sensitivities.", biddingSchema, executeBiddingRequest),
  tool("sourcing", "Sourcing engine", "Evaluate coal quality, domestic/import economics, inventory position, and supplier scores.", sourcingSchema, executeSourcingRequest),
  tool("freight", "Freight engine", "Calculate bounded voyage costs and VLSFO scenarios.", freightSchema, executeFreightRequest),
  tool("laytime", "Laytime engine", "Calculate a bounded, deterministic SOF laytime ledger.", laytimeSchema, executeLaytimeRequest),
  tool("inventory", "Inventory engine", "Optimize a bounded rolling inventory plan.", inventorySchema, executeInventoryRequest),
  tool("blending", "Blending engine", "Optimize a bounded discrete coal blend.", blendingSchema, executeBlendingRequest),
  tool("coswap", "CO-SWAP engine", "Rank bounded substitute-cargo scenarios for delayed shipments.", coswapSchema, executeCoswapRequest),
]);

const toolByName = new Map(COFORGE_MCP_TOOLS.map((entry) => [entry.name, entry]));

export function listCoforgeMcpTools() {
  return COFORGE_MCP_TOOLS.map(({ execute: _execute, ...metadata }) => metadata);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function callCoforgeMcpTool(name: string, argumentsValue: unknown, context: CoforgeMcpContext): Promise<unknown> {
  if (!(context.role === "analyst" || context.role === "admin" || context.role === "desktop")) {
    throw new Error("COFORGE analyst authorization is required.");
  }
  const callId = randomUUID();
  const safeToolName = /^[a-z][a-z0-9_-]{0,63}$/.test(name) ? name : "invalid-tool";
  let serializedInput = "";
  let inputHash = createHash("sha256").update("").digest("hex");
  try {
    serializedInput = JSON.stringify(argumentsValue);
    inputHash = createHash("sha256").update(serializedInput).digest("hex");
  } catch {
    await appendMcpAuditEvent({
      callId,
      tool: safeToolName,
      operation: safeToolName,
      role: context.role,
      outcome: "rejected",
      inputHash,
      errorCode: "ARGUMENT_SERIALIZATION_FAILED",
    }, context.auditPath);
    throw new Error("Tool arguments must be JSON serializable.");
  }
  const operation = typeof argumentsValue === "object" && argumentsValue !== null && "operation" in argumentsValue
    && typeof argumentsValue.operation === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(argumentsValue.operation)
    ? argumentsValue.operation
    : safeToolName;
  const selected = toolByName.get(name);
  if (!selected) {
    await appendMcpAuditEvent({
      callId, tool: safeToolName, operation, role: context.role, outcome: "rejected", inputHash,
      errorCode: "TOOL_NOT_FOUND",
    }, context.auditPath);
    throw new CoforgeMcpToolNotFoundError(name);
  }
  if (Buffer.byteLength(serializedInput, "utf8") > MCP_MAX_ARGUMENT_BYTES) {
    await appendMcpAuditEvent({
      callId, tool: name, operation, role: context.role, outcome: "rejected", inputHash,
      errorCode: "ARGUMENTS_TOO_LARGE",
    }, context.auditPath);
    throw new Error("Tool arguments exceed the byte limit.");
  }
  try {
    assertJsonSchema(argumentsValue, selected.inputSchema);
  } catch (error) {
    await appendMcpAuditEvent({
      callId, tool: name, operation, role: context.role, outcome: "rejected", inputHash,
      errorCode: "SCHEMA_REJECTED",
    }, context.auditPath);
    throw error;
  }
  let result: unknown;
  try {
    result = await selected.execute(argumentsValue);
  } catch (error) {
    await appendMcpAuditEvent({
      callId,
      tool: name,
      operation,
      role: context.role,
      outcome: "failed",
      inputHash,
      errorCode: "TOOL_EXECUTION_FAILED",
    }, context.auditPath);
    throw error;
  }
  const serializedResult = JSON.stringify(result);
  const resultHash = createHash("sha256").update(serializedResult).digest("hex");
  const envelope = {
    schemaVersion: 1,
    tool: name,
    operation,
    result,
    evidence: {
      callId,
      inputHash,
      resultHash,
    },
  };
  if (byteLength(envelope) + 60 > MCP_MAX_RESULT_BYTES) {
    await appendMcpAuditEvent({
      callId, tool: name, operation, role: context.role, outcome: "failed", inputHash, resultHash,
      errorCode: "RESULT_TOO_LARGE",
    }, context.auditPath);
    throw new Error("Tool result exceeds the byte limit; reduce the request scope.");
  }
  const auditEvent = await appendMcpAuditEvent({
    callId,
    tool: name,
    operation,
    role: context.role,
    outcome: "success",
    inputHash,
    resultHash,
  }, context.auditPath);
  return {
    ...envelope,
    evidence: { ...envelope.evidence, auditEventId: auditEvent.eventId },
  };
}
