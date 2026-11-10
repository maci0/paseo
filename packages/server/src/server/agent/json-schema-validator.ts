import type {
  JsonSchemaType as McpJsonSchemaType,
  JsonSchemaValidator as McpJsonSchemaValidatorFunction,
  JsonSchemaValidatorResult as McpJsonSchemaValidatorResult,
  jsonSchemaValidator as McpJsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { requireNodeOnly } from "../node-only-require.js";

/**
 * JSON Schema validation with ajv 8 `{ allErrors: true, strict: false }` semantics.
 *
 * Under Node, `createJsonSchemaCompiler` returns ajv itself. A scriptc binary cannot run ajv,
 * which builds validators with `new Function`, so there it returns an interpreter for draft-07
 * that reports the same verdicts and the same `instancePath` and `message` per error.
 * Interpreter differences from ajv are listed in json-schema-validator.test.ts.
 */

/** The fields of an ajv `ErrorObject` that Paseo reads. */
export interface SchemaValidationError {
  instancePath: string;
  message?: string;
}

export interface CompiledJsonSchema {
  /** Returns every error; an empty array means the value is valid. */
  validate(value: unknown): SchemaValidationError[];
}

export interface JsonSchemaCompiler {
  /** Throws when the schema is invalid or a `$ref` cannot be resolved, as `ajv.compile` does. */
  compile(schema: unknown): CompiledJsonSchema;
  /** ajv's `errorsText`: `data<instancePath> <message>` joined by ", ", or "No errors". */
  errorsText(errors: SchemaValidationError[]): string;
}

/** Deepest schema nesting the interpreter follows, in schema levels per value. */
const MAX_SCHEMA_DEPTH = 256;

const DRAFT_07_META_SCHEMA_IDS = new Set([
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
]);

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);

// ajv evaluates typed keywords in groups, one per data type, after the untyped keywords.
const NUMBER_KEYWORDS = [
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "format",
];
const STRING_KEYWORDS = ["maxLength", "minLength", "pattern", "format"];
const ARRAY_KEYWORDS = [
  "maxItems",
  "minItems",
  "additionalItems",
  "items",
  "contains",
  "uniqueItems",
];
const OBJECT_KEYWORDS = [
  "maxProperties",
  "minProperties",
  "required",
  "propertyNames",
  "additionalProperties",
  "dependencies",
  "properties",
  "patternProperties",
];

type JsonObject = Record<string, unknown>;

interface NamedSchema {
  name: string;
  schema: SchemaNode;
}

interface PatternSchema {
  regex: RegExp;
  schema: SchemaNode;
}

interface PropertyDependency {
  name: string;
  required: string[];
}

class SchemaNode {
  /** Set for a boolean schema; every other field is then unused. */
  booleanSchema: boolean | undefined = undefined;
  types: string[] = [];
  typeText = "";
  /** ajv checks `type` before the keywords unless one typed group reports it. */
  typeCheckedFirst = false;
  typeGroup = "";
  ref: SchemaNode | undefined = undefined;
  hasConst = false;
  constValue: unknown = undefined;
  enumValues: unknown[] | undefined = undefined;
  not: SchemaNode | undefined = undefined;
  anyOf: SchemaNode[] | undefined = undefined;
  oneOf: SchemaNode[] | undefined = undefined;
  allOf: SchemaNode[] | undefined = undefined;
  ifSchema: SchemaNode | undefined = undefined;
  thenSchema: SchemaNode | undefined = undefined;
  elseSchema: SchemaNode | undefined = undefined;
  numberGroup = false;
  maximum: number | undefined = undefined;
  minimum: number | undefined = undefined;
  exclusiveMaximum: number | undefined = undefined;
  exclusiveMinimum: number | undefined = undefined;
  multipleOf: number | undefined = undefined;
  stringGroup = false;
  maxLength: number | undefined = undefined;
  minLength: number | undefined = undefined;
  pattern: RegExp | undefined = undefined;
  patternSource = "";
  arrayGroup = false;
  maxItems: number | undefined = undefined;
  minItems: number | undefined = undefined;
  additionalItems: SchemaNode | undefined = undefined;
  items: SchemaNode | undefined = undefined;
  tupleItems: SchemaNode[] | undefined = undefined;
  contains: SchemaNode | undefined = undefined;
  uniqueItems = false;
  uniqueItemTypes: string[] = [];
  objectGroup = false;
  maxProperties: number | undefined = undefined;
  minProperties: number | undefined = undefined;
  required: string[] = [];
  propertyNames: SchemaNode | undefined = undefined;
  additionalProperties: SchemaNode | undefined = undefined;
  definedProperties = new Set<string>();
  propertyDependencies: PropertyDependency[] = [];
  schemaDependencies: NamedSchema[] = [];
  properties: NamedSchema[] = [];
  patternProperties: PatternSchema[] = [];
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

// Array.isArray narrows unknown to any[]; this keeps the elements unknown.
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
}

function invalidSchema(pointer: string, keyword: string, expectation: string): Error {
  return new Error(`schema is invalid: data${pointer}/${keyword} must be ${expectation}`);
}

/** ajv's `getSchemaTypes`, including its `nullable` extension. */
function schemaTypes(schema: JsonObject, pointer: string): string[] {
  const raw = schema.type;
  let listed: unknown[] = [];
  if (Array.isArray(raw)) listed = raw;
  else if (raw) listed = [raw];
  const types: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string" || !JSON_TYPES.has(entry)) {
      throw invalidSchema(pointer, "type", "equal to one of the allowed values");
    }
    types.push(entry);
  }
  const nullable = schema.nullable;
  if (types.includes("null")) {
    if (nullable === false) throw new Error("type: null contradicts nullable: false");
  } else {
    if (types.length === 0 && nullable !== undefined) {
      throw new Error('"nullable" cannot be used without "type"');
    }
    if (nullable === true) types.push("null");
  }
  return types;
}

function hasAnyKeyword(schema: JsonObject, keywords: string[]): boolean {
  return keywords.some((keyword) => schema[keyword] !== undefined);
}

function compilePattern(source: string, pointer: string, keyword: string): RegExp {
  try {
    return new RegExp(source, "u");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `schema is invalid: data${pointer}/${keyword} "${source}" is not a valid regular expression: ${reason}`,
      { cause: error },
    );
  }
}

class Compiler {
  private readonly root: unknown;
  private readonly rootId: string;
  private readonly nodes = new Map<string, SchemaNode>();
  private hasNestedId = false;
  private hasRef = false;

  constructor(root: unknown) {
    this.root = root;
    const rootObject = asObject(root);
    const id = rootObject?.$id;
    this.rootId = typeof id === "string" ? id.replace(/#$/, "") : "";
  }

  compileRoot(): SchemaNode {
    const rootObject = asObject(this.root);
    if (rootObject !== undefined) {
      const metaSchema = rootObject.$schema;
      if (metaSchema !== undefined && typeof metaSchema !== "string") {
        throw new Error("$schema must be a string");
      }
      if (typeof metaSchema === "string" && !DRAFT_07_META_SCHEMA_IDS.has(metaSchema)) {
        throw new Error(`no schema with key or ref "${metaSchema}"`);
      }
    }
    const node = this.compileAt("", this.root, 0);
    if (this.hasNestedId && this.hasRef) {
      throw new Error("$ref is not supported in a schema whose subschemas declare $id");
    }
    return node;
  }

  compileAt(pointer: string, schema: unknown, depth: number): SchemaNode {
    const cached = this.nodes.get(pointer);
    if (cached !== undefined) return cached;
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
    }
    const node = new SchemaNode();
    this.nodes.set(pointer, node);
    if (typeof schema === "boolean") {
      node.booleanSchema = schema;
      return node;
    }
    const object = asObject(schema);
    if (object === undefined) {
      throw new Error(`schema is invalid: data${pointer} must be object,boolean`);
    }
    if (pointer !== "" && typeof object.$id === "string") this.hasNestedId = true;
    const reader = new KeywordReader(this, object, pointer, depth);
    compileTypes(node, reader);
    compileApplicators(node, reader);
    compileScalarKeywords(node, reader);
    compileArrayKeywords(node, reader);
    compileObjectKeywords(node, reader);
    return node;
  }

  /** Resolves `#`, `#/json/pointer`, and the same with the root `$id` in front. */
  resolveRef(ref: string, depth: number): SchemaNode {
    this.hasRef = true;
    let fragment: string | undefined;
    if (ref.startsWith("#")) {
      fragment = ref.slice(1);
    } else if (this.rootId !== "" && (ref === this.rootId || ref.startsWith(`${this.rootId}#`))) {
      fragment = ref.slice(this.rootId.length + 1);
    }
    const missing = new Error(
      `can't resolve reference ${ref} from id ${this.rootId === "" ? "#" : this.rootId}`,
    );
    if (fragment === undefined || (fragment !== "" && !fragment.startsWith("/"))) throw missing;
    const segments = fragment === "" ? [] : fragment.slice(1).split("/");
    let target: unknown = this.root;
    const path: string[] = [];
    for (const raw of segments) {
      const segment = unescapePointerSegment(raw);
      const list = asArray(target);
      if (list !== undefined) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= list.length) throw missing;
        target = list[index];
      } else {
        const object = asObject(target);
        if (object === undefined || !Object.hasOwn(object, segment)) throw missing;
        target = object[segment];
      }
      path.push(escapePointerSegment(segment));
    }
    if (target === undefined) throw missing;
    const pointer = path.length === 0 ? "" : `/${path.join("/")}`;
    return this.compileAt(pointer, target, depth + 1);
  }
}

/** Reads the keyword values of one schema object, checking each value's JSON type. */
class KeywordReader {
  readonly schema: JsonObject;
  readonly pointer: string;
  readonly depth: number;
  readonly compiler: Compiler;

  constructor(compiler: Compiler, schema: JsonObject, pointer: string, depth: number) {
    this.compiler = compiler;
    this.schema = schema;
    this.pointer = pointer;
    this.depth = depth;
  }

  has(keyword: string): boolean {
    return this.schema[keyword] !== undefined;
  }

  invalid(keyword: string, expectation: string): Error {
    return invalidSchema(this.pointer, keyword, expectation);
  }

  number(keyword: string): number | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw this.invalid(keyword, "number");
    return value;
  }

  count(keyword: string): number | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw this.invalid(keyword, "a non-negative integer");
    }
    return value;
  }

  string(keyword: string): string | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw this.invalid(keyword, "string");
    return value;
  }

  map(keyword: string): JsonObject | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    const object = asObject(value);
    if (object === undefined) throw this.invalid(keyword, "object");
    return object;
  }

  subschema(keyword: string): SchemaNode | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    return this.compileChild(`/${escapePointerSegment(keyword)}`, value);
  }

  subschemaList(keyword: string): SchemaNode[] | undefined {
    const value = this.schema[keyword];
    if (value === undefined) return undefined;
    const list = asArray(value);
    if (list === undefined || list.length === 0) throw this.invalid(keyword, "a non-empty array");
    return list.map((entry, index) => this.compileChild(`/${keyword}/${index}`, entry));
  }

  /** The entries of a map of schemas, without "__proto__", which ajv skips. */
  schemaEntries(keyword: string): NamedSchema[] {
    const map = this.map(keyword);
    if (map === undefined) return [];
    return Object.keys(map)
      .filter((name) => name !== "__proto__")
      .map((name) => ({
        name,
        schema: this.compileChild(`/${keyword}/${escapePointerSegment(name)}`, map[name]),
      }));
  }

  compileChild(relativePointer: string, schema: unknown): SchemaNode {
    return this.compiler.compileAt(`${this.pointer}${relativePointer}`, schema, this.depth + 1);
  }
}

function compileTypes(node: SchemaNode, reader: KeywordReader): void {
  const schema = reader.schema;
  node.types = schemaTypes(schema, reader.pointer);
  const rawType = schema.type;
  node.typeText = Array.isArray(rawType) ? rawType.join(",") : String(rawType);
  node.numberGroup = hasAnyKeyword(schema, NUMBER_KEYWORDS);
  node.stringGroup = hasAnyKeyword(schema, STRING_KEYWORDS);
  node.arrayGroup = hasAnyKeyword(schema, ARRAY_KEYWORDS);
  node.objectGroup = hasAnyKeyword(schema, OBJECT_KEYWORDS);
  const onlyType = node.types.length === 1 ? node.types[0] : undefined;
  const groupOfOnlyType =
    (onlyType === "number" && node.numberGroup) ||
    (onlyType === "string" && node.stringGroup) ||
    (onlyType === "array" && node.arrayGroup) ||
    (onlyType === "object" && node.objectGroup);
  node.typeCheckedFirst = node.types.length > 0 && !groupOfOnlyType;
  node.typeGroup = groupOfOnlyType && onlyType !== undefined ? onlyType : "";
}

function compileApplicators(node: SchemaNode, reader: KeywordReader): void {
  const ref = reader.string("$ref");
  if (ref !== undefined) node.ref = reader.compiler.resolveRef(ref, reader.depth);
  if (reader.has("const")) {
    node.hasConst = true;
    node.constValue = reader.schema.const;
  }
  if (reader.has("enum")) {
    const enumValues = asArray(reader.schema.enum);
    if (enumValues === undefined) throw reader.invalid("enum", "array");
    if (enumValues.length === 0) throw new Error("enum must have non-empty array");
    node.enumValues = enumValues;
  }
  node.not = reader.subschema("not");
  node.anyOf = reader.subschemaList("anyOf");
  node.oneOf = reader.subschemaList("oneOf");
  node.allOf = reader.subschemaList("allOf");
  node.ifSchema = reader.subschema("if");
  node.thenSchema = reader.subschema("then");
  node.elseSchema = reader.subschema("else");
}

function compileScalarKeywords(node: SchemaNode, reader: KeywordReader): void {
  node.maximum = reader.number("maximum");
  node.minimum = reader.number("minimum");
  node.exclusiveMaximum = reader.number("exclusiveMaximum");
  node.exclusiveMinimum = reader.number("exclusiveMinimum");
  node.multipleOf = reader.number("multipleOf");
  if (node.multipleOf !== undefined && node.multipleOf <= 0) {
    throw reader.invalid("multipleOf", "> 0");
  }
  node.maxLength = reader.count("maxLength");
  node.minLength = reader.count("minLength");
  const pattern = reader.string("pattern");
  if (pattern !== undefined) {
    node.pattern = compilePattern(pattern, reader.pointer, "pattern");
    node.patternSource = pattern;
  }
  reader.string("format");
}

function compileArrayKeywords(node: SchemaNode, reader: KeywordReader): void {
  node.maxItems = reader.count("maxItems");
  node.minItems = reader.count("minItems");
  const items = reader.schema.items;
  if (asArray(items) !== undefined) {
    node.tupleItems = reader.subschemaList("items");
    node.additionalItems = reader.subschema("additionalItems");
  } else if (items !== undefined) {
    node.items = reader.subschema("items");
    const itemsObject = asObject(items);
    if (itemsObject !== undefined) {
      node.uniqueItemTypes = schemaTypes(itemsObject, `${reader.pointer}/items`);
    }
  }
  node.contains = reader.subschema("contains");
  const uniqueItems = reader.schema.uniqueItems;
  if (uniqueItems !== undefined && typeof uniqueItems !== "boolean") {
    throw reader.invalid("uniqueItems", "boolean");
  }
  node.uniqueItems = uniqueItems === true;
}

function stringList(value: unknown[], reader: KeywordReader, keyword: string): string[] {
  return value.map((entry) => {
    if (typeof entry !== "string") throw reader.invalid(keyword, "an array of strings");
    return entry;
  });
}

function compileDependencies(node: SchemaNode, reader: KeywordReader): void {
  const dependencies = reader.map("dependencies");
  if (dependencies === undefined) return;
  for (const name of Object.keys(dependencies)) {
    if (name === "__proto__") continue;
    const dependency = dependencies[name];
    const list = asArray(dependency);
    if (list === undefined) {
      const relativePointer = `/dependencies/${escapePointerSegment(name)}`;
      node.schemaDependencies.push({
        name,
        schema: reader.compileChild(relativePointer, dependency),
      });
      continue;
    }
    const required = stringList(list, reader, "dependencies");
    if (required.length > 0) node.propertyDependencies.push({ name, required });
  }
}

function compileObjectKeywords(node: SchemaNode, reader: KeywordReader): void {
  node.maxProperties = reader.count("maxProperties");
  node.minProperties = reader.count("minProperties");
  if (reader.has("required")) {
    const required = asArray(reader.schema.required);
    if (required === undefined) throw reader.invalid("required", "array");
    node.required = stringList(required, reader, "required");
  }
  node.propertyNames = reader.subschema("propertyNames");
  node.additionalProperties = reader.subschema("additionalProperties");
  compileDependencies(node, reader);
  node.properties = reader.schemaEntries("properties");
  for (const property of node.properties) node.definedProperties.add(property.name);
  node.patternProperties = reader.schemaEntries("patternProperties").map((entry) => ({
    regex: compilePattern(entry.name, reader.pointer, "patternProperties"),
    schema: entry.schema,
  }));
}

function hasJsonType(type: string, data: unknown): boolean {
  switch (type) {
    case "null":
      return data === null;
    case "array":
      return Array.isArray(data);
    case "object":
      return asObject(data) !== undefined;
    case "integer":
      // ajv's test, which also accepts Infinity.
      return typeof data === "number" && !(data % 1) && !Number.isNaN(data);
    case "number":
      return typeof data === "number";
    default:
      return typeof data === type;
  }
}

/** fast-deep-equal on JSON values, which ajv uses for `const`, `enum` and `uniqueItems`. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftList = asArray(left);
  if (leftList !== undefined) {
    const rightList = asArray(right);
    if (rightList === undefined || leftList.length !== rightList.length) return false;
    for (let index = 0; index < leftList.length; index += 1) {
      if (!jsonEqual(leftList[index], rightList[index])) return false;
    }
    return true;
  }
  const leftObject = asObject(left);
  const rightObject = asObject(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  const keys = Object.keys(leftObject);
  if (keys.length !== Object.keys(rightObject).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(rightObject, key)) return false;
    if (!jsonEqual(leftObject[key], rightObject[key])) return false;
  }
  return true;
}

/** Length in Unicode code points, as ajv's `ucs2length`. */
function codePointLength(text: string): number {
  let length = 0;
  let position = 0;
  while (position < text.length) {
    length += 1;
    const unit = text.charCodeAt(position);
    position += 1;
    if (unit >= 0xd800 && unit <= 0xdbff && position < text.length) {
      if ((text.charCodeAt(position) & 0xfc00) === 0xdc00) position += 1;
    }
  }
  return length;
}

function pushError(errors: SchemaValidationError[], instancePath: string, message: string): void {
  errors.push({ instancePath, message });
}

function validateNode(
  node: SchemaNode,
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  if (node.booleanSchema !== undefined) {
    if (!node.booleanSchema) pushError(errors, path, "boolean schema is false");
    return;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    pushError(errors, path, `must NOT be nested deeper than ${MAX_SCHEMA_DEPTH} schema levels`);
    return;
  }
  if (node.typeCheckedFirst && !node.types.some((type) => hasJsonType(type, data))) {
    pushError(errors, path, `must be ${node.typeText}`);
  }
  validateUntyped(node, data, path, errors, depth);
  if (node.numberGroup) {
    if (typeof data === "number") validateNumber(node, data, path, errors);
    else if (node.typeGroup === "number") pushError(errors, path, `must be ${node.typeText}`);
  }
  if (node.stringGroup) {
    if (typeof data === "string") validateString(node, data, path, errors);
    else if (node.typeGroup === "string") pushError(errors, path, `must be ${node.typeText}`);
  }
  if (node.arrayGroup) {
    const list = asArray(data);
    if (list !== undefined) validateArray(node, list, path, errors, depth);
    else if (node.typeGroup === "array") pushError(errors, path, `must be ${node.typeText}`);
  }
  if (node.objectGroup) {
    const object = asObject(data);
    if (object !== undefined) validateObject(node, object, path, errors, depth);
    else if (node.typeGroup === "object") pushError(errors, path, `must be ${node.typeText}`);
  }
}

/** Runs a subschema and reports whether it added no errors. */
function passes(
  node: SchemaNode,
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): boolean {
  const before = errors.length;
  validateNode(node, data, path, errors, depth + 1);
  return errors.length === before;
}

function validateUntyped(
  node: SchemaNode,
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  if (node.ref !== undefined) validateNode(node.ref, data, path, errors, depth + 1);
  if (node.hasConst && !jsonEqual(data, node.constValue)) {
    pushError(errors, path, "must be equal to constant");
  }
  if (node.enumValues !== undefined && !node.enumValues.some((value) => jsonEqual(data, value))) {
    pushError(errors, path, "must be equal to one of the allowed values");
  }
  if (node.not !== undefined && passes(node.not, data, path, [], depth)) {
    pushError(errors, path, "must NOT be valid");
  }
  if (node.anyOf !== undefined) validateAnyOf(node.anyOf, data, path, errors, depth);
  if (node.oneOf !== undefined) validateOneOf(node.oneOf, data, path, errors, depth);
  if (node.allOf !== undefined) {
    for (const branch of node.allOf) validateNode(branch, data, path, errors, depth + 1);
  }
  if (node.ifSchema !== undefined) validateIf(node, node.ifSchema, data, path, errors, depth);
}

function validateAnyOf(
  branches: SchemaNode[],
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  const start = errors.length;
  if (branches.some((branch) => passes(branch, data, path, errors, depth))) {
    errors.splice(start);
  } else {
    pushError(errors, path, "must match a schema in anyOf");
  }
}

function validateOneOf(
  branches: SchemaNode[],
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  const start = errors.length;
  let passing = 0;
  // ajv stops evaluating branches once a second one passes.
  for (const branch of branches) {
    if (passes(branch, data, path, errors, depth)) passing += 1;
    if (passing > 1) break;
  }
  if (passing === 1) errors.splice(start);
  else pushError(errors, path, "must match exactly one schema in oneOf");
}

function validateIf(
  node: SchemaNode,
  ifSchema: SchemaNode,
  data: unknown,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  if (node.thenSchema === undefined && node.elseSchema === undefined) return;
  const matched = passes(ifSchema, data, path, [], depth);
  const clause = matched ? node.thenSchema : node.elseSchema;
  if (clause !== undefined && !passes(clause, data, path, errors, depth)) {
    pushError(errors, path, `must match "${matched ? "then" : "else"}" schema`);
  }
}

function validateNumber(
  node: SchemaNode,
  data: number,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (node.maximum !== undefined && data > node.maximum) {
    pushError(errors, path, `must be <= ${node.maximum}`);
  }
  if (node.minimum !== undefined && data < node.minimum) {
    pushError(errors, path, `must be >= ${node.minimum}`);
  }
  if (node.exclusiveMaximum !== undefined && data >= node.exclusiveMaximum) {
    pushError(errors, path, `must be < ${node.exclusiveMaximum}`);
  }
  if (node.exclusiveMinimum !== undefined && data <= node.exclusiveMinimum) {
    pushError(errors, path, `must be > ${node.exclusiveMinimum}`);
  }
  if (node.multipleOf !== undefined) {
    // ajv's test without multipleOfPrecision.
    const quotient = data / node.multipleOf;
    if (quotient !== parseInt(String(quotient), 10)) {
      pushError(errors, path, `must be multiple of ${node.multipleOf}`);
    }
  }
}

function validateString(
  node: SchemaNode,
  data: string,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (node.maxLength !== undefined && codePointLength(data) > node.maxLength) {
    pushError(errors, path, `must NOT have more than ${node.maxLength} characters`);
  }
  if (node.minLength !== undefined && codePointLength(data) < node.minLength) {
    pushError(errors, path, `must NOT have fewer than ${node.minLength} characters`);
  }
  if (node.pattern !== undefined && !node.pattern.test(data)) {
    pushError(errors, path, `must match pattern "${node.patternSource}"`);
  }
}

function validateArray(
  node: SchemaNode,
  data: unknown[],
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  if (node.maxItems !== undefined && data.length > node.maxItems) {
    pushError(errors, path, `must NOT have more than ${node.maxItems} items`);
  }
  if (node.minItems !== undefined && data.length < node.minItems) {
    pushError(errors, path, `must NOT have fewer than ${node.minItems} items`);
  }
  const tuple = node.tupleItems;
  if (tuple !== undefined && node.additionalItems !== undefined) {
    if (node.additionalItems.booleanSchema === false) {
      if (data.length > tuple.length) {
        pushError(errors, path, `must NOT have more than ${tuple.length} items`);
      }
    } else {
      for (let index = tuple.length; index < data.length; index += 1) {
        validateNode(node.additionalItems, data[index], `${path}/${index}`, errors, depth + 1);
      }
    }
  }
  if (node.items !== undefined) {
    for (let index = 0; index < data.length; index += 1) {
      validateNode(node.items, data[index], `${path}/${index}`, errors, depth + 1);
    }
  }
  if (tuple !== undefined) {
    const length = Math.min(tuple.length, data.length);
    for (let index = 0; index < length; index += 1) {
      validateNode(tuple[index], data[index], `${path}/${index}`, errors, depth + 1);
    }
  }
  if (node.contains !== undefined) {
    const start = errors.length;
    const contains = node.contains;
    if (data.some((item, index) => passes(contains, item, `${path}/${index}`, errors, depth))) {
      errors.splice(start);
    } else {
      pushError(errors, path, "must contain at least 1 valid item(s)");
    }
  }
  if (node.uniqueItems && data.length > 1) validateUniqueItems(node, data, path, errors);
}

function validateUniqueItems(
  node: SchemaNode,
  data: unknown[],
  path: string,
  errors: SchemaValidationError[],
): void {
  const itemTypes = node.uniqueItemTypes;
  const scalarItems =
    itemTypes.length > 0 && !itemTypes.some((type) => type === "object" || type === "array");
  if (scalarItems) {
    // ajv keys a plain object by each item of the declared types, scanning from the end.
    const indices = new Map<string, number>();
    for (let index = data.length - 1; index >= 0; index -= 1) {
      const item = data[index];
      if (!itemTypes.some((type) => hasJsonType(type, item))) continue;
      const key = itemTypes.length > 1 && typeof item === "string" ? `${item}_` : String(item);
      // Assigning a number to an object's "__proto__" is ignored, so ajv never matches it.
      if (key === "__proto__") continue;
      const seen = indices.get(key);
      if (seen !== undefined) {
        pushError(
          errors,
          path,
          `must NOT have duplicate items (items ## ${seen} and ${index} are identical)`,
        );
        return;
      }
      indices.set(key, index);
    }
    return;
  }
  for (let index = data.length - 1; index > 0; index -= 1) {
    for (let other = index - 1; other >= 0; other -= 1) {
      if (jsonEqual(data[index], data[other])) {
        pushError(
          errors,
          path,
          `must NOT have duplicate items (items ## ${other} and ${index} are identical)`,
        );
        return;
      }
    }
  }
}

function validateObject(
  node: SchemaNode,
  data: JsonObject,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  const keys = Object.keys(data);
  if (node.maxProperties !== undefined && keys.length > node.maxProperties) {
    pushError(errors, path, `must NOT have more than ${node.maxProperties} properties`);
  }
  if (node.minProperties !== undefined && keys.length < node.minProperties) {
    pushError(errors, path, `must NOT have fewer than ${node.minProperties} properties`);
  }
  for (const name of node.required) {
    if (!Object.hasOwn(data, name)) {
      pushError(errors, path, `must have required property '${name}'`);
    }
  }
  const propertyNames = node.propertyNames;
  if (propertyNames !== undefined) {
    for (const key of keys) {
      if (!passes(propertyNames, key, path, errors, depth)) {
        pushError(errors, path, "property name must be valid");
      }
    }
  }
  if (node.additionalProperties !== undefined) {
    validateAdditionalProperties(node, node.additionalProperties, data, path, errors, depth);
  }
  validateDependencies(node, data, path, errors, depth);
  for (const property of node.properties) {
    if (!Object.hasOwn(data, property.name)) continue;
    const propertyPath = `${path}/${escapePointerSegment(property.name)}`;
    validateNode(property.schema, data[property.name], propertyPath, errors, depth + 1);
  }
  for (const entry of node.patternProperties) {
    for (const key of keys) {
      if (!entry.regex.test(key)) continue;
      const propertyPath = `${path}/${escapePointerSegment(key)}`;
      validateNode(entry.schema, data[key], propertyPath, errors, depth + 1);
    }
  }
}

function validateAdditionalProperties(
  node: SchemaNode,
  additional: SchemaNode,
  data: JsonObject,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  if (additional.booleanSchema === true) return;
  for (const key of Object.keys(data)) {
    if (node.definedProperties.has(key)) continue;
    if (node.patternProperties.some((entry) => entry.regex.test(key))) continue;
    if (additional.booleanSchema === false) {
      pushError(errors, path, "must NOT have additional properties");
      continue;
    }
    const propertyPath = `${path}/${escapePointerSegment(key)}`;
    validateNode(additional, data[key], propertyPath, errors, depth + 1);
  }
}

function validateDependencies(
  node: SchemaNode,
  data: JsonObject,
  path: string,
  errors: SchemaValidationError[],
  depth: number,
): void {
  for (const dependency of node.propertyDependencies) {
    if (!Object.hasOwn(data, dependency.name)) continue;
    const noun = dependency.required.length === 1 ? "property" : "properties";
    const message = `must have ${noun} ${dependency.required.join(", ")} when property ${dependency.name} is present`;
    for (const name of dependency.required) {
      if (!Object.hasOwn(data, name)) pushError(errors, path, message);
    }
  }
  for (const dependency of node.schemaDependencies) {
    if (Object.hasOwn(data, dependency.name)) {
      validateNode(dependency.schema, data, path, errors, depth + 1);
    }
  }
}

class InterpretedJsonSchema implements CompiledJsonSchema {
  private readonly root: SchemaNode;

  constructor(root: SchemaNode) {
    this.root = root;
  }

  validate(value: unknown): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    validateNode(this.root, value, "", errors, 0);
    return errors;
  }
}

/** The interpreter alone; `createJsonSchemaCompiler` picks it for native builds. */
export function compileJsonSchema(schema: unknown): CompiledJsonSchema {
  return new InterpretedJsonSchema(new Compiler(schema).compileRoot());
}

/**
 * The MCP SDK's validator interface over the interpreter. Native builds pass it to every MCP
 * server and client, because the SDK's default validator is ajv, which cannot run natively.
 * Error messages use ajv's errorsText format, as the SDK's ajv provider does.
 */
export const interpretingMcpJsonSchemaValidator: McpJsonSchemaValidator = {
  getValidator<T>(schema: McpJsonSchemaType): McpJsonSchemaValidatorFunction<T> {
    const compiled = compileJsonSchema(schema);
    return (input: unknown): McpJsonSchemaValidatorResult<T> => {
      const errors = compiled.validate(input);
      if (errors.length === 0) return { valid: true, data: input as T, errorMessage: undefined };
      return { valid: false, data: undefined, errorMessage: formatJsonSchemaErrors(errors) };
    };
  },
};

export function formatJsonSchemaErrors(errors: SchemaValidationError[]): string {
  if (errors.length === 0) return "No errors";
  return errors.map((error) => `data${error.instancePath} ${error.message ?? ""}`).join(", ");
}

class InterpretingCompiler implements JsonSchemaCompiler {
  compile(schema: unknown): CompiledJsonSchema {
    return compileJsonSchema(schema);
  }

  errorsText(errors: SchemaValidationError[]): string {
    return formatJsonSchemaErrors(errors);
  }
}

interface AjvValidateFunction {
  (value: unknown): boolean;
  errors?: SchemaValidationError[] | null;
}

interface AjvInstance {
  compile(schema: unknown): AjvValidateFunction;
  errorsText(errors?: SchemaValidationError[] | null): string;
}

interface AjvPackage {
  Ajv: new (options: { allErrors: boolean; strict: boolean }) => AjvInstance;
}

class AjvCompiler implements JsonSchemaCompiler {
  private readonly ajv: AjvInstance;

  constructor(ajv: AjvInstance) {
    this.ajv = ajv;
  }

  compile(schema: unknown): CompiledJsonSchema {
    const validate = this.ajv.compile(schema);
    return {
      validate: (value) => (validate(value) ? [] : (validate.errors ?? [])),
    };
  }

  errorsText(errors: SchemaValidationError[]): string {
    return this.ajv.errorsText(errors);
  }
}

// scriptc cannot load ajv, so only Node loads it, through requireNodeOnly. A scriptc binary
// reports process.argv[0] as "scriptc".
function loadAjv(): AjvPackage {
  return requireNodeOnly("ajv") as AjvPackage;
}

const ajvPackage = process.argv[0] === "scriptc" ? undefined : loadAjv();

/** One compiler holds ajv's schema cache, so callers create one per scope as they did with `new Ajv`. */
export function createJsonSchemaCompiler(): JsonSchemaCompiler {
  if (ajvPackage === undefined) return new InterpretingCompiler();
  return new AjvCompiler(new ajvPackage.Ajv({ allErrors: true, strict: false }));
}
