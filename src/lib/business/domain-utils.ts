export type ValidationFail = (message: string) => never;

export interface EngineMetadata {
  method: string;
  version: string;
  assumptions: string[];
}

export class DomainValidationError extends Error {
  readonly code = "DOMAIN_VALIDATION_ERROR";
  readonly domain: string;

  constructor(domain: string, message: string) {
    super(message);
    this.name = "DomainValidationError";
    this.domain = domain;
  }
}

export type UnknownRecord = Record<string, unknown>;

export function validationFail(domain: string): ValidationFail {
  return (message: string): never => {
    throw new DomainValidationError(domain, message);
  };
}

export function objectValue(value: unknown, label: string, fail: ValidationFail): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

export function assertAllowedKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  label: string,
  fail: ValidationFail,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    fail(`${label} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
  }
}

export function arrayValue(
  value: unknown,
  label: string,
  fail: ValidationFail,
  options: { minLength?: number; maxLength?: number } = {},
): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (options.minLength !== undefined && value.length < options.minLength) {
    fail(`${label} must contain at least ${options.minLength} item(s).`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    fail(`${label} must contain at most ${options.maxLength} item(s).`);
  }
  return value;
}

export function stringValue(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
  options: { label?: string; maxLength?: number } = {},
): string {
  const label = options.label ?? key;
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (options.maxLength !== undefined && normalized.length > options.maxLength) {
    fail(`${label} must contain at most ${options.maxLength} characters.`);
  }
  return normalized;
}

export function optionalString(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
  options: { label?: string; maxLength?: number } = {},
): string | undefined {
  if (record[key] === undefined) return undefined;
  return stringValue(record, key, fail, options);
}

export function numberValue(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
  options: {
    label?: string;
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    integer?: boolean;
    defaultValue?: number;
  } = {},
): number {
  const raw = record[key];
  const value = raw === undefined && options.defaultValue !== undefined ? options.defaultValue : raw;
  const label = options.label ?? key;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  if (options.integer && !Number.isSafeInteger(value)) fail(`${label} must be a safe integer.`);
  if (options.min !== undefined) {
    const invalid = options.exclusiveMin ? value <= options.min : value < options.min;
    if (invalid) fail(`${label} must be ${options.exclusiveMin ? ">" : ">="} ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) fail(`${label} must be <= ${options.max}.`);
  return value;
}

export function optionalNumber(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
  options: {
    label?: string;
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    integer?: boolean;
  } = {},
): number | undefined {
  if (record[key] === undefined) return undefined;
  return numberValue(record, key, fail, options);
}

export function booleanValue(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
  defaultValue?: boolean,
): boolean {
  const value = record[key] === undefined ? defaultValue : record[key];
  if (typeof value !== "boolean") fail(`${key} must be a boolean.`);
  return value;
}

export function enumValue<T extends string>(
  record: UnknownRecord,
  key: string,
  values: readonly T[],
  fail: ValidationFail,
): T {
  const value = stringValue(record, key, fail);
  if (!values.includes(value as T)) fail(`${key} must be one of ${values.join(", ")}.`);
  return value as T;
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isoInstantValue(
  record: UnknownRecord,
  key: string,
  fail: ValidationFail,
): { iso: string; epochMs: number } {
  const value = stringValue(record, key, fail);
  const match = ISO_INSTANT.exec(value);
  if (!match) fail(`${key} must be an ISO-8601 timestamp with an explicit timezone.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
  ) fail(`${key} is not a valid calendar timestamp.`);
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) fail(`${key} has an invalid timezone offset.`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) fail(`${key} must be a valid ISO-8601 timestamp.`);
  return { iso: value, epochMs };
}

export function quantityToUnits(
  quantity: number,
  step: number,
  label: string,
  fail: ValidationFail,
): number {
  const units = quantity / step;
  const rounded = Math.round(units);
  if (Math.abs(units - rounded) > 1e-8 || !Number.isSafeInteger(rounded)) {
    fail(`${label} must be an exact multiple of stepMt (${step}).`);
  }
  return rounded;
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function uniqueIds(ids: string[], label: string, fail: ValidationFail): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`${label} contains duplicate id: ${id}.`);
    seen.add(id);
  }
}
