import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "node:v8";
import { deserializeV8, serializeV8, V8CodecError } from "./terminal-worker-v8-codec.js";

// Deterministic generator (mulberry32) so a failing case reproduces from its seed.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  63,
  64,
  -64,
  -65,
  2147483647,
  -2147483648,
  2147483648,
  -2147483649,
  4294967295,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  1.5,
  -1e-300,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Infinity,
  -Infinity,
  NaN,
  1731234567890,
];

const STRINGS = [
  "",
  "a",
  "output",
  "café ÿ",
  "€",
  "x€y",
  "\u{1f600} emoji",
  "\ud800 lone high",
  "lone low \udc00",
  "\x00\x1b[31mred\x1b[0m",
  "a".repeat(200),
  "€".repeat(70),
];

function randomString(random: () => number): string {
  const kind = Math.floor(random() * 3);
  const length = Math.floor(random() * 40);
  let result = "";
  for (let i = 0; i < length; i++) {
    if (kind === 0) result += String.fromCharCode(0x20 + Math.floor(random() * 0x5f));
    else if (kind === 1) result += String.fromCharCode(Math.floor(random() * 0x100));
    else result += String.fromCharCode(Math.floor(random() * 0x10000));
  }
  return result;
}

function randomBytes(random: () => number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

function randomLeaf(random: () => number): unknown {
  switch (Math.floor(random() * 9)) {
    case 0:
      return NUMBERS[Math.floor(random() * NUMBERS.length)];
    case 1:
      return Math.floor(random() * 2 ** 32) - 2 ** 31;
    case 2:
      return (random() - 0.5) * 1e6;
    case 3:
      return STRINGS[Math.floor(random() * STRINGS.length)];
    case 4:
      return randomString(random);
    case 5:
      return random() < 0.5;
    case 6:
      return random() < 0.5 ? null : undefined;
    case 7:
      return randomBytes(random, Math.floor(random() * 300));
    default:
      return new Uint8Array(randomBytes(random, Math.floor(random() * 20)));
  }
}

function randomValue(random: () => number, depth: number): unknown {
  if (depth >= 4 || random() < 0.4) return randomLeaf(random);
  const size = Math.floor(random() * 5);
  switch (Math.floor(random() * 4)) {
    case 0:
      return Array.from({ length: size }, () => randomValue(random, depth + 1));
    case 1: {
      const object: Record<string, unknown> = {};
      for (let i = 0; i < size; i++) {
        const key = random() < 0.2 ? String(Math.floor(random() * 10)) : randomString(random);
        object[key === "__proto__" ? "proto" : key] = randomValue(random, depth + 1);
      }
      return object;
    }
    case 2:
      return new Map(
        Array.from({ length: size }, () => [randomLeafKey(random), randomValue(random, depth + 1)]),
      );
    default:
      return new Set(Array.from({ length: size }, () => randomLeafKey(random)));
  }
}

function randomLeafKey(random: () => number): unknown {
  return random() < 0.5 ? randomString(random) : Math.floor(random() * 100);
}

// Values the terminal worker protocol sends, built the way the worker and daemon build them.
function representativeFrames(): unknown[] {
  const activity = { state: "working", attentionReason: null, changedAt: 1731234567890 };
  const replayData = Buffer.from("\x1b[H\x1b[2Jprompt € $ ", "utf8");
  return [
    { type: "hello", secret: "c2VjcmV0", protocolVersion: 5 },
    { type: "helloAck", pid: 4242, protocolVersion: 5 },
    {
      type: "createTerminal",
      requestId: "req-1",
      options: {
        cwd: "/home/user/project",
        workspaceId: "ws-1",
        env: { PATH: "/usr/bin", LANG: "C.UTF-8", "0": "index key" },
        args: ["-l"],
        rows: 24,
        cols: 80,
        activityUrl: null,
        baseEnv: { HOME: "/home/user" },
        paseoCliPath: null,
      },
    },
    {
      type: "send",
      requestId: "req-2",
      terminalId: "t1",
      message: { type: "input", data: "ls\r" },
    },
    {
      type: "terminalMessage",
      terminalId: "t1",
      message: { type: "output", data: "café │ \u{1f600}\r\n", revision: undefined },
      replayPreamble: "\x1b[?2004h",
    },
    { type: "terminalReplay", requestId: "req-3", event: { type: "data", data: replayData } },
    {
      type: "terminalReplay",
      requestId: "req-3",
      event: {
        type: "begin",
        metadata: { rows: 24, cols: 80, retainedHistoryLines: 0, revision: 7, replayPreamble: "" },
      },
    },
    {
      type: "terminalExit",
      terminalId: "t1",
      info: { exitCode: null, signal: 15, lastOutputLines: ["bye", ""] },
    },
    { type: "terminalActivityChange", terminalId: "t1", activity, previous: activity },
    { type: "response", requestId: "req-4", ok: false, error: "Terminal worker request failed" },
    { type: "response", requestId: "req-5", ok: true, result: { lines: [], totalLines: 0 } },
    { type: "a", data: new Map([["k", 1]]) },
  ];
}

function holeyArray(): unknown[] {
  const array: unknown[] = [1];
  array[2] = 2;
  return array;
}

describe("terminal worker v8 codec", () => {
  it("writes the same bytes as v8.serialize for the protocol's frames", () => {
    for (const frame of representativeFrames()) {
      expect(serializeV8(frame).toString("hex")).toBe(serialize(frame).toString("hex"));
    }
  });

  it("writes the same bytes as v8.serialize for deterministic leaves and containers", () => {
    const shared = { x: 1 };
    const buffer = Buffer.from([1, 2, 3]);
    const cyclic: Record<string, unknown> = { name: "self" };
    cyclic.self = cyclic;
    const values: unknown[] = [
      ...NUMBERS,
      ...STRINGS.filter((value) => !/[\ud800-\udfff]/.test(value)),
      true,
      false,
      null,
      undefined,
      [],
      {},
      new Map(),
      new Set(),
      new Set([1, "a", null]),
      { 1: "x", b: 2, "4294967294": 3, "4294967295": 4, "2147483648": 5, "01": 6 },
      { a: shared, b: shared, c: [shared] },
      { a: buffer, b: buffer },
      cyclic,
      Buffer.alloc(0),
      new Uint8Array([255, 0]),
      new Int8Array([-1, 2]),
      new Uint8ClampedArray([9]),
      new Int16Array([-2, 300]),
      new Uint16Array([65535]),
      new Int32Array([-5, 2 ** 30]),
      new Uint32Array([2 ** 32 - 1]),
      new Float32Array([1.5, -0]),
      new Float64Array([Math.PI, NaN]),
      new Float64Array(new ArrayBuffer(24), 8, 1),
      Buffer.from("subarray-of-a-pooled-buffer").subarray(3, 9),
      Buffer.alloc(200_000, 7),
      // Two-byte string data is aligned; these start at both odd and even offsets.
      { a: "€" },
      { ab: "€" },
      ["€".repeat(64)],
      [1, "€".repeat(64)],
    ];
    for (const value of values) {
      expect(serializeV8(value).toString("hex")).toBe(serialize(value).toString("hex"));
    }
  });

  it("round-trips generated values through node:v8 in both directions", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const value = randomValue(createRandom(seed), 0);
      expect(deserialize(serializeV8(value)), `seed ${seed}`).toStrictEqual(value);
      expect(deserializeV8(serialize(value)), `seed ${seed}`).toStrictEqual(value);
      expect(deserializeV8(serializeV8(value)), `seed ${seed}`).toStrictEqual(value);
    }
  });

  it("reads every string and number form V8 can choose for the same value", () => {
    // A slice of a two-byte string stays two-byte in V8 even when its content is ASCII.
    const twoByteAscii = "€abcdefghijklmnopqrstuvwxyz".slice(1);
    expect(serialize(twoByteAscii)[2]).toBe(0x63);
    expect(deserializeV8(serialize(twoByteAscii))).toBe("abcdefghijklmnopqrstuvwxyz");
    // A one-byte, UTF-8 and double encoding of values this encoder writes differently.
    expect(deserializeV8(Buffer.from("ff0f5303e282ac", "hex"))).toBe("€");
    expect(deserializeV8(Buffer.from("ff0f4e0000000000001440", "hex"))).toBe(5);
    expect(deserializeV8(Buffer.from("ff0d22016f", "hex"))).toBe("o");
    // A holey-kind array with every index filled is written in the sparse form.
    const filled: unknown[] = [];
    filled.length = 3;
    filled[0] = "a";
    filled[1] = { b: 1 };
    filled[2] = 2 ** 40;
    expect(serialize(filled)[2]).toBe(0x61);
    expect(deserializeV8(serialize(filled))).toEqual(["a", { b: 1 }, 2 ** 40]);
  });

  it("keeps lone surrogates, -0 and NaN", () => {
    for (const value of ["\ud800", "a\udc00b", -0, NaN]) {
      expect(Object.is(deserializeV8(serialize(value)), value)).toBe(true);
      expect(Object.is(deserialize(serializeV8(value)), value)).toBe(true);
    }
  });

  it("decodes Buffer, Uint8Array and typed arrays as their own types and preserves identity", () => {
    const buffer = Buffer.from("abc");
    const decoded = deserializeV8(serialize({ a: buffer, b: buffer, u: new Uint8Array([1]) })) as {
      a: Buffer;
      b: Buffer;
      u: Uint8Array;
    };
    expect(Buffer.isBuffer(decoded.a)).toBe(true);
    expect(decoded.b).toBe(decoded.a);
    expect(Buffer.isBuffer(decoded.u)).toBe(false);
    expect(decoded.u).toBeInstanceOf(Uint8Array);
    expect(deserializeV8(serialize(new Int16Array([-2, 3])))).toEqual(new Int16Array([-2, 3]));
    const original: Record<string, unknown> = {};
    original.self = original;
    const cyclic = deserializeV8(serialize(original)) as { self: unknown };
    expect(cyclic.self).toBe(cyclic);
  });

  it("does not share memory with the input bytes", () => {
    const bytes = serialize(Buffer.from([1, 2, 3]));
    const decoded = deserializeV8(bytes) as Buffer;
    bytes.fill(0);
    expect([...decoded]).toEqual([1, 2, 3]);
  });

  it("rejects values outside the subset when encoding", () => {
    for (const value of [
      () => 1,
      Symbol("s"),
      10n,
      new Date(0),
      /re/,
      new Error("e"),
      new ArrayBuffer(1),
      new DataView(new ArrayBuffer(1)),
      new BigInt64Array(1),
      Promise.resolve(),
      JSON.parse('{"__proto__": 1}'),
    ]) {
      expect(() => serializeV8(value)).toThrow(V8CodecError);
    }
    let deep: unknown = 0;
    for (let i = 0; i < 300; i++) deep = [deep];
    expect(() => serializeV8(deep)).toThrow(V8CodecError);
  });

  it("rejects node:v8 output outside the subset when decoding", () => {
    for (const value of [
      new Date(0),
      10n,
      /re/,
      new Error("e"),
      new ArrayBuffer(1),
      new DataView(new ArrayBuffer(1)),
      new BigInt64Array(1),
      holeyArray(),
      Object.assign([1], { extra: true }),
      new Number(1),
      JSON.parse('{"__proto__": 1}'),
    ]) {
      expect(() => deserializeV8(serialize(value))).toThrow(V8CodecError);
    }
    let deep: unknown = 0;
    for (let i = 0; i < 300; i++) deep = [deep];
    expect(() => deserializeV8(serialize(deep))).toThrow(V8CodecError);
  });

  it("rejects every truncation of a valid payload", () => {
    for (const frame of representativeFrames()) {
      const bytes = serialize(frame);
      for (let length = 0; length < bytes.length; length++) {
        expect(() => deserializeV8(bytes.subarray(0, length))).toThrow(V8CodecError);
      }
    }
  });

  it("rejects malformed headers, lengths, counts and references", () => {
    const cases = [
      "", // empty
      "0f49", // no version tag
      "ff1049", // newer format version
      "ff0c5f", // older format version
      "ff0f", // header only
      "ff0f5f5f", // trailing bytes
      "ff0f49ffffffffff01", // varint over 32 bits
      "ff0f22ffffffff0f", // string length past the end
      "ff0f6303616263", // odd two-byte length
      "ff0f41ffffffff0f", // array length past the end
      "ff0f4102490224000049", // array length mismatch at the end
      "ff0f6f22016149027b05", // object property count mismatch
      "ff0f6f6f7b007b01", // object key that is an object
      "ff0f3b49023a03", // map entry count mismatch
      "ff0f5e00", // reference before any object
      "ff0f6f2201615e057b01", // reference to an unknown id
      "ff0f5c0b0101", // unsupported host view type
      "ff0f5c030301ffff", // Int16Array with an odd byte length
      "ff0f5c0105ff", // host view length past the end
      "ff0f44", // Date tag
      "ff0f3f0049", // legacy object count verification tag
      "ff0f2d", // array hole
      "ff0f00000000", // padding only
    ];
    for (const hex of cases) {
      expect(() => deserializeV8(Buffer.from(hex, "hex")), hex).toThrow(V8CodecError);
    }
  });

  it("rejects random corruptions without hanging or misreading them as other errors", () => {
    const random = createRandom(99);
    for (const frame of representativeFrames()) {
      const valid = serialize(frame);
      for (let trial = 0; trial < 200; trial++) {
        const bytes = Buffer.from(valid);
        const flips = 1 + Math.floor(random() * 3);
        for (let i = 0; i < flips; i++) {
          bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        }
        try {
          deserializeV8(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(V8CodecError);
        }
      }
    }
  });
});
