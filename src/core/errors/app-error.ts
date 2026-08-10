/**
 * Errors are declared in the spec package (errors/errors.json), not here.
 * AppError only carries a code; the HTTP status and retryability are looked up
 * from the registry so the wire behavior can never drift from the contract.
 */
import { errorDefinitions, type ErrorDefinition } from "../spec/registry.js";

export class AppError extends Error {
  readonly definition: ErrorDefinition;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    const definition = errorDefinitions.get(code);
    if (!definition) {
      throw new Error(
        `Error code '${code}' is not in the approved error registry (errors/errors.json)`,
      );
    }
    this.definition = definition;
    this.details = details;
  }

  get code(): string {
    return this.definition.code;
  }

  get httpStatus(): number {
    return this.definition.httpStatus;
  }

  get retryable(): boolean {
    return this.definition.retryable;
  }

  toBody(correlationId: string): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      domain: this.definition.domain,
      retryable: this.retryable,
      requirementIds: this.definition.requirementIds,
      correlationId,
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}
