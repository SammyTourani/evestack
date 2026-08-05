/**
 * JSON-RPC 2.0, hand-rolled.
 *
 * There is no MCP SDK here on purpose: evestack's whole pitch is that you can
 * read every line of it, and the wire format is a few hundred lines of JSON
 * framing. The spec this implements is JSON-RPC 2.0 (https://www.jsonrpc.org/specification)
 * as constrained by MCP — MCP forbids the batch form and forbids a null id on
 * requests, both of which base JSON-RPC allows.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  /** Absent means notification: no response may be sent, not even an error. */
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

/** The reserved codes. MCP adds no codes of its own below -32000. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Thrown by anything that wants to answer with a JSON-RPC `error` rather than a
 * result. Everything else that escapes becomes -32603, because leaking a stack
 * trace to a client that is going to feed it to a model helps nobody.
 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  toErrorObject(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

export function failure(id: JsonRpcId | null, error: JsonRpcErrorObject): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error };
}

/**
 * Validate the envelope before anything looks at `method`.
 *
 * Returns the request, or an error object describing what is wrong with it. A
 * separate `id` is handed back because a malformed request still has to be
 * answered at whatever id it managed to supply — answering at `null` when the
 * client sent `id: 4` leaves that call hanging forever.
 */
export function parseRequest(
  value: unknown,
): { request: JsonRpcRequest } | { error: JsonRpcErrorObject; id: JsonRpcId | null } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // MCP removed JSON-RPC batching in revision 2025-06-18, so an array is not
    // "a batch we do not support" — it is not a valid message at all.
    return {
      error: { code: INVALID_REQUEST, message: "Expected a single JSON-RPC 2.0 object." },
      id: null,
    };
  }

  const record = value as Record<string, unknown>;
  const rawId = record.id;
  const id =
    typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId))
      ? (rawId as JsonRpcId)
      : null;

  if (record.jsonrpc !== "2.0") {
    return { error: { code: INVALID_REQUEST, message: "Expected 'jsonrpc' to be '2.0'." }, id };
  }
  if (typeof record.method !== "string" || record.method.length === 0) {
    return { error: { code: INVALID_REQUEST, message: "Expected 'method' to be a non-empty string." }, id };
  }
  if (rawId !== undefined && id === null) {
    // Explicit `id: null` is legal base JSON-RPC and illegal in MCP. Rejecting
    // it is cheap; silently treating it as a notification would strand a caller
    // that is waiting for a response.
    return {
      error: { code: INVALID_REQUEST, message: "MCP forbids a null request id." },
      id: null,
    };
  }

  return {
    request: {
      jsonrpc: "2.0",
      ...(rawId === undefined ? {} : { id: id as JsonRpcId }),
      method: record.method,
      ...(record.params === undefined ? {} : { params: record.params }),
    },
  };
}

/** `params` is optional in JSON-RPC; MCP only ever sends an object when it sends one. */
export function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcError(INVALID_PARAMS, "Expected 'params' to be an object.");
  }
  return params as Record<string, unknown>;
}
