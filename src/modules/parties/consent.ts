/**
 * Consent as the platform enforces it (CONSENT-002, CONSENT-003).
 *
 * CONSENT-001 requires record-level permitted uses. That only means something
 * if processing actually checks them, so this module is the single place that
 * answers "may we do X with this party's data right now" — and every caller
 * that processes personal data is expected to ask before acting.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { consentGrants } from "../../db/schema.js";
import { AppError } from "../../core/errors/app-error.js";

export const PERMITTED_USES = [
  "conservation_payment",
  "public_reporting",
  "research",
  "partner_sharing",
] as const;

export type PermittedUse = (typeof PERMITTED_USES)[number];

export const CONSENT_METHODS = [
  "written_signature",
  "thumbprint",
  "witnessed_verbal",
  "digital_signature",
] as const;

export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/**
 * Returns the uses a party has currently consented to, across all their live
 * grants. A withdrawn grant contributes nothing.
 */
export async function activePermittedUses(
  db: Database,
  partyId: string,
): Promise<Set<PermittedUse>> {
  const rows = await db
    .select({ permittedUses: consentGrants.permittedUses })
    .from(consentGrants)
    .where(and(eq(consentGrants.partyId, partyId), isNull(consentGrants.withdrawnAt)));

  const uses = new Set<PermittedUse>();
  for (const row of rows) {
    for (const use of row.permittedUses as PermittedUse[]) uses.add(use);
  }
  return uses;
}

/**
 * Throws unless the party has live consent covering `use`.
 *
 * Call this before processing, not after. The error is deliberately the same
 * whether consent was never given or has been withdrawn: from the party's
 * point of view the answer is identical, and distinguishing them would leak
 * that they once consented.
 */
export async function assertConsent(
  db: Database,
  partyId: string,
  use: PermittedUse,
): Promise<void> {
  const uses = await activePermittedUses(db, partyId);
  if (!uses.has(use)) {
    throw new AppError(
      "CONSENT_SCOPE_NOT_PERMITTED",
      `This party has not consented to '${use}', or has withdrawn that consent`,
      { partyId, attemptedUse: use },
    );
  }
}
