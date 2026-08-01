import { pgSchema, uuid, text, timestamp, jsonb, bigint, integer, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const core = pgSchema("core");
export const forests = pgSchema("forests");
export const events = pgSchema("events");

export const instances = core.table("instances", {
  id: uuid("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  canonicalUrl: text("canonical_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const projects = forests.table("projects", {
  id: uuid("id").primaryKey(),
  publicId: text("public_id").notNull().unique(),
  homeInstanceId: uuid("home_instance_id").notNull().references(() => instances.id),
  leadOrganizationId: uuid("lead_organization_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
});

export const outbox = events.table("outbox", {
  id: uuid("id").primaryKey(),
  eventId: uuid("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  aggregateSequence: bigint("aggregate_sequence", { mode: "bigint" }).notNull(),
  payload: jsonb("payload").notNull(),
  requirementIds: jsonb("requirement_ids").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (table) => [
  check("outbox_schema_version_check", sql`${table.schemaVersion} > 0`),
  check("outbox_aggregate_sequence_check", sql`${table.aggregateSequence} > 0`),
  uniqueIndex("uq_outbox_aggregate_sequence").on(
    table.aggregateType,
    table.aggregateId,
    table.aggregateSequence,
  ),
]);
