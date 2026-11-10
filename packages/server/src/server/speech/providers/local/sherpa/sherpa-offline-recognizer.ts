import { existsSync } from "node:fs";
import path from "node:path";
import type pino from "pino";

import { engineFiles, type SttEngine } from "./model-catalog.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";

function assertFileExists(filePath: string, label: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

// Each engine family takes its own block under sherpa's modelConfig.
function buildModelConfig(modelDir: string, engine: SttEngine): Record<string, unknown> {
  const file = (name: string) => path.join(modelDir, name);
  switch (engine.family) {
    case "transducer":
      return {
        transducer: {
          encoder: file(engine.encoder),
          decoder: file(engine.decoder),
          joiner: file(engine.joiner),
        },
        modelType: "nemo_transducer",
      };
    case "whisper":
      // An empty language makes Whisper detect the spoken language.
      return {
        whisper: {
          encoder: file(engine.encoder),
          decoder: file(engine.decoder),
          language: "",
          task: "transcribe",
        },
      };
    case "sense_voice":
      return {
        senseVoice: { model: file(engine.model), language: "", useInverseTextNormalization: 1 },
      };
    case "dolphin":
      return { dolphin: { model: file(engine.model) } };
    case "nemo_ctc":
      return { nemoCtc: { model: file(engine.model) } };
  }
}

export interface SherpaOfflineRecognizerConfig {
  modelDir: string;
  engine: SttEngine;
  numThreads?: number;
  provider?: "cpu";
  debug?: 0 | 1;
  sampleRate?: number;
  featureDim?: number;
  decodingMethod?: "greedy_search";
  maxActivePaths?: number;
}

// Required members are method signatures: a scriptc binary matches class methods of the FFI
// module (native/sherpa/sherpa-onnx-ffi.ts) only to method signatures.
interface SherpaOfflineRecognizerNative {
  createStream(): SherpaOfflineStreamNative;
  decode(stream: SherpaOfflineStreamNative): void;
  getResult(stream: SherpaOfflineStreamNative): SherpaOfflineRecognizerResult;
  free?: () => void;
}

type SherpaOfflineRecognizerResult = { text?: string } | string | undefined;

// Narrows with typeof only: a scriptc binary refuses `in` on this union.
export function recognizerResultText(result: SherpaOfflineRecognizerResult): string {
  if (typeof result === "string") {
    return result;
  }
  if (typeof result === "object") {
    return result.text ?? String(result);
  }
  return "";
}

interface SherpaOfflineStreamNative {
  acceptWaveform(arg: { samples: Float32Array; sampleRate: number }): void;
  free?: () => void;
}

export class SherpaOfflineRecognizerEngine {
  public readonly recognizer: SherpaOfflineRecognizerNative;
  public readonly sampleRate: number;
  private readonly logger: pino.Logger;

  constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger) {
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "offline-recognizer",
    });

    for (const name of engineFiles(config.engine)) {
      assertFileExists(path.join(config.modelDir, name), `${config.engine.family} model file`);
    }

    const sherpa = loadSherpaOnnxNode();

    const recognizerConfig = {
      featConfig: {
        sampleRate: config.sampleRate ?? 16000,
        featureDim: config.featureDim ?? 80,
      },
      modelConfig: {
        ...buildModelConfig(config.modelDir, config.engine),
        tokens: path.join(config.modelDir, config.engine.tokens),
        numThreads: config.numThreads ?? 1,
        provider: config.provider ?? "cpu",
        debug: config.debug ?? 0,
      },
      decodingMethod: config.decodingMethod ?? "greedy_search",
      maxActivePaths: config.maxActivePaths ?? 4,
    };

    this.recognizer = new (
      sherpa as unknown as {
        OfflineRecognizer: new (config: unknown) => SherpaOfflineRecognizerNative;
      }
    ).OfflineRecognizer(recognizerConfig);
    // The addon keeps the config object it was given, so this is the value it reports back.
    this.sampleRate = recognizerConfig.featConfig.sampleRate;

    this.logger.info(
      { sampleRate: this.sampleRate, numThreads: recognizerConfig.modelConfig.numThreads },
      "Sherpa offline recognizer initialized",
    );
  }

  createStream(): SherpaOfflineStreamNative {
    return this.recognizer.createStream();
  }

  acceptWaveform(
    stream: SherpaOfflineStreamNative,
    sampleRate: number,
    samples: Float32Array,
  ): void {
    if (!stream || typeof stream.acceptWaveform !== "function") {
      throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
    }

    stream.acceptWaveform({ samples, sampleRate });
  }

  free(): void {
    try {
      this.recognizer?.free?.();
    } catch (err) {
      this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
    }
  }
}
