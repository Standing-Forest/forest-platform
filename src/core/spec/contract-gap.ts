/**
 * DEV-AI-001: coding agents may not invent missing contracts.
 *
 * Release 0 is explicitly a foundation package, not the complete production
 * contract set. Where an operation is declared but the artifacts needed to
 * implement it faithfully do not exist, we refuse at runtime with the error
 * the spec reserves for exactly this — SPECIFICATION_CONTRACT_MISSING (409) —
 * and name the missing artifacts precisely, rather than guessing at a shape
 * that would later conflict with the approved one.
 *
 * Every gap is registered here so the set is enumerable: see
 * `GET /internal/contract-gaps` and scripts/report-contract-gaps.ts.
 */
import { AppError } from "../errors/app-error.js";

export interface ContractGap {
  /** Operation or capability that is blocked. */
  operation: string;
  /** Spec artifacts that must exist before this can be implemented. */
  missingArtifacts: string[];
  /** Requirements that cannot be satisfied until the gap is closed. */
  blockedRequirementIds: string[];
  notes?: string;
}

const gaps = new Map<string, ContractGap>();

export function registerContractGap(gap: ContractGap): ContractGap {
  gaps.set(gap.operation, gap);
  return gap;
}

export function listContractGaps(): ContractGap[] {
  return [...gaps.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}

export function contractMissing(gap: ContractGap): AppError {
  registerContractGap(gap);
  return new AppError(
    "SPECIFICATION_CONTRACT_MISSING",
    `'${gap.operation}' is declared in the specification but cannot be implemented: ` +
      `the required contract artifacts do not exist in the approved package. ` +
      `Implementing it would require inventing them, which DEV-AI-001 forbids.`,
    {
      operation: gap.operation,
      missingArtifacts: gap.missingArtifacts,
      blockedRequirementIds: gap.blockedRequirementIds,
      ...(gap.notes ? { notes: gap.notes } : {}),
    },
  );
}
