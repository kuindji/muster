import type {
  PostgresStoreOptions,
  QueryablePool,
  TransactionOptions,
} from "./config.js";
import { validatePostgresStoreOptions } from "./config.js";

/**
 * PostgreSQL Store adapter connection boundary.
 *
 * Task 1 intentionally provides no frozen Store methods. Domain persistence
 * starts only after the migration/bootstrap foundation in Task 2.
 */
export class PostgresStore {
  readonly schema: string;
  readonly quotedSchema: string;
  readonly transactionOptions: Readonly<TransactionOptions>;
  readonly #pool: QueryablePool;

  constructor(options: PostgresStoreOptions) {
    const validated = validatePostgresStoreOptions(options);
    this.#pool = validated.pool;
    this.schema = validated.schema;
    this.quotedSchema = validated.quotedSchema;
    this.transactionOptions = validated.transaction;
    Object.freeze(this);
  }

  /** Internal adapter access; ownership and shutdown remain with the caller. */
  protected get pool(): QueryablePool {
    return this.#pool;
  }
}
