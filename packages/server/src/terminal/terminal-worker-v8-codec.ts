// The subset of the V8 structured-clone wire format that `v8.serialize` (Node's
// DefaultSerializer) writes for terminal worker frames, implemented without `node:v8`, which a
// scriptc binary does not have. One code path under both runtimes keeps native and Node peers on
// the frozen frame format (docs/terminal-worker.md).
//
// Supported: undefined, null, booleans, numbers, strings, plain objects, arrays without holes,
// Map, Set, Buffer and the typed arrays Int8 through Float64 (Node's host-object encoding), and
// repeated or cyclic references to them. Decoding rejects every other tag, arrays with holes and
// named properties on arrays. Encoding always writes the dense array form, holes as undefined,
// ignores named properties on arrays and rejects values V8 encodes specially (Date,
// RegExp, Error, ArrayBuffer, DataView, BigInt) or refuses (functions, symbols, promises).
//
// V8 picks one-byte or two-byte strings and Smi or double numbers by internal representation,
// not by content, so equal values can serialize to different bytes. This encoder writes a string
// as one-byte when every code unit is at most 0xFF and a number as Smi when it is an int32 other
// than -0; the decoder reads every form.

/** Format version written in the header; versions 13 to 15 encode this subset identically. */
const WIRE_FORMAT_VERSION = 15;
const MIN_READABLE_VERSION = 13;
const MAX_NESTING_DEPTH = 256;
const INITIAL_WRITE_CAPACITY = 256;
const MAX_UINT32 = 0xffffffff;
const MAX_ARRAY_INDEX = MAX_UINT32 - 1;
const MAX_INT32 = 0x7fffffff;
const MIN_INT32 = -0x80000000;
const MAX_ONE_BYTE_CODE_UNIT = 0xff;
const MAX_VARINT32_BYTES = 5;
const DOUBLE_BYTES = 8;

const Tag = {
  version: 0xff,
  padding: 0x00,
  undefined: 0x5f, // _
  null: 0x30, // 0
  true: 0x54, // T
  false: 0x46, // F
  int32: 0x49, // I
  double: 0x4e, // N
  oneByteString: 0x22, // "
  twoByteString: 0x63, // c
  utf8String: 0x53, // S
  objectReference: 0x5e, // ^
  beginObject: 0x6f, // o
  endObject: 0x7b, // {
  beginDenseArray: 0x41, // A
  endDenseArray: 0x24, // $
  beginSparseArray: 0x61, // a
  endSparseArray: 0x40, // @
  beginMap: 0x3b, // ;
  endMap: 0x3a, // :
  beginSet: 0x27, // '
  endSet: 0x2c, // ,
  hostObject: 0x5c, // \
} as const;

// Node's index for each ArrayBufferView constructor in its host-object encoding
// (lib/v8.js arrayBufferViewTypeToIndex). 9 is DataView, 11 and up are BigInt64Array,
// BigUint64Array and Float16Array, all outside this subset.
const HostView = {
  int8: 0,
  uint8: 1,
  uint8Clamped: 2,
  int16: 3,
  uint16: 4,
  int32: 5,
  uint32: 6,
  float32: 7,
  float64: 8,
  buffer: 10,
} as const;

type SupportedView =
  | Buffer
  | Uint8Array
  | Int8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export class V8CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V8CodecError";
  }
}

function hexTag(tag: number): string {
  return `0x${tag.toString(16).padStart(2, "0")}`;
}

function isInt32(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_INT32 &&
    value <= MAX_INT32 &&
    !(value === 0 && 1 / value < 0)
  );
}

/** V8 writes array-index keys ("0" to "4294967294" in canonical form) as numbers. */
function arrayIndexKey(key: string): number | null {
  if (key.length === 0 || key.length > 10) return null;
  if (key.length > 1 && key.charCodeAt(0) === 0x30) return null;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return null;
  }
  const index = Number(key);
  return index <= MAX_ARRAY_INDEX ? index : null;
}

function varintLength(value: number): number {
  let bytes = 1;
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) bytes++;
  return bytes;
}

function isOneByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > MAX_ONE_BYTE_CODE_UNIT) return false;
  }
  return true;
}

function hostViewIndex(view: ArrayBufferView): number {
  if (Buffer.isBuffer(view)) return HostView.buffer;
  if (view instanceof Uint8Array) return HostView.uint8;
  if (view instanceof Int8Array) return HostView.int8;
  if (view instanceof Uint8ClampedArray) return HostView.uint8Clamped;
  if (view instanceof Int16Array) return HostView.int16;
  if (view instanceof Uint16Array) return HostView.uint16;
  if (view instanceof Int32Array) return HostView.int32;
  if (view instanceof Uint32Array) return HostView.uint32;
  if (view instanceof Float32Array) return HostView.float32;
  if (view instanceof Float64Array) return HostView.float64;
  throw new V8CodecError("Cannot serialize this ArrayBufferView type");
}

class Writer {
  private bytes: Buffer = Buffer.alloc(INITIAL_WRITE_CAPACITY);
  private length = 0;
  private readonly ids = new Map<object, number>();

  finish(): Buffer {
    return this.bytes.subarray(0, this.length);
  }

  private reserve(count: number): void {
    const needed = this.length + count;
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = Buffer.alloc(capacity);
    this.bytes.copy(grown, 0, 0, this.length);
    this.bytes = grown;
  }

  writeByte(byte: number): void {
    this.reserve(1);
    this.bytes[this.length++] = byte;
  }

  writeVarint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.writeByte((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.writeByte(rest);
  }

  writeDouble(value: number): void {
    this.reserve(DOUBLE_BYTES);
    this.bytes.writeDoubleLE(value, this.length);
    this.length += DOUBLE_BYTES;
  }

  writeRaw(source: Uint8Array): void {
    this.reserve(source.length);
    this.bytes.set(source, this.length);
    this.length += source.length;
  }

  writeNumber(value: number): void {
    if (isInt32(value)) {
      this.writeByte(Tag.int32);
      // ZigZag: 0, -1, 1, -2 ... map to 0, 1, 2, 3 ...
      this.writeVarint(((value << 1) ^ (value >> 31)) >>> 0);
      return;
    }
    this.writeByte(Tag.double);
    this.writeDouble(value);
  }

  writeString(value: string): void {
    if (isOneByte(value)) {
      this.writeByte(Tag.oneByteString);
      this.writeVarint(value.length);
      this.reserve(value.length);
      this.length += this.bytes.write(value, this.length, "latin1");
      return;
    }
    const byteLength = value.length * 2;
    // V8 aligns two-byte string data to an even offset with a padding tag before the string.
    if ((this.length + 1 + varintLength(byteLength)) % 2 === 1) this.writeByte(Tag.padding);
    this.writeByte(Tag.twoByteString);
    this.writeVarint(byteLength);
    this.reserve(byteLength);
    for (let i = 0; i < value.length; i++) {
      this.bytes.writeUInt16LE(value.charCodeAt(i), this.length);
      this.length += 2;
    }
  }

  writeValue(value: unknown, depth: number): void {
    if (value === undefined) return this.writeByte(Tag.undefined);
    if (value === null) return this.writeByte(Tag.null);
    if (value === true) return this.writeByte(Tag.true);
    if (value === false) return this.writeByte(Tag.false);
    if (typeof value === "number") return this.writeNumber(value);
    if (typeof value === "string") return this.writeString(value);
    if (typeof value !== "object") {
      throw new V8CodecError(`Cannot serialize a value of type ${typeof value}`);
    }
    this.writeReceiver(value, depth);
  }

  private writeReceiver(value: object, depth: number): void {
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error ||
      value instanceof ArrayBuffer ||
      value instanceof DataView ||
      value instanceof Promise
    ) {
      throw new V8CodecError("Cannot serialize this object type");
    }
    const id = this.ids.get(value);
    if (id !== undefined) {
      this.writeByte(Tag.objectReference);
      this.writeVarint(id);
      return;
    }
    if (depth >= MAX_NESTING_DEPTH) {
      throw new V8CodecError(`Cannot serialize values nested deeper than ${MAX_NESTING_DEPTH}`);
    }
    this.ids.set(value, this.ids.size);
    if (ArrayBuffer.isView(value)) return this.writeHostView(value);
    if (Array.isArray(value)) return this.writeArray(value as unknown[], depth + 1);
    if (value instanceof Map) return this.writeMap(value as Map<unknown, unknown>, depth + 1);
    if (value instanceof Set) return this.writeSet(value as Set<unknown>, depth + 1);
    this.writeObject(value as Record<string, unknown>, depth + 1);
  }

  private writeHostView(view: ArrayBufferView): void {
    this.writeByte(Tag.hostObject);
    this.writeVarint(hostViewIndex(view));
    this.writeVarint(view.byteLength);
    this.writeRaw(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }

  private writeArray(value: unknown[], depth: number): void {
    this.writeByte(Tag.beginDenseArray);
    this.writeVarint(value.length);
    for (let i = 0; i < value.length; i++) this.writeValue(value[i], depth);
    this.writeByte(Tag.endDenseArray);
    this.writeVarint(0);
    this.writeVarint(value.length);
  }

  private writeMap(value: Map<unknown, unknown>, depth: number): void {
    this.writeByte(Tag.beginMap);
    for (const [key, entry] of value) {
      this.writeValue(key, depth);
      this.writeValue(entry, depth);
    }
    this.writeByte(Tag.endMap);
    this.writeVarint(value.size * 2);
  }

  private writeSet(value: Set<unknown>, depth: number): void {
    this.writeByte(Tag.beginSet);
    for (const entry of value) this.writeValue(entry, depth);
    this.writeByte(Tag.endSet);
    this.writeVarint(value.size);
  }

  private writeObject(value: Record<string, unknown>, depth: number): void {
    this.writeByte(Tag.beginObject);
    const keys = Object.keys(value);
    for (const key of keys) {
      if (key === "__proto__") throw new V8CodecError('Cannot serialize a "__proto__" key');
      const index = arrayIndexKey(key);
      if (index === null) this.writeString(key);
      else this.writeNumber(index);
      this.writeValue(value[key], depth);
    }
    this.writeByte(Tag.endObject);
    this.writeVarint(keys.length);
  }
}

/** Serializes `value` to the bytes `v8.serialize` writes for it, within the supported subset. */
export function serializeV8(value: unknown): Buffer {
  const writer = new Writer();
  writer.writeByte(Tag.version);
  writer.writeVarint(WIRE_FORMAT_VERSION);
  writer.writeValue(value, 0);
  return writer.finish();
}

class Reader {
  private position = 0;
  // Every object, array, Map, Set and host view gets the next id when its tag is read.
  private readonly objects: unknown[] = [];

  private readonly bytes: Buffer;

  // No parameter property: the terminal worker runs this file under Node's type stripping.
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }

  atEnd(): boolean {
    return this.position === this.bytes.length;
  }

  // A value-returning path ends in `throw this.codecError(...)`, never `return this.fail(...)`:
  // the native CLI compiles this module from its dist JS, where `fail` has no `never` type, and
  // a release build of a return that holds it stops with an internal SC3004 (scriptc#3584).
  private codecError(message: string): V8CodecError {
    return new V8CodecError(`Invalid V8 serialized data at byte ${this.position}: ${message}`);
  }

  private fail(message: string): never {
    throw this.codecError(message);
  }

  private remaining(): number {
    return this.bytes.length - this.position;
  }

  readByte(): number {
    if (this.position >= this.bytes.length) this.fail("unexpected end of data");
    return this.bytes[this.position++]!;
  }

  /** The next tag, skipping V8's alignment padding, without consuming it. */
  private peekTag(): number {
    while (this.position < this.bytes.length && this.bytes[this.position] === Tag.padding) {
      this.position++;
    }
    if (this.position >= this.bytes.length) this.fail("unexpected end of data");
    return this.bytes[this.position]!;
  }

  readVarint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < MAX_VARINT32_BYTES; i++) {
      const byte = this.readByte();
      result += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (result > MAX_UINT32) this.fail("varint exceeds 32 bits");
        return result;
      }
      scale *= 0x80;
    }
    throw this.codecError("varint exceeds 32 bits");
  }

  /** A length that must fit in the bytes left, checked before anything is allocated for it. */
  private readLength(unitBytes: number): number {
    const length = this.readVarint();
    if (length * unitBytes > this.remaining()) {
      this.fail(`length ${length} exceeds the ${this.remaining()} bytes left`);
    }
    return length;
  }

  private readRaw(byteLength: number): Buffer {
    const start = this.position;
    this.position += byteLength;
    return this.bytes.subarray(start, this.position);
  }

  readHeader(): void {
    if (this.readByte() !== Tag.version) this.fail("missing version header");
    const version = this.readVarint();
    if (version < MIN_READABLE_VERSION || version > WIRE_FORMAT_VERSION) {
      this.fail(`unsupported format version ${version}`);
    }
  }

  readValue(depth: number): unknown {
    if (depth > MAX_NESTING_DEPTH) this.fail(`values nested deeper than ${MAX_NESTING_DEPTH}`);
    this.peekTag();
    const tag = this.readByte();
    switch (tag) {
      case Tag.objectReference: {
        const id = this.readVarint();
        if (id >= this.objects.length) this.fail(`reference to unknown object ${id}`);
        return this.objects[id];
      }
      case Tag.beginObject:
        return this.readObject(depth + 1);
      case Tag.beginDenseArray:
        return this.readArray(depth + 1);
      case Tag.beginSparseArray:
        return this.readSparseArray(depth + 1);
      case Tag.beginMap:
        return this.readMap(depth + 1);
      case Tag.beginSet:
        return this.readSet(depth + 1);
      case Tag.hostObject:
        return this.readHostView();
      default:
        return this.readPrimitive(tag);
    }
  }

  private readPrimitive(tag: number): unknown {
    switch (tag) {
      case Tag.undefined:
        return undefined;
      case Tag.null:
        return null;
      case Tag.true:
        return true;
      case Tag.false:
        return false;
      case Tag.int32: {
        const zigzag = this.readVarint();
        return zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
      }
      case Tag.double: {
        if (this.remaining() < DOUBLE_BYTES) this.fail("unexpected end of data");
        const value = this.bytes.readDoubleLE(this.position);
        this.position += DOUBLE_BYTES;
        return value;
      }
      case Tag.oneByteString:
        return this.readRaw(this.readLength(1)).toString("latin1");
      case Tag.twoByteString:
        return this.readTwoByteString();
      case Tag.utf8String:
        return this.readRaw(this.readLength(1)).toString("utf8");
      default:
        throw this.codecError(`unsupported tag ${hexTag(tag)}`);
    }
  }

  private readTwoByteString(): string {
    const byteLength = this.readLength(1);
    if (byteLength % 2 !== 0) this.fail("odd two-byte string length");
    const data = this.readRaw(byteLength);
    let result = "";
    // Chunked so the argument list stays small; code units are copied as-is, lone surrogates
    // included.
    const chunkUnits = 4096;
    for (let unit = 0; unit < byteLength / 2; unit += chunkUnits) {
      const end = Math.min(unit + chunkUnits, byteLength / 2);
      const codes: number[] = [];
      for (let i = unit; i < end; i++) codes.push(data.readUInt16LE(i * 2));
      result += String.fromCharCode(...codes);
    }
    return result;
  }

  private register(value: unknown): void {
    this.objects.push(value);
  }

  private readKey(depth: number): string {
    const key = this.readValue(depth);
    if (typeof key === "number") return String(key);
    if (typeof key !== "string") this.fail("object key is not a string or number");
    if (key === "__proto__") this.fail('unsupported "__proto__" key');
    return key;
  }

  private readObject(depth: number): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    this.register(object);
    let count = 0;
    while (this.peekTag() !== Tag.endObject) {
      const key = this.readKey(depth);
      object[key] = this.readValue(depth);
      count++;
    }
    this.readByte();
    if (this.readVarint() !== count) this.fail("property count mismatch");
    return object;
  }

  private readArray(depth: number): unknown[] {
    const length = this.readLength(1);
    const array: unknown[] = [];
    this.register(array);
    for (let i = 0; i < length; i++) array.push(this.readValue(depth));
    if (this.peekTag() !== Tag.endDenseArray) this.fail("named properties on arrays");
    this.readByte();
    if (this.readVarint() !== 0) this.fail("property count mismatch");
    if (this.readVarint() !== length) this.fail("array length mismatch");
    return array;
  }

  /**
   * V8 writes holey arrays (`new Array(n)` filled in afterwards) as index/value pairs. Only
   * arrays whose every index is present, in order, are in the subset: a real hole is rejected.
   */
  private readSparseArray(depth: number): unknown[] {
    const length = this.readVarint();
    const array: unknown[] = [];
    this.register(array);
    while (this.peekTag() !== Tag.endSparseArray) {
      if (this.readValue(depth) !== array.length) this.fail("array with holes or named properties");
      array.push(this.readValue(depth));
    }
    this.readByte();
    if (this.readVarint() !== array.length) this.fail("property count mismatch");
    if (this.readVarint() !== length || length !== array.length) {
      this.fail("array length mismatch");
    }
    return array;
  }

  private readMap(depth: number): Map<unknown, unknown> {
    const map = new Map<unknown, unknown>();
    this.register(map);
    let count = 0;
    while (this.peekTag() !== Tag.endMap) {
      const key = this.readValue(depth);
      map.set(key, this.readValue(depth));
      count += 2;
    }
    this.readByte();
    if (this.readVarint() !== count) this.fail("map length mismatch");
    return map;
  }

  private readSet(depth: number): Set<unknown> {
    const set = new Set<unknown>();
    this.register(set);
    let count = 0;
    while (this.peekTag() !== Tag.endSet) {
      set.add(this.readValue(depth));
      count++;
    }
    this.readByte();
    if (this.readVarint() !== count) this.fail("set length mismatch");
    return set;
  }

  /** Node's DefaultDeserializer host object: view type index, byte length, raw bytes. */
  private readHostView(): SupportedView {
    const typeIndex = this.readVarint();
    const data = this.readRaw(this.readLength(1));
    const view = this.copyView(typeIndex, data);
    this.register(view);
    return view;
  }

  private copyView(typeIndex: number, data: Buffer): SupportedView {
    if (typeIndex === HostView.buffer) return Buffer.from(data);
    if (typeIndex === HostView.uint8) return new Uint8Array(data);
    if (typeIndex === HostView.int8) return new Int8Array(this.alignedCopy(data, 1));
    if (typeIndex === HostView.uint8Clamped) {
      return new Uint8ClampedArray(this.alignedCopy(data, 1));
    }
    if (typeIndex === HostView.int16) return new Int16Array(this.alignedCopy(data, 2));
    if (typeIndex === HostView.uint16) return new Uint16Array(this.alignedCopy(data, 2));
    if (typeIndex === HostView.int32) return new Int32Array(this.alignedCopy(data, 4));
    if (typeIndex === HostView.uint32) return new Uint32Array(this.alignedCopy(data, 4));
    if (typeIndex === HostView.float32) return new Float32Array(this.alignedCopy(data, 4));
    if (typeIndex === HostView.float64) return new Float64Array(this.alignedCopy(data, 8));
    throw this.codecError(`unsupported host object type ${typeIndex}`);
  }

  private alignedCopy(data: Buffer, elementBytes: number): ArrayBuffer {
    if (data.length % elementBytes !== 0) {
      this.fail(`host object length ${data.length} is not a multiple of ${elementBytes}`);
    }
    const copy = new ArrayBuffer(data.length);
    new Uint8Array(copy).set(data);
    return copy;
  }
}

/** Reads bytes written by `v8.serialize` (or `serializeV8`) back into a value. */
export function deserializeV8(bytes: Buffer): unknown {
  const reader = new Reader(bytes);
  reader.readHeader();
  const value = reader.readValue(0);
  if (!reader.atEnd()) {
    throw new V8CodecError("Invalid V8 serialized data: trailing bytes after the value");
  }
  return value;
}
