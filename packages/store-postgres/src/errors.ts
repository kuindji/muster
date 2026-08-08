export type PostgresInfrastructureErrorCode =
  | "invalid_configuration"
  | "connection_failed"
  | "client_release_failed"
  | "invalid_database_encoding"
  | "invalid_stored_value"
  | "migration_asset_missing"
  | "migration_checksum_mismatch"
  | "migration_unknown"
  | "migration_failed"
  | "transaction_failed"
  | "transaction_retry_exhausted"
  | "unexpected_constraint_violation";

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
