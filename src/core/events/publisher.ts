/**
 * Outbox publisher. Polls unpublished rows in aggregate order and hands each
 * envelope to a transport, marking it published only after the transport
 * accepts it — at-least-once delivery, which is what ADR-010 asks for.
 *
 * The transport itself is deliberately a port: no message-broker contract
 * exists in Release 0, so the default implementation logs and the real one gets
 * wired when that contract lands.
 */
import { and, asc, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { outbox } from "../../db/schema.js";
import type { DomainEvent } from "./envelope.js";

export interface EventTransport {
  publish(event: DomainEvent): Promise<void>;
}

export const loggingTransport = (log: (msg: string) => void): EventTransport => ({
  async publish(event) {
    log(`published ${event.eventType} ${event.eventId} (aggregate ${event.aggregateId})`);
  },
});

export interface PublisherOptions {
  db: Database;
  transport: EventTransport;
  batchSize: number;
  pollIntervalMs: number;
  onError?: (error: unknown) => void;
}

/** Publishes one batch. Returns how many events were published. */
export async function publishBatch(options: PublisherOptions): Promise<number> {
  const { db, transport, batchSize } = options;

  const rows = await db
    .select()
    .from(outbox)
    .where(isNull(outbox.publishedAt))
    .orderBy(asc(outbox.aggregateType), asc(outbox.aggregateId), asc(outbox.aggregateSequence))
    .limit(batchSize);

  let published = 0;
  for (const row of rows) {
    const event = row.payload as unknown as DomainEvent;
    await transport.publish(event);
    await db
      .update(outbox)
      .set({ publishedAt: new Date() })
      .where(and(sql`${outbox.id} = ${row.id}`, isNull(outbox.publishedAt)));
    published += 1;
  }
  return published;
}

export function startPublisher(options: PublisherOptions): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await publishBatch(options);
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(tick, options.pollIntervalMs);
  };

  timer = setTimeout(tick, options.pollIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
