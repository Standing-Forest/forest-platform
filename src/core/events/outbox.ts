/**
 * ARCH-005 / ADR-010: transactional outbox. The event row is written inside the
 * same transaction as the state change it describes, so a committed state change
 * always has its event and a rolled-back one never does.
 *
 * SPEC NOTE (recorded as a gap, see contract-gap registry):
 * events.outbox has columns for only 9 of the envelope's 15 required fields —
 * actor, correlationId, sourceInstanceId, sourceService and dataClassification
 * have no column. The `payload` JSONB therefore stores the complete validated
 * envelope, while the dedicated columns carry the subset needed for ordering,
 * dedupe and routing. This keeps published events envelope-conformant without
 * inventing new columns on the approved table.
 */
import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { newId } from "../ids.js";
import { registerContractGap } from "../spec/contract-gap.js";
import { assertValidEnvelope, type Actor, type DataClassification, type DomainEvent } from "./envelope.js";
import { outbox } from "../../db/schema.js";

registerContractGap({
  operation: "events.outbox envelope persistence",
  missingArtifacts: [
    "events.outbox columns for: actor, correlation_id, source_instance_id, source_service, data_classification",
  ],
  blockedRequirementIds: ["ARCH-005"],
  notes:
    "The approved envelope requires 15 fields; the approved outbox table has columns for 9. " +
    "The full envelope is stored in payload JSONB as a workaround. Either the table needs " +
    "additional columns or the spec should state that payload holds the whole envelope.",
});

export interface EmitEventInput<TPayload> {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  payload: TPayload;
  requirementIds: string[];
  actor: Actor;
  correlationId: string;
  dataClassification: DataClassification;
  sourceInstanceId: string;
  sourceService: string;
  schemaVersion?: number;
  occurredAt?: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, any, any>;

export function buildEvent<TPayload>(input: EmitEventInput<TPayload>): DomainEvent<TPayload> {
  const occurredAt = input.occurredAt ?? new Date();
  const event: DomainEvent<TPayload> = {
    eventId: newId(),
    eventType: input.eventType,
    schemaVersion: input.schemaVersion ?? 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateSequence: input.aggregateSequence,
    actor: input.actor,
    occurredAt: occurredAt.toISOString(),
    recordedAt: new Date().toISOString(),
    correlationId: input.correlationId,
    sourceInstanceId: input.sourceInstanceId,
    sourceService: input.sourceService,
    dataClassification: input.dataClassification,
    requirementIds: input.requirementIds,
    payload: input.payload,
  };
  assertValidEnvelope(event);
  return event;
}

/** Writes a validated event to the outbox. MUST be called inside a transaction. */
export async function emitEvent<TPayload>(
  tx: Tx,
  input: EmitEventInput<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const event = buildEvent(input);

  await tx.insert(outbox).values({
    id: newId(),
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateSequence: BigInt(event.aggregateSequence),
    payload: event as unknown as Record<string, unknown>,
    requirementIds: event.requirementIds,
    occurredAt: new Date(event.occurredAt),
    recordedAt: new Date(event.recordedAt),
    publishedAt: null,
  });

  return event;
}

/**
 * Next sequence number for an aggregate. The unique index on
 * (aggregate_type, aggregate_id, aggregate_sequence) is what actually enforces
 * correctness — concurrent writers collide there and the loser retries.
 */
export async function nextAggregateSequence(
  tx: Tx,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const rows = await tx.execute<{ next: string }>(
    sql`SELECT COALESCE(MAX(${outbox.aggregateSequence}), 0) + 1 AS next
        FROM ${outbox}
        WHERE ${outbox.aggregateType} = ${aggregateType}
          AND ${outbox.aggregateId} = ${aggregateId}`,
  );
  const first = (rows as unknown as Array<{ next: string | number }>)[0];
  return Number(first?.next ?? 1);
}
