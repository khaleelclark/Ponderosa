export class CoordinationIdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key collision");
    this.name = "CoordinationIdempotencyConflictError";
  }
}
