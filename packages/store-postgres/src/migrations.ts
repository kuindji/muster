import type { InMemoryStoreOptions } from "@kuindji/muster-core";
import type { PostgresStoreOptions } from "./config.js";
import { validatePostgresStoreOptions } from "./config.js";
import { PostgresInfrastructureError } from "./errors.js";

export interface MigrateMusterPostgresOptions extends PostgresStoreOptions {}

export interface BootstrapMusterPostgresOptions extends PostgresStoreOptions {
  readonly initialQueue: InMemoryStoreOptions["initialQueue"];
}

/** Exported deployment boundary; forward migration mechanics begin in Task 2. */
export async function migrateMusterPostgres(
  options: MigrateMusterPostgresOptions,
): Promise<never> {
  validatePostgresStoreOptions(options);
  throw new PostgresInfrastructureError(
    "migration_not_implemented",
    "PostgreSQL migrations are not implemented until Store adapter Task 2",
  );
}

/** Exported deployment boundary; queue bootstrap semantics begin in Task 2. */
export async function bootstrapMusterPostgres(
  options: BootstrapMusterPostgresOptions,
): Promise<never> {
  validatePostgresStoreOptions(options);
  void options.initialQueue;
  throw new PostgresInfrastructureError(
    "bootstrap_not_implemented",
    "PostgreSQL bootstrap is not implemented until Store adapter Task 2",
  );
}
