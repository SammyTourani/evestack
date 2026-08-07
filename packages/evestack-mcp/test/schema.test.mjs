import assert from "node:assert/strict";
import { test } from "node:test";
import { INVALID_PARAMS, RpcError } from "../dist/jsonrpc.js";
import { assertSupported, validateArguments } from "../dist/schema.js";

/**
 * The validator is a deliberate subset of JSON Schema, and a subset is only safe
 * while `assertSupported` really refuses everything outside it — an advertised
 * constraint that is not actually enforced is a lie told to a model. So both
 * halves are tested: what the validator enforces, and what it admits it cannot.
 */

const rejects = (schema, args, pattern) => {
  assert.throws(
    () => validateArguments("t", args, schema),
    (error) => {
      assert.ok(error instanceof RpcError, `expected RpcError, got ${error}`);
      assert.equal(error.code, INVALID_PARAMS);
      if (pattern) assert.match(error.message, pattern);
      return true;
    },
    `${JSON.stringify(args)} should be rejected`,
  );
};

const accepts = (schema, args) => {
  assert.doesNotThrow(() => validateArguments("t", args, schema), `${JSON.stringify(args)} should pass`);
};

const OBJECT = { type: "object", additionalProperties: false, properties: {} };

// --- assertSupported -------------------------------------------------------

test("assertSupported passes the keywords the tools actually declare", () => {
  assert.doesNotThrow(() =>
    assertSupported(
      {
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: {
          a: { type: "string", minLength: 1, description: "d" },
          b: { type: "integer", minimum: 1, maximum: 500 },
          c: { type: "string", enum: ["x", "y"], default: "x" },
          d: { type: "array", items: { type: "string" } },
        },
      },
      "tool t inputSchema",
    ),
  );
});

test("assertSupported REFUSES a keyword the validator does not enforce", () => {
  // pattern, oneOf, format, $ref ... any of these would appear in tools/list and
  // never be checked.
  for (const keyword of ["pattern", "oneOf", "format", "$ref", "anyOf", "minItems"]) {
    assert.throws(
      () => assertSupported({ type: "string", [keyword]: 1 }, "where"),
      new RegExp(`'${keyword.replace("$", "\\$")}' is not supported`),
      `should refuse ${keyword}`,
    );
  }
});

test("assertSupported recurses into properties and items, naming the path", () => {
  assert.throws(
    () => assertSupported({ type: "object", properties: { a: { type: "string", pattern: "x" } } }, "root"),
    /root\.a: schema keyword 'pattern'/,
  );
  assert.throws(
    () => assertSupported({ type: "array", items: { type: "string", pattern: "x" } }, "root"),
    /root\[\]: schema keyword 'pattern'/,
  );
});

// --- validateArguments -----------------------------------------------------

test("arguments may be omitted entirely and become {}", () => {
  assert.deepEqual(validateArguments("t", undefined, OBJECT), {});
  assert.deepEqual(validateArguments("t", null, OBJECT), {});
});

test("an array is not an object, even though typeof says so", () => {
  rejects(OBJECT, [], /'arguments' must be an object/);
});

test("types are checked, and the message names what arrived", () => {
  const schema = { type: "object", properties: { s: { type: "string" } } };
  rejects(schema, { s: 5 }, /must be a string, got number/);
  rejects(schema, { s: [] }, /got array/);
  accepts(schema, { s: "" });
});

test("integer means integer, not any number", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } } };
  rejects(schema, { n: 1.5 }, /must be an integer/);
  rejects(schema, { n: "1" }, /must be an integer, got string/);
  accepts(schema, { n: 0 });
  accepts(schema, { n: -3 });
});

test("enum is enforced and lists the options", () => {
  const schema = { type: "object", properties: { m: { type: "string", enum: ["approve", "deny"] } } };
  rejects(schema, { m: "maybe" }, /must be one of approve, deny/);
  accepts(schema, { m: "deny" });
});

test("minLength, minimum and maximum are enforced at the boundary", () => {
  const schema = {
    type: "object",
    properties: {
      s: { type: "string", minLength: 1 },
      n: { type: "integer", minimum: 1, maximum: 500 },
    },
  };
  rejects(schema, { s: "" }, /at least 1 character/);
  rejects(schema, { n: 0 }, />= 1/);
  rejects(schema, { n: 501 }, /<= 500/);
  accepts(schema, { s: "a", n: 1 });
  accepts(schema, { s: "a", n: 500 });
});

test("required is enforced, and an explicit null counts as absent", () => {
  // `undefined` cannot survive a JSON round trip, so null is the only way a
  // client can spell "present but empty" — and it means the same thing.
  const schema = { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } };
  rejects(schema, {}, /sessionId is required/);
  rejects(schema, { sessionId: null }, /sessionId is required/);
  accepts(schema, { sessionId: "wrun_1" });
});

test("a null value for an OPTIONAL property is skipped, not type-checked", () => {
  const schema = { type: "object", properties: { turnId: { type: "string" } } };
  accepts(schema, { turnId: null });
});

test("additionalProperties:false rejects an unknown argument and lists the real ones", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { sessionId: { type: "string" }, turnId: { type: "string" } },
  };
  rejects(schema, { sessionid: "x" }, /not a recognized argument \(expected: sessionId, turnId\)/);
  accepts(schema, { turnId: "x" });
});

test("without additionalProperties:false an extra argument is tolerated", () => {
  accepts({ type: "object", properties: { a: { type: "string" } } }, { a: "x", extra: 1 });
});

test("every violation is reported, not just the first", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "string" }, n: { type: "integer" } },
  };
  assert.throws(
    () => validateArguments("t", { n: "no", zz: 1 }, schema),
    (error) => {
      assert.equal(error.data.tool, "t");
      assert.equal(error.data.errors.length, 3, JSON.stringify(error.data.errors));
      return true;
    },
  );
});

test("nested objects and array items are validated with a readable path", () => {
  const schema = {
    type: "object",
    properties: {
      inner: { type: "object", properties: { n: { type: "integer" } } },
      list: { type: "array", items: { type: "string" } },
    },
  };
  rejects(schema, { inner: { n: "x" } }, /arguments\.inner\.n must be an integer/);
  rejects(schema, { list: ["a", 2] }, /arguments\.list\[1\] must be a string/);
  accepts(schema, { inner: { n: 1 }, list: ["a"] });
});

test("the returned value is the arguments object itself, defaulted when absent", () => {
  const args = { sessionId: "x" };
  assert.equal(validateArguments("t", args, { type: "object", properties: {} }), args);
});
