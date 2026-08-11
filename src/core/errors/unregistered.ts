/**
 * Failures the approved error catalog does not cover yet.
 *
 * errors.json defines six codes. Real HTTP services need more than six — not
 * found, unauthenticated, malformed body. Rather than quietly reusing a code
 * that means something else, these are returned with an explicitly unregistered
 * code and a flag saying so, which keeps the gap visible in responses and logs
 * instead of hiding it behind a plausible-looking one.
 */
import { registerContractGap } from "../spec/contract-gap.js";

registerContractGap({
  operation: "rate limiting across multiple instances",
  missingArtifacts: [
    "errors.json entry for rate limit exceeded (429)",
    "shared rate-limit store contract for horizontal scaling",
  ],
  blockedRequirementIds: ["SEC-006"],
  notes:
    "Rate limiting is in-memory, so the limit applies per process. Running more than one " +
    "instance multiplies the effective limit by the instance count. A shared store (Redis " +
    "or equivalent) is needed before scaling horizontally, and the 429 response currently " +
    "uses an unregistered code.",
});

registerContractGap({
  operation: "general error catalog coverage",
  missingArtifacts: [
    "errors.json entries for: authentication required, permission denied, resource not found, request body invalid",
  ],
  blockedRequirementIds: ["DEV-AI-001"],
  notes:
    "Responses using these codes carry specificationRegistered=false so consumers can tell " +
    "contract-backed errors from provisional ones.",
});

export class UnregisteredError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly unregisteredCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "UnregisteredError";
  }

  toBody(correlationId: string): Record<string, unknown> {
    return {
      code: this.unregisteredCode,
      message: this.message,
      specificationRegistered: false,
      correlationId,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}
