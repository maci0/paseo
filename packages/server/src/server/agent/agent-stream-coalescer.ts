import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { mergeToolCallItems } from "./timeline-projection.js";

export const AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS = 60;

type CoalescableTextKind = "assistant_message" | "reasoning";
type CoalescableTimelineKind = CoalescableTextKind | "tool_call";
type CoalescableTextItem = Extract<AgentTimelineItem, { type: CoalescableTextKind }>;
type CoalescableTimelineItem = Extract<AgentTimelineItem, { type: CoalescableTimelineKind }>;
type ToolCallTimelineItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

export interface AgentStreamCoalescerTimers {
  setTimeout: (callback: () => void, ms?: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface AgentStreamCoalescerFlush {
  agentId: string;
  item: CoalescableTimelineItem;
  provider: AgentProvider;
  turnId?: string;
}

export interface AgentStreamCoalescerOptions {
  windowMs?: number;
  timers: AgentStreamCoalescerTimers;
  now?: () => number;
  onFlush: (payload: AgentStreamCoalescerFlush) => void;
}

interface PendingTextEntry {
  kind: "text";
  item: CoalescableTextItem;
  text: string;
  provider: AgentProvider;
  turnId?: string;
}

interface PendingToolCallEntry {
  kind: "tool_call";
  item: Extract<AgentTimelineItem, { type: "tool_call" }>;
  provider: AgentProvider;
  turnId?: string;
}

type PendingAgentStreamEntry = PendingTextEntry | PendingToolCallEntry;

interface PendingAgentStreamBuffer {
  agentId: string;
  entries: PendingAgentStreamEntry[];
  toolCallEntryIndexes: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  lastFlushAt: number | null;
}

function isTerminalToolCall(item: ToolCallTimelineItem): boolean {
  return item.status === "completed" || item.status === "failed" || item.status === "canceled";
}

function isSameTextStream(previous: PendingTextEntry, next: PendingTextEntry): boolean {
  if (previous.item.type !== next.item.type) {
    return false;
  }
  if (previous.item.type === "assistant_message" && next.item.type === "assistant_message") {
    return previous.item.messageId === next.item.messageId;
  }
  return true;
}

export class AgentStreamCoalescer {
  private readonly buffers = new Map<string, PendingAgentStreamBuffer>();
  private readonly onFlush: (payload: AgentStreamCoalescerFlush) => void;
  private readonly timers: AgentStreamCoalescerTimers;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: AgentStreamCoalescerOptions) {
    this.windowMs = options.windowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS;
    this.timers = options.timers;
    this.now = options.now ?? Date.now;
    this.onFlush = options.onFlush;
  }

  handle(agentId: string, event: AgentStreamEvent): boolean {
    // Narrowed by discriminant checks and passed as parts: scriptc does not narrow through
    // type predicates or convert the whole event to a narrower record type.
    if (event.type !== "timeline") {
      return false;
    }
    const item = event.item;
    let buffer: PendingAgentStreamBuffer;
    if (item.type === "assistant_message" || item.type === "reasoning") {
      if (item.text === "") {
        return true;
      }
      buffer = this.getOrCreateBuffer(agentId);
      this.appendTextToBuffer(buffer, item, event.provider, event.turnId);
    } else if (item.type === "tool_call") {
      buffer = this.getOrCreateBuffer(agentId);
      this.appendToolCallToBuffer(buffer, item, event.provider, event.turnId);
      if (isTerminalToolCall(item)) {
        this.flushBuffer(agentId);
        return true;
      }
    } else {
      return false;
    }

    // Leading edge: the first event after an idle window flushes synchronously so
    // the first token of a turn isn't delayed a full window. Sustained bursts fall
    // through to the trailing timer, which keeps the message rate at one per
    // window. Same shape as TerminalOutputCoalescer.
    if (!buffer.timer) {
      const elapsed =
        buffer.lastFlushAt === null ? Number.POSITIVE_INFINITY : this.now() - buffer.lastFlushAt;
      if (elapsed >= this.windowMs) {
        this.flushBuffer(agentId);
        return true;
      }
      this.scheduleFlush(buffer);
    }

    return true;
  }

  flushFor(agentId: string): void {
    this.flushBuffer(agentId);
  }

  flushAll(): void {
    for (const agentId of Array.from(this.buffers.keys())) {
      this.flushBuffer(agentId);
    }
  }

  flushAndDiscard(agentId: string): void {
    this.flushBuffer(agentId);
    const buffer = this.buffers.get(agentId);
    if (buffer) {
      this.clearTimer(buffer);
      this.buffers.delete(agentId);
    }
  }

  private getOrCreateBuffer(agentId: string): PendingAgentStreamBuffer {
    const existing = this.buffers.get(agentId);
    if (existing) {
      return existing;
    }

    const buffer: PendingAgentStreamBuffer = {
      agentId,
      entries: [],
      toolCallEntryIndexes: new Map(),
      timer: null,
      flushing: false,
      lastFlushAt: null,
    };
    this.buffers.set(agentId, buffer);
    return buffer;
  }

  private appendTextToBuffer(
    buffer: PendingAgentStreamBuffer,
    item: CoalescableTextItem,
    provider: AgentProvider,
    turnId: string | undefined,
  ): void {
    buffer.entries.push({
      kind: "text",
      item,
      text: item.text,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }

  private appendToolCallToBuffer(
    buffer: PendingAgentStreamBuffer,
    eventItem: ToolCallTimelineItem,
    provider: AgentProvider,
    turnId: string | undefined,
  ): void {
    const existingIndex = buffer.toolCallEntryIndexes.get(eventItem.callId);
    const existing = existingIndex !== undefined ? buffer.entries[existingIndex] : undefined;
    // Merge rather than replace, so an update that carries less (an unknown detail after a
    // labeled one) cannot erase what the timeline would have kept had both been flushed.
    let item = eventItem;
    if (existing?.kind === "tool_call") {
      item = mergeToolCallItems(existing.item, eventItem);
    }
    const entry: PendingToolCallEntry = {
      kind: "tool_call",
      item,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    };

    if (existingIndex !== undefined) {
      buffer.entries[existingIndex] = entry;
      return;
    }

    buffer.toolCallEntryIndexes.set(eventItem.callId, buffer.entries.length);
    buffer.entries.push(entry);
  }

  private scheduleFlush(buffer: PendingAgentStreamBuffer): void {
    const timer = this.timers.setTimeout(() => {
      this.flushBuffer(buffer.agentId, buffer);
    }, this.windowMs);
    timer.unref?.();
    buffer.timer = timer;
  }

  private clearTimer(buffer: PendingAgentStreamBuffer): void {
    if (!buffer.timer) {
      return;
    }
    this.timers.clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  private flushBuffer(agentId: string, expectedBuffer?: PendingAgentStreamBuffer): void {
    const buffer = this.buffers.get(agentId);
    if (!buffer) {
      return;
    }
    if (expectedBuffer && buffer !== expectedBuffer) {
      return;
    }
    if (buffer.flushing) {
      return;
    }

    this.clearTimer(buffer);
    if (buffer.entries.length === 0) {
      return;
    }

    const entries = buffer.entries;
    buffer.entries = [];
    buffer.toolCallEntryIndexes.clear();
    buffer.flushing = true;
    buffer.lastFlushAt = this.now();

    try {
      for (const entry of this.collapseEntries(entries)) {
        this.onFlush({
          agentId,
          item:
            entry.kind === "text"
              ? {
                  ...entry.item,
                  text: entry.text,
                }
              : entry.item,
          provider: entry.provider,
          ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        });
      }
    } finally {
      buffer.flushing = false;
    }
  }

  private collapseEntries(entries: PendingAgentStreamEntry[]): PendingAgentStreamEntry[] {
    const collapsed: PendingAgentStreamEntry[] = [];

    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (
        previous &&
        previous.kind === "text" &&
        entry.kind === "text" &&
        isSameTextStream(previous, entry) &&
        previous.provider === entry.provider &&
        previous.turnId === entry.turnId
      ) {
        previous.text += entry.text;
        continue;
      }

      collapsed.push({ ...entry });
    }

    return collapsed;
  }
}
