// Node forks the speech worker with serialization "advanced" and sends audio as an ArrayBuffer. A
// scriptc binary (process.argv[0] === "scriptc") has JSON IPC only, so it sends base64 text.
export type LocalSpeechWorkerBytes = ArrayBuffer | string;

const BASE64_IPC = process.argv[0] === "scriptc";

export function bufferToWorkerBytes(buffer: Buffer): LocalSpeechWorkerBytes {
  if (BASE64_IPC) {
    return buffer.toString("base64");
  }
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes.buffer;
}

export function workerBytesToBuffer(bytes: LocalSpeechWorkerBytes): Buffer {
  return typeof bytes === "string" ? Buffer.from(bytes, "base64") : Buffer.from(bytes);
}

export function workerBytesLength(bytes: LocalSpeechWorkerBytes): number {
  return typeof bytes === "string" ? Buffer.byteLength(bytes, "base64") : bytes.byteLength;
}
