import type { Seconds, Timestamp } from "@kuindji/muster-contract";

import type {
  Clock,
  CoreIdentityKind,
  EventSink,
  IdSource,
} from "./ports.js";
import type { MusterEvent } from "./events.js";

export class ManualClock implements Clock {
  constructor(private current: Timestamp) {}

  now(): Timestamp {
    return this.current;
  }

  set(value: Timestamp): void {
    this.current = value;
  }

  advance(seconds: Seconds): Timestamp {
    const milliseconds = Date.parse(this.current) + seconds * 1_000;
    if (!Number.isFinite(milliseconds)) throw new Error("invalid clock value");
    this.current = new Date(milliseconds).toISOString();
    return this.current;
  }
}

export class SequenceIdSource implements IdSource {
  private readonly counts = new Map<CoreIdentityKind, number>();

  constructor(private readonly prefix = "test") {}

  next(kind: CoreIdentityKind): string {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return `${this.prefix}-${kind}-${count}`;
  }

  reset(): void {
    this.counts.clear();
  }
}

export class RecordingEventSink implements EventSink {
  private events: MusterEvent[] = [];

  emit(event: MusterEvent): void {
    this.events.push(structuredClone(event));
  }

  all(): readonly MusterEvent[] {
    return structuredClone(this.events);
  }

  reset(): void {
    this.events = [];
  }
}
