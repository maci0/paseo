import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {
  compileJsonSchema,
  createJsonSchemaCompiler,
  formatJsonSchemaErrors,
  interpretingMcpJsonSchemaValidator,
} from "./json-schema-validator.js";

// Intentional differences from ajv, not covered by the corpus:
// - `required`, `properties` and `dependencies` test own properties. ajv tests
//   `data[name] !== undefined`, so names inherited from Object.prototype ("toString",
//   "constructor") count as present there.
// - Schema errors (invalid keyword values, bad regex) throw with the interpreter's own wording,
//   and keyword values are checked only in the subschemas the root reaches.
// - ajv logs `unknown format "x" ignored` through console.warn; the interpreter is silent.
// - A `$ref` cycle that never descends into the data (`{"$ref": "#"}`) makes ajv throw
//   RangeError; the interpreter reports a depth error instead.
// - `$ref` resolves only `#`, `#/pointer`, and those after the root `$id`; a schema with $ref and
//   a nested `$id` is refused.

interface CorpusCase {
  name: string;
  schema: unknown;
  valid: unknown[];
  invalid: unknown[];
}

const corpus: CorpusCase[] = [
  {
    name: "type",
    schema: { type: "string" },
    valid: ["", "a"],
    invalid: [1, null, true, [], {}],
  },
  {
    name: "type list",
    schema: { type: ["string", "null"] },
    valid: ["a", null],
    invalid: [1, {}, false],
  },
  {
    name: "integer",
    schema: { type: "integer", minimum: 2 },
    valid: [2, 3, 1e3, 2.0],
    invalid: [1.5, 1, "2", null],
  },
  {
    name: "number with string keywords",
    schema: { type: "number", minLength: 3 },
    valid: [1],
    invalid: ["abcd", null],
  },
  {
    name: "string group reports type",
    schema: { type: "string", minLength: 2, enum: ["ab", "cd", 3] },
    valid: ["ab"],
    invalid: [3, "a", "xyz", 4],
  },
  {
    name: "nullable",
    schema: { type: "string", nullable: true, maxLength: 1 },
    valid: [null, "a"],
    invalid: [1, "ab"],
  },
  {
    name: "enum and const",
    schema: { enum: [1, "a", null, { b: [1, 2] }, [3]], const: { b: [1, 2] } },
    valid: [{ b: [1, 2] }],
    invalid: [1, "a", { b: [2, 1] }, [3], { b: [1, 2], c: 1 }, 2],
  },
  {
    name: "const scalars",
    schema: { properties: { a: { const: 0 }, b: { const: false }, c: { const: null } } },
    valid: [{ a: 0, b: false, c: null }, {}],
    invalid: [{ a: false, b: 0, c: 0 }, { c: "null" }],
  },
  {
    name: "properties required additionalProperties",
    schema: {
      type: "object",
      properties: { a: { type: "string" }, b: {}, "x/y~z": { type: "number" } },
      required: ["a", "b", "x/y~z"],
      additionalProperties: false,
    },
    valid: [{ a: "s", b: 1, "x/y~z": 2 }],
    invalid: [{}, { a: 1, b: 1, "x/y~z": "q", c: 2, d: 3 }, [], "s"],
  },
  {
    name: "additionalProperties schema with patternProperties",
    schema: {
      properties: { id: { type: "integer" } },
      patternProperties: { "^x-": { type: "string" }, "^x-n": { maxLength: 2 } },
      additionalProperties: { type: "boolean" },
    },
    valid: [{ id: 1, "x-a": "s", other: true }, { "x-n": "ab" }],
    invalid: [{ id: "1", "x-a": 2, other: 3 }, { "x-nn": "abc" }, { "x-n": 5, y: null }],
  },
  {
    name: "propertyNames",
    schema: { propertyNames: { maxLength: 3, pattern: "^[a-z]+$" } },
    valid: [{ abc: 1 }, {}, "not an object"],
    invalid: [{ abcd: 1, AB: 2, ok: 3 }],
  },
  {
    name: "propertyNames false",
    schema: { propertyNames: false },
    valid: [{}],
    invalid: [{ a: 1 }],
  },
  {
    name: "min and max properties",
    schema: { minProperties: 1, maxProperties: 2 },
    valid: [{ a: 1 }, { a: 1, b: 2 }, []],
    invalid: [{}, { a: 1, b: 2, c: 3 }],
  },
  {
    name: "items schema",
    schema: { type: "array", items: { type: "integer", minimum: 0 } },
    valid: [[], [0, 1, 2]],
    invalid: [[-1, 1.5, "a"], {}],
  },
  {
    name: "items tuple with additionalItems false",
    schema: { items: [{ type: "string" }, { type: "number" }], additionalItems: false },
    valid: [[], ["a"], ["a", 1]],
    invalid: [
      [1, "a"],
      ["a", 1, 2, 3],
    ],
  },
  {
    name: "items tuple with additionalItems schema",
    schema: { items: [{ const: 1 }], additionalItems: { type: "string" } },
    valid: [[1, "a", "b"]],
    invalid: [[2, 3, "a", null]],
  },
  {
    name: "additionalItems without tuple is ignored",
    schema: { items: { type: "number" }, additionalItems: false },
    valid: [[1, 2, 3]],
    invalid: [["a"]],
  },
  {
    name: "contains",
    schema: { contains: { type: "integer", minimum: 5 } },
    valid: [[1, 6], [5], "x"],
    invalid: [[], [1, 2, "a"]],
  },
  {
    name: "contains always valid",
    schema: { contains: {} },
    valid: [[null]],
    invalid: [[]],
  },
  {
    name: "min and max items",
    schema: { minItems: 2, maxItems: 3 },
    valid: [[1, 2], [1, 2, 3], {}],
    invalid: [[1], [1, 2, 3, 4]],
  },
  {
    name: "uniqueItems deep",
    schema: { uniqueItems: true },
    valid: [[1, "1", { a: 1 }, { a: 2 }, [1], [2]]],
    invalid: [
      [1, 2, 1],
      [
        { a: 1, b: [2] },
        { b: [2], a: 1 },
      ],
      [[1, 2], 3, [1, 2]],
    ],
  },
  {
    name: "uniqueItems scalar items",
    schema: { uniqueItems: true, items: { type: "integer" } },
    valid: [[1, 2, 3]],
    invalid: [
      [1, 2, 1],
      [1.5, 1.5],
      [3, 1, 2, 1, 3],
    ],
  },
  {
    name: "uniqueItems mixed scalar types",
    schema: { uniqueItems: true, items: { type: ["string", "number", "null"] } },
    valid: [["1", 1, null, "null"]],
    invalid: [
      ["a", 1, "a"],
      [null, 2, null],
    ],
  },
  {
    name: "uniqueItems false",
    schema: { uniqueItems: false },
    valid: [[1, 1]],
    invalid: [],
  },
  {
    name: "string lengths and pattern",
    schema: { type: "string", minLength: 2, maxLength: 4, pattern: '^[a-z"]+$' },
    valid: ["ab", "abcd", 'a"'],
    invalid: ["a", "abcde", "AB", "ABCDEFG"],
  },
  {
    name: "length counts code points",
    schema: { maxLength: 2, minLength: 2 },
    valid: ["\u{1F600}\u{1F600}", "ab"],
    invalid: ["\u{1F600}", "\u{1F600}ab"],
  },
  {
    name: "unicode pattern",
    schema: { pattern: "^\\p{L}+$" },
    valid: ["héllo"],
    invalid: ["a1"],
  },
  {
    name: "number limits",
    schema: { minimum: 1, maximum: 10, exclusiveMinimum: 1, exclusiveMaximum: 10 },
    valid: [5, 9.99, "x"],
    invalid: [1, 10, 0, 11],
  },
  {
    name: "multipleOf",
    schema: { multipleOf: 0.1 },
    valid: [0.5, 1, 0],
    invalid: [0.3, 0.35, 1e-7],
  },
  {
    name: "multipleOf integer",
    schema: { multipleOf: 3 },
    valid: [9, -3, 0],
    invalid: [10, 1.5],
  },
  {
    name: "dependencies",
    schema: {
      dependencies: {
        a: ["b"],
        c: ["d", "e"],
        f: { required: ["g"], properties: { f: { type: "string" } } },
        empty: [],
      },
    },
    valid: [{}, { a: 1, b: 2 }, { c: 1, d: 1, e: 1 }, { f: "x", g: 1 }, { empty: 1 }, 7],
    invalid: [{ a: 1 }, { c: 1 }, { c: 1, d: 1 }, { f: 1 }],
  },
  {
    name: "allOf",
    schema: { allOf: [{ type: "object" }, { required: ["a"] }, { maxProperties: 1 }] },
    valid: [{ a: 1 }],
    invalid: [{ b: 1, c: 2 }, 1],
  },
  {
    name: "anyOf",
    schema: {
      anyOf: [
        { type: "string", maxLength: 2 },
        { type: "number", minimum: 3 },
      ],
    },
    valid: ["ab", 4],
    invalid: ["abc", 2, null],
  },
  {
    name: "oneOf",
    schema: { oneOf: [{ type: "integer" }, { minimum: 2 }, { type: "string" }] },
    valid: [1, 2.5, null],
    invalid: [3, "a"],
  },
  {
    name: "oneOf stops after the second pass",
    schema: { oneOf: [{ minimum: 0 }, { maximum: 10 }, { type: "string" }, { const: 1 }] },
    valid: [-5, 11],
    invalid: [5, 1],
  },
  {
    name: "not",
    schema: { not: { type: "string" } },
    valid: [1, null],
    invalid: ["a"],
  },
  {
    name: "not always valid",
    schema: { not: {} },
    valid: [],
    invalid: [1, "a"],
  },
  {
    name: "if then else",
    // Parsed from text: lint refuses an object literal with a "then" key.
    schema: JSON.parse(
      '{"if": {"properties": {"kind": {"const": "a"}}, "required": ["kind"]}, "then": {"required": ["a"]}, "else": {"required": ["b"]}}',
    ),
    valid: [{ kind: "a", a: 1 }, { b: 1 }],
    invalid: [{ kind: "a" }, { kind: "b" }, {}],
  },
  {
    name: "if then",
    schema: JSON.parse('{"if": {"minimum": 10}, "then": {"multipleOf": 2}}'),
    valid: [12, 3, 5],
    invalid: [11],
  },
  {
    name: "if else",
    schema: { if: { type: "string" }, else: { type: "number" } },
    valid: ["s", 1],
    invalid: [null],
  },
  {
    name: "if without clauses is ignored",
    schema: { if: false },
    valid: [1],
    invalid: [],
  },
  {
    name: "definitions ref",
    schema: {
      type: "object",
      properties: { a: { $ref: "#/definitions/positive" }, b: { $ref: "#/definitions/list" } },
      definitions: {
        positive: { type: "number", exclusiveMinimum: 0 },
        list: { type: "array", items: { $ref: "#/definitions/positive" } },
      },
    },
    valid: [{ a: 1, b: [1, 2] }],
    invalid: [{ a: 0, b: [1, -1, "x"] }],
  },
  {
    name: "recursive ref to root",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } },
      required: ["name"],
      additionalProperties: false,
    },
    valid: [{ name: "a", children: [{ name: "b", children: [{ name: "c" }] }] }],
    invalid: [{ name: "a", children: [{ children: [{ name: 1, extra: true }] }] }],
  },
  {
    name: "ref with siblings and escaped pointer",
    schema: {
      definitions: { "a/b": { minimum: 3 }, "c~d": { maximum: 5 }, "e f": { type: "integer" } },
      allOf: [{ $ref: "#/definitions/a~1b" }, { $ref: "#/definitions/c~0d" }],
      $ref: "#/definitions/e%20f",
      minimum: 4,
    },
    valid: [4, 5],
    invalid: [3, 6, 4.5],
  },
  {
    name: "ref with root $id",
    schema: {
      $id: "http://example.com/root.json",
      definitions: { s: { type: "string" } },
      properties: { a: { $ref: "http://example.com/root.json#/definitions/s" } },
    },
    valid: [{ a: "x" }],
    invalid: [{ a: 1 }],
  },
  {
    name: "boolean schemas",
    schema: { properties: { yes: true, no: false }, items: false },
    valid: [{ yes: 1 }, []],
    invalid: [{ no: 1 }, [1, 2]],
  },
  {
    name: "format is annotation only",
    schema: { type: "string", format: "email" },
    valid: ["not an email"],
    invalid: [1],
  },
  {
    name: "unknown keywords are ignored",
    schema: { type: "object", foo: 1, title: "t", description: "d", examples: [1] },
    valid: [{}],
    invalid: [1],
  },
  {
    name: "draft-07 $schema",
    schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "boolean" },
    valid: [true],
    invalid: ["true"],
  },
  {
    name: "zod style object",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        kind: { type: "string", enum: ["bug", "feature"] },
        score: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
      required: ["title", "tags", "kind", "score"],
      additionalProperties: false,
      title: "Response",
    },
    valid: [{ title: "t", tags: [], kind: "bug", score: null }],
    invalid: [
      { title: "", tags: ["a", 1, "c"], kind: "other", score: "1", extra: 1 },
      { tags: "a" },
    ],
  },
];

function ajvErrors(schema: unknown, value: unknown): string[] | null {
  const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
  const validate = ajv.compile(schema as object);
  if (validate(value)) return null;
  return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

function interpreterErrors(schema: unknown, value: unknown): string[] | null {
  const errors = compileJsonSchema(schema).validate(value);
  if (errors.length === 0) return null;
  return errors.map((error) => `${error.instancePath} ${error.message}`);
}

describe("compileJsonSchema matches ajv", () => {
  for (const entry of corpus) {
    it(entry.name, () => {
      for (const value of entry.valid) {
        expect(ajvErrors(entry.schema, value), JSON.stringify(value)).toBeNull();
        expect(interpreterErrors(entry.schema, value), JSON.stringify(value)).toBeNull();
      }
      for (const value of entry.invalid) {
        const expected = ajvErrors(entry.schema, value);
        expect(expected, JSON.stringify(value)).not.toBeNull();
        expect(interpreterErrors(entry.schema, value), JSON.stringify(value)).toEqual(expected);
      }
    });
  }
});

describe("compileJsonSchema", () => {
  it("formats errors as ajv's errorsText", () => {
    const schema = { required: ["a"], properties: { b: { type: "string" } } };
    const value = { b: 1 };
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    validate(value);
    const errors = compileJsonSchema(schema).validate(value);
    expect(formatJsonSchemaErrors(errors)).toBe(ajv.errorsText(validate.errors));
    expect(formatJsonSchemaErrors([])).toBe(ajv.errorsText([]));
  });

  it("throws ajv's message for an unresolvable $ref", () => {
    expect(() => compileJsonSchema({ $ref: "#/definitions/missing" })).toThrow(
      "can't resolve reference #/definitions/missing from id #",
    );
  });

  it("throws ajv's message for another meta-schema", () => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema" };
    expect(() => compileJsonSchema(schema)).toThrow(
      'no schema with key or ref "https://json-schema.org/draft/2020-12/schema"',
    );
  });

  it("throws a schema error for an invalid regular expression", () => {
    expect(() => compileJsonSchema({ properties: { a: { pattern: "(" } } })).toThrow(
      /^schema is invalid: data\/properties\/a\/pattern "\(" is not a valid regular expression/,
    );
    expect(() => compileJsonSchema({ patternProperties: { "[": {} } })).toThrow(
      /^schema is invalid: data\/patternProperties "\[" is not a valid regular expression/,
    );
  });

  it("throws a schema error for an invalid keyword value", () => {
    expect(() => compileJsonSchema({ minLength: "3" })).toThrow(
      "schema is invalid: data/minLength must be a non-negative integer",
    );
    expect(() => compileJsonSchema({ type: "strin" })).toThrow(
      "schema is invalid: data/type must be equal to one of the allowed values",
    );
    expect(() => compileJsonSchema({ enum: [] })).toThrow("enum must have non-empty array");
  });

  it("refuses $ref in a schema with a nested $id", () => {
    const schema = { properties: { a: { $id: "a.json", $ref: "#" } } };
    expect(() => compileJsonSchema(schema)).toThrow(
      "$ref is not supported in a schema whose subschemas declare $id",
    );
  });

  it("reports a depth error for a $ref cycle that never consumes data", () => {
    const errors = compileJsonSchema({ $ref: "#" }).validate({});
    expect(errors).toEqual([
      { instancePath: "", message: "must NOT be nested deeper than 256 schema levels" },
    ]);
  });

  it("reports a depth error for data nested past the limit", () => {
    let value: unknown = 1;
    for (let level = 0; level < 300; level += 1) value = [value];
    const errors = compileJsonSchema({ items: { $ref: "#" } }).validate(value);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("must NOT be nested deeper than 256 schema levels");
    expect(errors[0]?.instancePath.split("/")).toHaveLength(130);
  });
});

describe("createJsonSchemaCompiler", () => {
  it("uses ajv under Node", () => {
    const compiler = createJsonSchemaCompiler();
    const errors = compiler.compile({ type: "string" }).validate(1);
    // schemaPath exists only on ajv's error objects.
    expect(errors).toEqual([expect.objectContaining({ schemaPath: "#/type" })]);
    expect(compiler.errorsText(errors)).toBe("data must be string");
  });
});

describe("interpretingMcpJsonSchemaValidator", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string", minLength: 1 }, count: { type: "integer" } },
    required: ["name"],
    additionalProperties: false,
  };
  const inputs: unknown[] = [
    { name: "a", count: 2 },
    { name: "" },
    { count: 1.5 },
    { name: "a", extra: true },
    "not an object",
  ];

  it("gives the MCP SDK's ajv validator results for the same schema and inputs", () => {
    const expected = new AjvJsonSchemaValidator().getValidator(schema);
    const actual = interpretingMcpJsonSchemaValidator.getValidator(schema);
    for (const input of inputs) {
      expect(actual(input)).toEqual(expected(input));
    }
  });
});
