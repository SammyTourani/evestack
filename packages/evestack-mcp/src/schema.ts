import { INVALID_PARAMS, RpcError } from "./jsonrpc.js";

/**
 * Just enough JSON Schema to check the arguments this server actually declares.
 *
 * No dependency is available (this package ships with none by design), and a
 * general validator is a lot of code to carry for eight tools. So this covers
 * exactly the keywords used in `tools.ts` — `type`, `enum`, `required`,
 * `properties`, `additionalProperties: false`, `minLength`, `minimum`,
 * `maximum` — and `assertValid` throws if a schema uses anything else, so the
 * subset can never silently stop covering the schemas.
 *
 * The spec lets a server report bad arguments either as a JSON-RPC error or as
 * `isError: true`. Shape violations go out as -32602: a model that sent an
 * array where an object belongs has a malformed call, not a business-logic
 * failure to reason about.
 */

export interface JsonSchema {
  readonly type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
}

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "minimum",
  "maximum",
  "default",
]);

/** Fails the build's own smoke test, not a user's request, if a schema outgrows the validator. */
export function assertSupported(schema: JsonSchema, where: string): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`${where}: schema keyword '${key}' is not supported by src/schema.ts.`);
    }
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertSupported(child, `${where}.${name}`);
  }
  if (schema.items) assertSupported(schema.items, `${where}[]`);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${path} must be an integer, got ${typeOf(value)}`);
      return;
    }
  } else if (schema.type !== undefined && typeOf(value) !== schema.type) {
    errors.push(`${path} must be a ${schema.type}, got ${typeOf(value)}`);
    return;
  }

  if (schema.enum && (typeof value !== "string" || !schema.enum.includes(value))) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return;
  }
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path} must be at least ${schema.minLength} character(s)`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path} must be <= ${schema.maximum}`);
  }

  if (schema.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      // `undefined` cannot survive a JSON round trip, so an explicit null is the
      // only way a client can spell "present but empty" — and for these tools it
      // means the same thing as absent.
      if (record[name] === undefined || record[name] === null) {
        errors.push(`${path === "arguments" ? "" : `${path}.`}${name} is required`);
      }
    }
    for (const [name, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[name];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push(
            `${path}.${name} is not a recognized argument` +
              (schema.properties ? ` (expected: ${Object.keys(schema.properties).join(", ")})` : ""),
          );
        }
        continue;
      }
      if (child === undefined || child === null) continue;
      check(child, childSchema, `${path}.${name}`, errors);
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => check(entry, schema.items!, `${path}[${index}]`, errors));
  }
}

export function validateArguments(
  toolName: string,
  args: unknown,
  schema: JsonSchema,
): Record<string, unknown> {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(INVALID_PARAMS, `Tool '${toolName}': 'arguments' must be an object.`);
  }

  const errors: string[] = [];
  check(value, schema, "arguments", errors);
  if (errors.length > 0) {
    throw new RpcError(INVALID_PARAMS, `Tool '${toolName}': ${errors.join("; ")}.`, {
      tool: toolName,
      errors,
    });
  }
  return value as Record<string, unknown>;
}
