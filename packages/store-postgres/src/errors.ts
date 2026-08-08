export type PostgresInfrastructureErrorCode =
  | "invalid_configuration"
  | "connection_failed"
  | "client_release_failed"
  | "migration_not_implemented"
  | "bootstrap_not_implemented";

/** Adapter/infrastructure failures; never a frozen Store domain outcome. */
export class PostgresInfrastructureError extends Error {
  readonly code: PostgresInfrastructureErrorCode;

  constructor(
    code: PostgresInfrastructureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PostgresInfrastructureError";
    this.code = code;
  }
}
