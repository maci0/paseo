import { z } from "zod";

export type SherpaOnnxModelKind = "stt-offline" | "tts";

type DefaultModelRole = "stt" | "tts";

// How sherpa-onnx loads a model, with file names relative to the extracted directory.
export type SttEngine =
  | { family: "transducer"; encoder: string; decoder: string; joiner: string; tokens: string }
  | { family: "whisper"; encoder: string; decoder: string; tokens: string }
  | { family: "sense_voice"; model: string; tokens: string }
  | { family: "dolphin"; model: string; tokens: string }
  | { family: "nemo_ctc"; model: string; tokens: string };

export type TtsEngine =
  | {
      family: "kokoro";
      model: string;
      voices: string;
      tokens: string;
      dataDir: string;
      // Multi-language Kokoro models read pronunciations from these instead of espeak alone.
      lexicons?: readonly string[];
      dictDir?: string;
      ruleFsts?: readonly string[];
    }
  | { family: "kitten"; model: string; voices: string; tokens: string; dataDir: string }
  | { family: "vits"; model: string; tokens: string; dataDir: string };

interface SherpaOnnxCatalogEntryBase {
  label: string;
  // One user-facing sentence shown before download.
  description: string;
  // BCP 47 language tags the model transcribes or speaks.
  languages: readonly string[];
  // Exact size of the release archive. The downloader rejects any other size.
  downloadSizeBytes: number;
  archiveUrl: string;
  extractedDir: string;
  defaultFor?: DefaultModelRole;
}

type SherpaOnnxCatalogEntry =
  | (SherpaOnnxCatalogEntryBase & { kind: "stt-offline"; engine: SttEngine })
  | (SherpaOnnxCatalogEntryBase & { kind: "tts"; engine: TtsEngine });

// Every sherpa-onnx release archive extracts to a directory named after the archive.
function releaseArchive(tag: "asr-models" | "tts-models", name: string) {
  return {
    archiveUrl: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${tag}/${name}.tar.bz2`,
    extractedDir: name,
  };
}

const PARAKEET_INT8_ENGINE = {
  family: "transducer",
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt",
} as const satisfies SttEngine;

function whisperEngine(size: string): SttEngine {
  return {
    family: "whisper",
    encoder: `${size}-encoder.int8.onnx`,
    decoder: `${size}-decoder.int8.onnx`,
    tokens: `${size}-tokens.txt`,
  };
}

function piperEngine(voice: string): TtsEngine {
  return {
    family: "vits",
    model: `${voice}.onnx`,
    tokens: "tokens.txt",
    dataDir: "espeak-ng-data",
  };
}

// Parakeet TDT v3 transcribes these 25 European languages and detects which one is spoken.
const PARAKEET_V3_LANGUAGES = [
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "ru",
  "uk",
] as const;

// The 99 languages multilingual Whisper models transcribe, detecting which one is spoken.
const WHISPER_LANGUAGES = [
  "en",
  "zh",
  "de",
  "es",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jv",
  "su",
] as const;

// Dolphin's 40 Eastern languages. It also covers 22 Chinese dialects under "zh".
const DOLPHIN_LANGUAGES = [
  "zh",
  "ja",
  "th",
  "ru",
  "ko",
  "id",
  "vi",
  "yue",
  "hi",
  "ur",
  "ms",
  "uz",
  "ar",
  "fa",
  "bn",
  "ta",
  "te",
  "ug",
  "gu",
  "my",
  "tl",
  "kk",
  "or",
  "ne",
  "mn",
  "km",
  "jv",
  "lo",
  "si",
  "fil",
  "ps",
  "pa",
  "kab",
  "ba",
  "ks",
  "tg",
  "su",
  "mr",
  "ky",
  "az",
] as const;

// Catalog order: speech to text first, then text to speech; listings and defaults follow it.
const STT_MODEL_ID_LIST = [
  "parakeet-tdt-0.6b-v2-int8",
  "parakeet-tdt-110m-en-int8",
  "parakeet-tdt-0.6b-v3-int8",
  "whisper-tiny-en",
  "whisper-base",
  "whisper-turbo",
  "sense-voice-int8",
  "dolphin-base-int8",
  "giga-am-v3-ru",
  "parakeet-tdt-ctc-0.6b-ja-int8",
] as const;

const TTS_MODEL_ID_LIST = [
  "kokoro-en-v0_19",
  "kokoro-int8-en-v0_19",
  "kokoro-int8-multi-lang-v1_1",
  "kitten-nano-en-v0_2-fp16",
  "piper-en-us-libritts-r",
  "piper-en-gb-alba",
  "piper-de-thorsten",
  "piper-fr-siwis",
  "piper-es-davefx",
] as const;

export type LocalSttModelId = (typeof STT_MODEL_ID_LIST)[number];
export type LocalTtsModelId = (typeof TTS_MODEL_ID_LIST)[number];
export type SherpaOnnxModelId = LocalSttModelId | LocalTtsModelId;
export type LocalSpeechModelId = SherpaOnnxModelId;

// One value type for every entry: a scriptc binary cannot read a record by a computed key when
// its fields have different types. Each id's kind is checked against its list below.
export const SHERPA_ONNX_MODEL_CATALOG: Readonly<
  Record<SherpaOnnxModelId, SherpaOnnxCatalogEntry>
> = {
  "parakeet-tdt-0.6b-v2-int8": {
    kind: "stt-offline",
    label: "Parakeet v2",
    description: "Accurate English transcription that runs well on a laptop CPU.",
    languages: ["en"],
    downloadSizeBytes: 482_468_385,
    ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"),
    engine: PARAKEET_INT8_ENGINE,
    defaultFor: "stt",
  },
  "parakeet-tdt-110m-en-int8": {
    kind: "stt-offline",
    label: "Parakeet Small",
    description: "Small, fast English model with punctuation. A quick download for any laptop.",
    languages: ["en"],
    downloadSizeBytes: 108_035_095,
    ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8"),
    engine: PARAKEET_INT8_ENGINE,
  },
  "parakeet-tdt-0.6b-v3-int8": {
    kind: "stt-offline",
    label: "Parakeet v3",
    description: "Parakeet for 25 European languages, detecting which one you speak.",
    languages: PARAKEET_V3_LANGUAGES,
    downloadSizeBytes: 487_170_055,
    ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
    engine: PARAKEET_INT8_ENGINE,
  },
  "whisper-tiny-en": {
    kind: "stt-offline",
    label: "Whisper Tiny (English)",
    description: "Small English Whisper model. Quick to download, less accurate than Parakeet.",
    languages: ["en"],
    downloadSizeBytes: 118_071_777,
    ...releaseArchive("asr-models", "sherpa-onnx-whisper-tiny.en"),
    engine: whisperEngine("tiny.en"),
  },
  "whisper-base": {
    kind: "stt-offline",
    label: "Whisper Base",
    description: "Compact Whisper model for 99 languages, detecting which one you speak.",
    languages: WHISPER_LANGUAGES,
    downloadSizeBytes: 207_557_382,
    ...releaseArchive("asr-models", "sherpa-onnx-whisper-base"),
    engine: whisperEngine("base"),
  },
  "whisper-turbo": {
    kind: "stt-offline",
    label: "Whisper Turbo",
    description: "Whisper's most accurate model for 99 languages and Cantonese. Slower on a CPU.",
    languages: [...WHISPER_LANGUAGES, "yue"],
    downloadSizeBytes: 563_790_207,
    ...releaseArchive("asr-models", "sherpa-onnx-whisper-turbo"),
    engine: whisperEngine("turbo"),
  },
  "sense-voice-int8": {
    kind: "stt-offline",
    label: "SenseVoice",
    description: "Chinese, Cantonese, English, Japanese and Korean, detecting which one you speak.",
    languages: ["zh", "yue", "en", "ja", "ko"],
    downloadSizeBytes: 165_783_878,
    ...releaseArchive("asr-models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"),
    engine: { family: "sense_voice", model: "model.int8.onnx", tokens: "tokens.txt" },
  },
  "dolphin-base-int8": {
    kind: "stt-offline",
    label: "Dolphin",
    description: "Small model for 40 Asian and Middle Eastern languages and Chinese dialects.",
    languages: DOLPHIN_LANGUAGES,
    downloadSizeBytes: 80_671_385,
    ...releaseArchive("asr-models", "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02"),
    engine: { family: "dolphin", model: "model.int8.onnx", tokens: "tokens.txt" },
  },
  "giga-am-v3-ru": {
    kind: "stt-offline",
    label: "GigaAM v3 (Russian)",
    description: "Russian transcription with punctuation.",
    languages: ["ru"],
    downloadSizeBytes: 170_197_019,
    ...releaseArchive(
      "asr-models",
      "sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16",
    ),
    engine: {
      family: "transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.onnx",
      joiner: "joiner.onnx",
      tokens: "tokens.txt",
    },
  },
  "parakeet-tdt-ctc-0.6b-ja-int8": {
    kind: "stt-offline",
    label: "Parakeet (Japanese)",
    description: "Japanese transcription with punctuation.",
    languages: ["ja"],
    downloadSizeBytes: 489_389_564,
    ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"),
    engine: { family: "nemo_ctc", model: "model.int8.onnx", tokens: "tokens.txt" },
  },
  "kokoro-en-v0_19": {
    kind: "tts",
    label: "Kokoro (English)",
    description: "Natural-sounding English voice for voice mode replies.",
    languages: ["en"],
    downloadSizeBytes: 319_625_534,
    ...releaseArchive("tts-models", "kokoro-en-v0_19"),
    engine: {
      family: "kokoro",
      model: "model.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
    },
    defaultFor: "tts",
  },
  "kokoro-int8-en-v0_19": {
    kind: "tts",
    label: "Kokoro Lite (English)",
    description: "The same Kokoro English voices, quantized to a third of the download.",
    languages: ["en"],
    downloadSizeBytes: 103_248_205,
    ...releaseArchive("tts-models", "kokoro-int8-en-v0_19"),
    engine: {
      family: "kokoro",
      model: "model.int8.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
    },
  },
  "kokoro-int8-multi-lang-v1_1": {
    kind: "tts",
    label: "Kokoro (Chinese and English)",
    description: "Kokoro voices that speak both Mandarin Chinese and English.",
    languages: ["zh", "en"],
    downloadSizeBytes: 147_031_220,
    ...releaseArchive("tts-models", "kokoro-int8-multi-lang-v1_1"),
    engine: {
      family: "kokoro",
      model: "model.int8.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
      lexicons: ["lexicon-us-en.txt", "lexicon-zh.txt"],
      dictDir: "dict",
      ruleFsts: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
    },
  },
  // Kitten v0.8 needs a newer sherpa-onnx than we pin; v0.2 loads on 1.12.28.
  "kitten-nano-en-v0_2-fp16": {
    kind: "tts",
    label: "Kitten Nano (English)",
    description: "Tiny, very fast English voice.",
    languages: ["en"],
    downloadSizeBytes: 26_586_708,
    ...releaseArchive("tts-models", "kitten-nano-en-v0_2-fp16"),
    engine: {
      family: "kitten",
      model: "model.fp16.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
    },
  },
  "piper-en-us-libritts-r": {
    kind: "tts",
    label: "Piper LibriTTS (US English)",
    description: "Lightweight American English voice.",
    languages: ["en-US"],
    downloadSizeBytes: 23_398_348,
    ...releaseArchive("tts-models", "vits-piper-en_US-libritts_r-medium-int8"),
    engine: piperEngine("en_US-libritts_r-medium"),
  },
  "piper-en-gb-alba": {
    kind: "tts",
    label: "Piper Alba (British English)",
    description: "Lightweight British English voice.",
    languages: ["en-GB"],
    downloadSizeBytes: 21_104_326,
    ...releaseArchive("tts-models", "vits-piper-en_GB-alba-medium-int8"),
    engine: piperEngine("en_GB-alba-medium"),
  },
  "piper-de-thorsten": {
    kind: "tts",
    label: "Piper Thorsten (German)",
    description: "Lightweight German voice.",
    languages: ["de"],
    downloadSizeBytes: 20_949_833,
    ...releaseArchive("tts-models", "vits-piper-de_DE-thorsten-medium-int8"),
    engine: piperEngine("de_DE-thorsten-medium"),
  },
  "piper-fr-siwis": {
    kind: "tts",
    label: "Piper Siwis (French)",
    description: "Lightweight French voice.",
    languages: ["fr"],
    downloadSizeBytes: 20_914_888,
    ...releaseArchive("tts-models", "vits-piper-fr_FR-siwis-medium-int8"),
    engine: piperEngine("fr_FR-siwis-medium"),
  },
  "piper-es-davefx": {
    kind: "tts",
    label: "Piper Davefx (Spanish)",
    description: "Lightweight Spanish voice.",
    languages: ["es"],
    downloadSizeBytes: 21_171_632,
    ...releaseArchive("tts-models", "vits-piper-es_ES-davefx-medium-int8"),
    engine: piperEngine("es_ES-davefx-medium"),
  },
};

export const LOCAL_STT_MODEL_IDS: LocalSttModelId[] = [...STT_MODEL_ID_LIST];

export const LOCAL_TTS_MODEL_IDS: LocalTtsModelId[] = [...TTS_MODEL_ID_LIST];

const ALL_MODEL_IDS: SherpaOnnxModelId[] = [...LOCAL_STT_MODEL_IDS, ...LOCAL_TTS_MODEL_IDS];

function catalogKindMismatch(kind: SherpaOnnxModelKind, ids: readonly SherpaOnnxModelId[]) {
  return ids.filter((id) => SHERPA_ONNX_MODEL_CATALOG[id].kind !== kind);
}

const MISLISTED_MODEL_IDS = [
  ...catalogKindMismatch("stt-offline", LOCAL_STT_MODEL_IDS),
  ...catalogKindMismatch("tts", LOCAL_TTS_MODEL_IDS),
];
if (MISLISTED_MODEL_IDS.length > 0) {
  throw new Error(
    `Local speech catalog lists models under the wrong kind: ${MISLISTED_MODEL_IDS.join(", ")}`,
  );
}

function resolveDefaultModelId(role: "stt"): LocalSttModelId;
function resolveDefaultModelId(role: "tts"): LocalTtsModelId;
function resolveDefaultModelId(role: DefaultModelRole): SherpaOnnxModelId {
  const match = ALL_MODEL_IDS.find((id) => {
    return SHERPA_ONNX_MODEL_CATALOG[id].defaultFor === role;
  });
  if (!match) {
    throw new Error(`No default model configured for role '${role}'`);
  }
  return match;
}

export const DEFAULT_LOCAL_STT_MODEL = resolveDefaultModelId("stt");
export const DEFAULT_LOCAL_TTS_MODEL = resolveDefaultModelId("tts");

function createModelIdSchema<T extends string>(modelIds: readonly T[]): z.ZodType<T, string> {
  const validIds = new Set<string>(modelIds);
  return z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => validIds.has(value), {
      message: "Invalid model id",
    })
    .transform((value) => value as T);
}

export const LocalSpeechModelIdSchema = createModelIdSchema(ALL_MODEL_IDS);
export const LocalSttModelIdSchema = createModelIdSchema(LOCAL_STT_MODEL_IDS);
export const LocalTtsModelIdSchema = createModelIdSchema(LOCAL_TTS_MODEL_IDS);

export type SherpaOnnxModelSpec = SherpaOnnxCatalogEntry & {
  id: SherpaOnnxModelId;
  // Every file and directory that must exist for the model to count as installed.
  requiredFiles: string[];
};

export function listSherpaOnnxModels(): SherpaOnnxModelSpec[] {
  return ALL_MODEL_IDS.map(getSherpaOnnxModelSpec);
}

export function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec {
  const spec: SherpaOnnxCatalogEntry | undefined = SHERPA_ONNX_MODEL_CATALOG[id];
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${id}`);
  }
  return {
    id,
    ...spec,
    requiredFiles: engineFiles(spec.engine),
  };
}

// Every path an engine names, so the downloader can verify an install.
// In the order the engine types declare them. Fields are read one by one: a scriptc binary
// cannot iterate a record whose fields have different types.
export function engineFiles(engine: SttEngine | TtsEngine): string[] {
  switch (engine.family) {
    case "transducer":
      return [engine.encoder, engine.decoder, engine.joiner, engine.tokens];
    case "whisper":
      return [engine.encoder, engine.decoder, engine.tokens];
    case "sense_voice":
    case "dolphin":
    case "nemo_ctc":
      return [engine.model, engine.tokens];
    case "kokoro":
      return [
        engine.model,
        engine.voices,
        engine.tokens,
        engine.dataDir,
        ...(engine.lexicons ?? []),
        ...(engine.dictDir === undefined ? [] : [engine.dictDir]),
        ...(engine.ruleFsts ?? []),
      ];
    case "kitten":
      return [engine.model, engine.voices, engine.tokens, engine.dataDir];
    case "vits":
      return [engine.model, engine.tokens, engine.dataDir];
  }
}

export function getLocalSttEngine(id: LocalSttModelId): SttEngine {
  const entry = SHERPA_ONNX_MODEL_CATALOG[id];
  if (entry.kind !== "stt-offline") {
    throw new Error(`Not a speech-to-text model: ${id}`);
  }
  return entry.engine;
}

export function getLocalTtsEngine(id: LocalTtsModelId): TtsEngine {
  const entry = SHERPA_ONNX_MODEL_CATALOG[id];
  if (entry.kind !== "tts") {
    throw new Error(`Not a text-to-speech model: ${id}`);
  }
  return entry.engine;
}
