import {
  type EngineMetadata,
  arrayValue,
  assertAllowedKeys,
  booleanValue,
  enumValue,
  isoInstantValue,
  numberValue,
  objectValue,
  optionalNumber,
  optionalString,
  round,
  stringValue,
  uniqueIds,
  validationFail,
} from "./domain-utils";

export type LaytimeTreatment = "COUNT" | "DEDUCT";

export interface SofEventInput {
  id: string;
  start: string;
  end: string;
  reason: string;
  sourceRef?: string;
  strictTreatment: LaytimeTreatment;
  concessionTreatment?: LaytimeTreatment;
}

export interface LaytimeClaimInput {
  usedHours?: number;
  amountUsd?: number;
}

export interface LaytimeInput {
  laytimeStart: string;
  operationsComplete: string;
  allowedHours: number;
  demurrageRateUsdPerDay: number;
  despatchRateUsdPerDay?: number;
  onceOnDemurrageAlwaysOnDemurrage?: boolean;
  concessionOverridesDemurrage?: boolean;
  events: SofEventInput[];
  counterpartyClaim?: LaytimeClaimInput;
}

const fail = validationFail("laytime");
export const MAX_LAYTIME_EVENTS = 500;
const MAX_SEGMENT_EVENT_REFS = 20_000;
const MAX_SEGMENT_EVENT_ID_BYTES = 400_000;

const METADATA: EngineMetadata = {
  method: "SOF interval-union timeline with strict and negotiated-concession ledgers",
  version: "laytime-v1.0.0",
  assumptions: [
    "The supplied laytimeStart and operationsComplete instants already reflect the governing charter-party commencement and completion rules.",
    "Overlapping deduction events are unioned, so the same elapsed time is never deducted twice.",
    "Strict mode applies once-on-demurrage-always-on-demurrage when enabled; concession mode can explicitly override that rule.",
    "Positive settlement amounts are demurrage payable and negative amounts are despatch payable.",
  ],
};

const UNITS = {
  time: "hour",
  rate: "USD/day",
  amount: "USD; positive=demurrage, negative=despatch",
  timestamp: "ISO-8601 instant with explicit timezone; normalized to UTC",
} as const;

interface Event {
  id: string;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
  reason: string;
  sourceRef: string | null;
  strictTreatment: LaytimeTreatment;
  concessionTreatment: LaytimeTreatment;
}

interface NormalizedLaytimeInput {
  startIso: string;
  completeIso: string;
  startMs: number;
  completeMs: number;
  allowedHours: number;
  demurrageRateUsdPerDay: number;
  despatchRateUsdPerDay: number;
  onceOnDemurrageAlwaysOnDemurrage: boolean;
  concessionOverridesDemurrage: boolean;
  events: Event[];
  counterpartyClaim: LaytimeClaimInput | null;
}

function normalizeEvent(value: unknown, index: number): Event {
  const record = objectValue(value, `events[${index}]`, fail);
  assertAllowedKeys(record, [
    "id", "start", "end", "reason", "sourceRef", "strictTreatment", "concessionTreatment",
  ], `events[${index}]`, fail);
  const start = isoInstantValue(record, "start", fail);
  const end = isoInstantValue(record, "end", fail);
  if (end.epochMs <= start.epochMs) fail(`events[${index}].end must be after start.`);
  const strictTreatment = enumValue(record, "strictTreatment", ["COUNT", "DEDUCT"] as const, fail);
  let concessionTreatment = strictTreatment;
  if (record.concessionTreatment !== undefined) {
    concessionTreatment = enumValue(record, "concessionTreatment", ["COUNT", "DEDUCT"] as const, fail);
  }
  return {
    id: stringValue(record, "id", fail, { label: `events[${index}].id`, maxLength: 100 }),
    startIso: start.iso,
    endIso: end.iso,
    startMs: start.epochMs,
    endMs: end.epochMs,
    reason: stringValue(record, "reason", fail, { label: `events[${index}].reason`, maxLength: 500 }),
    sourceRef: optionalString(record, "sourceRef", fail, { label: `events[${index}].sourceRef`, maxLength: 200 }) ?? null,
    strictTreatment,
    concessionTreatment,
  };
}

function normalizeLaytimeInput(value: unknown): NormalizedLaytimeInput {
  const record = objectValue(value, "laytime", fail);
  assertAllowedKeys(record, [
    "laytimeStart", "operationsComplete", "allowedHours", "demurrageRateUsdPerDay",
    "despatchRateUsdPerDay", "onceOnDemurrageAlwaysOnDemurrage", "concessionOverridesDemurrage",
    "events", "counterpartyClaim",
  ], "laytime", fail);
  const start = isoInstantValue(record, "laytimeStart", fail);
  const complete = isoInstantValue(record, "operationsComplete", fail);
  if (complete.epochMs <= start.epochMs) fail("operationsComplete must be after laytimeStart.");
  const grossHours = (complete.epochMs - start.epochMs) / 3_600_000;
  if (grossHours > 24 * 3650) fail("laytime window must not exceed 3650 days.");
  const allowedHours = numberValue(record, "allowedHours", fail, { min: 0, max: 24 * 3650 });
  const demurrageRateUsdPerDay = numberValue(record, "demurrageRateUsdPerDay", fail, { min: 0 });
  const despatchRateUsdPerDay = numberValue(record, "despatchRateUsdPerDay", fail, {
    min: 0,
    defaultValue: demurrageRateUsdPerDay / 2,
  });
  const onceOnDemurrageAlwaysOnDemurrage = booleanValue(
    record,
    "onceOnDemurrageAlwaysOnDemurrage",
    fail,
    true,
  );
  const concessionOverridesDemurrage = booleanValue(record, "concessionOverridesDemurrage", fail, true);
  const events = arrayValue(record.events, "events", fail, { maxLength: MAX_LAYTIME_EVENTS })
    .map((event, index) => normalizeEvent(event, index));
  uniqueIds(events.map((event) => event.id), "events", fail);
  for (const event of events) {
    if (event.endMs <= start.epochMs || event.startMs >= complete.epochMs) {
      fail(`event ${event.id} does not overlap the laytime window.`);
    }
  }

  let counterpartyClaim: LaytimeClaimInput | null = null;
  if (record.counterpartyClaim !== undefined) {
    const claimRecord = objectValue(record.counterpartyClaim, "counterpartyClaim", fail);
    assertAllowedKeys(claimRecord, ["usedHours", "amountUsd"], "counterpartyClaim", fail);
    const usedHours = optionalNumber(claimRecord, "usedHours", fail, { min: 0 });
    const amountUsd = optionalNumber(claimRecord, "amountUsd", fail);
    if (usedHours === undefined && amountUsd === undefined) {
      fail("counterpartyClaim must contain usedHours and/or amountUsd.");
    }
    counterpartyClaim = { usedHours, amountUsd };
  }

  return {
    startIso: start.iso,
    completeIso: complete.iso,
    startMs: start.epochMs,
    completeMs: complete.epochMs,
    allowedHours,
    demurrageRateUsdPerDay,
    despatchRateUsdPerDay,
    onceOnDemurrageAlwaysOnDemurrage,
    concessionOverridesDemurrage,
    events,
    counterpartyClaim,
  };
}

type TimelineSegment = {
  startMs: number;
  endMs: number;
  eventIds: string[];
  strictDeduction: boolean;
  concessionDeduction: boolean;
};

function buildTimeline(input: NormalizedLaytimeInput): TimelineSegment[] {
  const boundaries = new Set<number>([input.startMs, input.completeMs]);
  const starts = new Map<number, Event[]>();
  const ends = new Map<number, Event[]>();

  function addChange(changes: Map<number, Event[]>, timestamp: number, event: Event) {
    const current = changes.get(timestamp);
    if (current) current.push(event);
    else changes.set(timestamp, [event]);
  }

  for (const event of input.events) {
    const start = Math.max(input.startMs, event.startMs);
    const end = Math.min(input.completeMs, event.endMs);
    boundaries.add(start);
    boundaries.add(end);
    addChange(starts, start, event);
    addChange(ends, end, event);
  }

  const sorted = [...boundaries].sort((a, b) => a - b);
  const active = new Map<string, Event>();
  let strictDeductions = 0;
  let concessionDeductions = 0;
  let eventRefCount = 0;
  let eventIdBytes = 0;
  const timeline: TimelineSegment[] = [];

  function update(event: Event, direction: 1 | -1) {
    strictDeductions += event.strictTreatment === "DEDUCT" ? direction : 0;
    concessionDeductions += event.concessionTreatment === "DEDUCT" ? direction : 0;
  }

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const segmentStart = sorted[index];
    const segmentEnd = sorted[index + 1];
    for (const event of ends.get(segmentStart) ?? []) {
      if (active.delete(event.id)) update(event, -1);
    }
    for (const event of starts.get(segmentStart) ?? []) {
      active.set(event.id, event);
      update(event, 1);
    }
    if (segmentEnd <= segmentStart) continue;

    const eventIds = [...active.keys()].sort();
    eventRefCount += eventIds.length;
    eventIdBytes += eventIds.reduce((total, id) => total + Buffer.byteLength(id, "utf8"), 0);
    if (eventRefCount > MAX_SEGMENT_EVENT_REFS || eventIdBytes > MAX_SEGMENT_EVENT_ID_BYTES) {
      fail("events produce too much overlapping timeline detail; consolidate overlapping SOF entries.");
    }
    timeline.push({
      startMs: segmentStart,
      endMs: segmentEnd,
      eventIds,
      strictDeduction: strictDeductions > 0,
      concessionDeduction: concessionDeductions > 0,
    });
  }

  return timeline;
}

function calculateLedger(
  input: NormalizedLaytimeInput,
  timeline: TimelineSegment[],
  concession: boolean,
) {
  const segments: Array<{
    start: string;
    end: string;
    elapsedHours: number;
    countedHours: number;
    treatment: LaytimeTreatment;
    eventIds: string[];
    onDemurrage: boolean;
  }> = [];
  let usedHours = 0;
  let deductedHours = 0;

  for (const timelineSegment of timeline) {
    const requestedDeduction = concession
      ? timelineSegment.concessionDeduction
      : timelineSegment.strictDeduction;
    const segmentHours = (timelineSegment.endMs - timelineSegment.startMs) / 3_600_000;
    const onDemurrage = usedHours >= input.allowedHours - 1e-9;
    const demurrageRuleApplies = input.onceOnDemurrageAlwaysOnDemurrage
      && (!concession || !input.concessionOverridesDemurrage);
    const treatment: LaytimeTreatment = requestedDeduction && !(onDemurrage && demurrageRuleApplies)
      ? "DEDUCT"
      : "COUNT";
    const countedHours = treatment === "COUNT" ? segmentHours : 0;
    usedHours += countedHours;
    deductedHours += segmentHours - countedHours;
    segments.push({
      start: new Date(timelineSegment.startMs).toISOString(),
      end: new Date(timelineSegment.endMs).toISOString(),
      elapsedHours: round(segmentHours),
      countedHours: round(countedHours),
      treatment,
      eventIds: timelineSegment.eventIds,
      onDemurrage,
    });
  }

  const differenceHours = usedHours - input.allowedHours;
  const status = differenceHours > 1e-9 ? "DEMURRAGE" : differenceHours < -1e-9 ? "DESPATCH" : "EVEN";
  const amountUsd = differenceHours > 0
    ? differenceHours / 24 * input.demurrageRateUsdPerDay
    : differenceHours < 0
      ? differenceHours / 24 * input.despatchRateUsdPerDay
      : 0;
  return {
    status,
    grossHours: round((input.completeMs - input.startMs) / 3_600_000),
    deductedHours: round(deductedHours),
    usedHours: round(usedHours),
    allowedHours: round(input.allowedHours),
    differenceHours: round(differenceHours),
    settlementAmountUsd: round(amountUsd),
    segments,
  };
}

export function calculateLaytime(value: LaytimeInput) {
  const input = normalizeLaytimeInput(value);
  const timeline = buildTimeline(input);
  const strict = calculateLedger(input, timeline, false);
  const concession = calculateLedger(input, timeline, true);
  const eventAudit = input.events
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
    .map((event) => ({
      id: event.id,
      start: event.startIso,
      end: event.endIso,
      clippedStartUtc: new Date(Math.max(event.startMs, input.startMs)).toISOString(),
      clippedEndUtc: new Date(Math.min(event.endMs, input.completeMs)).toISOString(),
      clippedHours: round(
        (Math.min(event.endMs, input.completeMs) - Math.max(event.startMs, input.startMs)) / 3_600_000,
      ),
      reason: event.reason,
      sourceRef: event.sourceRef,
      strictTreatment: event.strictTreatment,
      concessionTreatment: event.concessionTreatment,
    }));

  const reconciliation = input.counterpartyClaim === null ? null : {
    claim: input.counterpartyClaim,
    strictUsedHoursDelta: input.counterpartyClaim.usedHours === undefined
      ? null
      : round(strict.usedHours - input.counterpartyClaim.usedHours),
    concessionUsedHoursDelta: input.counterpartyClaim.usedHours === undefined
      ? null
      : round(concession.usedHours - input.counterpartyClaim.usedHours),
    strictAmountDeltaUsd: input.counterpartyClaim.amountUsd === undefined
      ? null
      : round(strict.settlementAmountUsd - input.counterpartyClaim.amountUsd),
    concessionAmountDeltaUsd: input.counterpartyClaim.amountUsd === undefined
      ? null
      : round(concession.settlementAmountUsd - input.counterpartyClaim.amountUsd),
  };

  return {
    metadata: METADATA,
    units: UNITS,
    window: {
      laytimeStart: input.startIso,
      operationsComplete: input.completeIso,
      laytimeStartUtc: new Date(input.startMs).toISOString(),
      operationsCompleteUtc: new Date(input.completeMs).toISOString(),
    },
    rules: {
      onceOnDemurrageAlwaysOnDemurrage: input.onceOnDemurrageAlwaysOnDemurrage,
      concessionOverridesDemurrage: input.concessionOverridesDemurrage,
      demurrageRateUsdPerDay: input.demurrageRateUsdPerDay,
      despatchRateUsdPerDay: input.despatchRateUsdPerDay,
    },
    eventAudit,
    strict,
    concession,
    difference: {
      usedHours: round(concession.usedHours - strict.usedHours),
      settlementAmountUsd: round(concession.settlementAmountUsd - strict.settlementAmountUsd),
    },
    reconciliation,
  };
}

export function executeLaytimeRequest(value: unknown) {
  const record = objectValue(value, "request", fail);
  assertAllowedKeys(record, ["operation", "input"], "request", fail);
  const operation = typeof record.operation === "string" ? record.operation : "";
  if (operation !== "calculate") fail("operation must be calculate.");
  return calculateLaytime(record.input as LaytimeInput);
}
