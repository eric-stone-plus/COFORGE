export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  const?: unknown;
  enum?: readonly unknown[];
  oneOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "date-time";
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  description?: string;
};

export class McpSchemaValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path} ${message}`);
    this.name = "McpSchemaValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function explicitTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

export function assertJsonSchema(value: unknown, schema: JsonSchema, path = "arguments"): void {
  if (schema.oneOf) {
    let matches = 0;
    const errors: McpSchemaValidationError[] = [];
    for (const candidate of schema.oneOf) {
      try {
        assertJsonSchema(value, candidate, path);
        matches += 1;
      } catch (error) {
        if (!(error instanceof McpSchemaValidationError)) throw error;
        errors.push(error);
      }
    }
    if (matches === 0 && errors.length > 0) {
      errors.sort((left, right) => right.path.length - left.path.length);
      throw errors[0];
    }
    if (matches !== 1) throw new McpSchemaValidationError(path, "must match exactly one allowed shape.");
    return;
  }

  if ("const" in schema && !sameJsonValue(value, schema.const)) {
    throw new McpSchemaValidationError(path, `must equal ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum && !schema.enum.some((item) => sameJsonValue(value, item))) {
    throw new McpSchemaValidationError(path, `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}.`);
  }

  switch (schema.type) {
    case "object": {
      if (!isObject(value)) throw new McpSchemaValidationError(path, "must be an object.");
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
        throw new McpSchemaValidationError(path, `must have at least ${schema.minProperties} properties.`);
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        throw new McpSchemaValidationError(path, `must have at most ${schema.maxProperties} properties.`);
      }
      for (const required of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) {
          throw new McpSchemaValidationError(`${path}.${required}`, "is required.");
        }
      }
      const properties = schema.properties ?? {};
      for (const key of keys) {
        const propertySchema = properties[key];
        if (!propertySchema) {
          if (schema.additionalProperties === false) {
            throw new McpSchemaValidationError(`${path}.${key}`, "is not allowed.");
          }
          continue;
        }
        assertJsonSchema(value[key], propertySchema, `${path}.${key}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) throw new McpSchemaValidationError(path, "must be an array.");
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new McpSchemaValidationError(path, `must contain at least ${schema.minItems} items.`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new McpSchemaValidationError(path, `must contain at most ${schema.maxItems} items.`);
      }
      if (schema.uniqueItems) {
        const normalized = value.map((item) => JSON.stringify(item));
        if (new Set(normalized).size !== value.length) {
          throw new McpSchemaValidationError(path, "must not contain duplicate items.");
        }
      }
      if (schema.items) value.forEach((item, index) => assertJsonSchema(item, schema.items!, `${path}[${index}]`));
      return;
    }
    case "string": {
      if (typeof value !== "string") throw new McpSchemaValidationError(path, "must be a string.");
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new McpSchemaValidationError(path, `must contain at least ${schema.minLength} characters.`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new McpSchemaValidationError(path, `must contain at most ${schema.maxLength} characters.`);
      }
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
        throw new McpSchemaValidationError(path, "has an invalid format.");
      }
      if (schema.format === "date-time" && !explicitTimezone(value)) {
        throw new McpSchemaValidationError(path, "must be an ISO-8601 timestamp with an explicit timezone.");
      }
      return;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        throw new McpSchemaValidationError(path, `must be a finite ${schema.type}.`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new McpSchemaValidationError(path, `must be >= ${schema.minimum}.`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new McpSchemaValidationError(path, `must be <= ${schema.maximum}.`);
      }
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        throw new McpSchemaValidationError(path, `must be > ${schema.exclusiveMinimum}.`);
      }
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        throw new McpSchemaValidationError(path, `must be < ${schema.exclusiveMaximum}.`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new McpSchemaValidationError(path, "must be a boolean.");
      return;
    case "null":
      if (value !== null) throw new McpSchemaValidationError(path, "must be null.");
      return;
    default:
      return;
  }
}

export function strictObject(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
  description?: string,
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    maxProperties: Object.keys(properties).length,
    ...(description ? { description } : {}),
  };
}

export function operationShape(operation: string, input: JsonSchema): JsonSchema {
  return strictObject({ operation: { const: operation }, input }, ["operation", "input"]);
}
