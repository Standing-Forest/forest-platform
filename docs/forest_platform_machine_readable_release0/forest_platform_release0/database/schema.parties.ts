import {
  pgSchema,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { instances } from "./schema.foundation.js";

export const parties = pgSchema("parties");

/**
 * A person or organization known to the platform (PARTY-001).
 *
 * Bitemporal per ARCH-003: valid_from/valid_to are real-world time,
 * recorded_at/superseded_at are system time. A correction supersedes a row and
 * inserts a new one; rows are never updated in place and never deleted, so the
 * platform can answer what it believed on the day a payment was authorized.
 */
export const partyRecords = parties.table(
  "parties",
  {
    id: uuid("id").primaryKey(),
    /** Stable identity across versions. `id` differs per version; this does not. */
    partyId: uuid("party_id").notNull(),
    homeInstanceId: uuid("home_instance_id")
      .notNull()
      .references(() => instances.id),
    partyType: text("party_type").notNull(),
    displayName: text("display_name").notNull(),
    community: text("community"),
    contact: jsonb("contact").notNull().default({}),
    identityEvidence: jsonb("identity_evidence").notNull().default([]),
    dataClassification: text("data_classification").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    check("parties_party_type_check", sql`${table.partyType} IN ('person', 'organization')`),
    check(
      "parties_data_classification_check",
      sql`${table.dataClassification} IN ('confidential', 'restricted', 'cultural_restricted')`,
    ),
    check(
      "parties_valid_period_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`,
    ),
    // Exactly one current version per party.
    uniqueIndex("uq_parties_current_version")
      .on(table.partyId)
      .where(sql`${table.supersededAt} IS NULL`),
    index("ix_parties_tenant").on(table.homeInstanceId),
  ],
);

/**
 * What a party agreed to, when, in what language and on what evidence
 * (CONSENT-002, CONSENT-003).
 *
 * Separate from the party record so consent can be withdrawn without rewriting
 * identity. Withdrawal sets withdrawn_at; rows are never deleted.
 */
export const consentGrants = parties.table(
  "consent_grants",
  {
    id: uuid("id").primaryKey(),
    homeInstanceId: uuid("home_instance_id")
      .notNull()
      .references(() => instances.id),
    partyId: uuid("party_id").notNull(),
    /** No FK: forests.parcels does not exist yet (GEO-001). */
    scopeParcelId: uuid("scope_parcel_id"),
    permittedUses: jsonb("permitted_uses").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    languageTag: text("language_tag").notNull(),
    method: text("method").notNull(),
    witnessPartyId: uuid("witness_party_id"),
    evidence: jsonb("evidence"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawalReason: text("withdrawal_reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "consent_grants_method_check",
      sql`${table.method} IN ('written_signature', 'thumbprint', 'witnessed_verbal', 'digital_signature')`,
    ),
    check(
      "consent_grants_permitted_uses_check",
      sql`jsonb_array_length(${table.permittedUses}) > 0`,
    ),
    // Literacy cannot be assumed, so witnessed verbal consent is supported —
    // but it is only meaningful if the witness is recorded.
    check(
      "consent_grants_witness_check",
      sql`${table.method} <> 'witnessed_verbal' OR ${table.witnessPartyId} IS NOT NULL`,
    ),
    index("ix_consent_grants_party").on(table.partyId),
    index("ix_consent_grants_active")
      .on(table.partyId)
      .where(sql`${table.withdrawnAt} IS NULL`),
  ],
);

/**
 * A party holds a role over a parcel for a period (LAND-001, LAND-002).
 *
 * This is where farmer, landowner and land controller are distinguished. The
 * role is a relationship, not a property of the person: one human is often both
 * farmer and landowner, and a controller is frequently neither the registered
 * owner nor the farmer.
 */
export const landRoles = parties.table(
  "land_roles",
  {
    id: uuid("id").primaryKey(),
    landRoleId: uuid("land_role_id").notNull(),
    homeInstanceId: uuid("home_instance_id")
      .notNull()
      .references(() => instances.id),
    partyId: uuid("party_id").notNull(),
    /**
     * No FK: forests.parcels does not exist yet (GEO-001). The reference is
     * therefore unenforced — see the contract gap of the same name.
     */
    parcelId: uuid("parcel_id").notNull(),
    role: text("role").notNull(),
    authorityBasis: text("authority_basis"),
    conveysAuthorityToCommit: boolean("conveys_authority_to_commit").notNull(),
    exclusive: boolean("exclusive").notNull().default(false),
    supportingEvidence: jsonb("supporting_evidence").notNull().default([]),
    assertedBy: uuid("asserted_by").notNull(),
    supersedesLandRoleId: uuid("supersedes_land_role_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "land_roles_role_check",
      sql`${table.role} IN ('farmer', 'landowner', 'land_controller')`,
    ),
    check(
      "land_roles_valid_period_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`,
    ),
    // A controller must say on what basis it holds authority.
    check(
      "land_roles_authority_basis_check",
      sql`${table.role} <> 'land_controller' OR ${table.authorityBasis} IS NOT NULL`,
    ),
    // Keep the derived flag honest: only these two roles convey authority.
    check(
      "land_roles_conveys_authority_check",
      sql`${table.conveysAuthorityToCommit} = (${table.role} IN ('landowner', 'land_controller'))`,
    ),
    uniqueIndex("uq_land_roles_current_version")
      .on(table.landRoleId)
      .where(sql`${table.supersededAt} IS NULL`),
    index("ix_land_roles_parcel").on(table.parcelId),
    index("ix_land_roles_party").on(table.partyId),
    // Only one *exclusive* holder of a role per parcel at a time. Non-exclusive
    // claims may overlap deliberately, so a genuine tenure dispute is recorded
    // rather than silently decided at the point of capture.
    uniqueIndex("uq_land_roles_exclusive_current")
      .on(table.parcelId, table.role)
      .where(sql`${table.exclusive} AND ${table.supersededAt} IS NULL AND ${table.validTo} IS NULL`),
  ],
);
