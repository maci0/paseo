/** The FSWatcher operations the native recursive backend uses. */
export interface RecursiveWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export function watchRecursive(
  root: string,
  listener: (eventType: string, filename: string | null) => void,
): RecursiveWatcher;
