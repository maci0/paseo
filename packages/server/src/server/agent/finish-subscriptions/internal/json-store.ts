import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../../atomic-file.js";
import type { FinishSubscription, FinishSubscriptionStore } from "../index.js";

const recordsSchema = z.array(
  z.object({
    id: z.string().min(1),
    callerAgentId: z.string().min(1),
    childAgentId: z.string().min(1),
    serverId: z.string().min(1).optional(),
    requireParentOwnership: z.boolean().optional(),
  }),
);

// scriptc lowers only top-level generic functions, so the queue state is passed in.
interface WriteQueue {
  tail: Promise<void>;
}
function serialized<T>(queue: WriteQueue, action: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(action);
  queue.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function createJsonFinishSubscriptionStore(paseoHome: string): FinishSubscriptionStore {
  const file = join(paseoHome, "finish-subscriptions.json");
  let records: FinishSubscription[] | undefined;
  const pending: WriteQueue = { tail: Promise.resolve() };
  async function load(): Promise<FinishSubscription[]> {
    if (records) return records;
    try {
      records = recordsSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      records = [];
    }
    return records;
  }
  async function mutate(
    update: (current: FinishSubscription[]) => FinishSubscription[],
  ): Promise<void> {
    const next = update(await load());
    await writeJsonFileAtomic(file, next);
    records = next;
  }
  return {
    list: () =>
      serialized(pending, async () => (await load()).map((record) => Object.assign({}, record))),
    put: (subscription) =>
      serialized(pending, () =>
        mutate((current) => [
          ...current.filter((record) => record.id !== subscription.id),
          { ...subscription },
        ]),
      ),
    remove: (id) =>
      serialized(pending, () => mutate((current) => current.filter((record) => record.id !== id))),
  };
}
