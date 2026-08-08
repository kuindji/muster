import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  runTask8StoreConformance,
  runTask9ProtocolConformance,
} from "@kuindji/muster-core";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const execute = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(resolve(packageRoot, ".packed-test-"));
const schemas = [];
let container;
let pool;

const quoteSchema = (schema) => {
  if (!/^muster_pack_[a-f0-9]{32}$/.test(schema)) {
    throw new TypeError(`invalid packed-test schema ${schema}`);
  }
  return `"${schema}"`;
};

try {
  const { stdout } = await execute(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot },
  );
  const packResult = JSON.parse(stdout);
  const filename = packResult[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not return a package filename");
  }
  await execute("tar", ["-xzf", resolve(temporaryRoot, filename)], {
    cwd: temporaryRoot,
  });

  const packed = await import(
    pathToFileURL(resolve(temporaryRoot, "package", "dist", "index.js")).href
  );
  for (const name of [
    "PostgresStore",
    "migrateMusterPostgres",
    "bootstrapMusterPostgres",
  ]) {
    if (typeof packed[name] !== "function") {
      throw new TypeError(`packed export ${name} is missing`);
    }
  }

  const explicitConnectionUrl = process.env.MUSTER_POSTGRES_TEST_URL;
  let connectionString = explicitConnectionUrl;
  if (connectionString === undefined || connectionString === "") {
    container = await new PostgreSqlContainer(
      process.env.MUSTER_POSTGRES_TEST_IMAGE || "postgres:16-alpine",
    ).start();
    connectionString = container.getConnectionUri();
  }
  pool = new Pool({ connectionString, max: 12 });

  const schemaFixtures = JSON.parse(
    await readFile(
      resolve(packageRoot, "..", "contract", "fixtures", "schema-conformance.json"),
      "utf8",
    ),
  );
  const promptInjections = JSON.parse(
    await readFile(
      resolve(packageRoot, "..", "contract", "fixtures", "prompt-injection.json"),
      "utf8",
    ),
  );
  const fixtures = {
    schemas: schemaFixtures.schemas,
    promptInjections,
  };

  const createRestartingStore = async () => {
    const schema = `muster_pack_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await pool.query(`CREATE SCHEMA ${quoteSchema(schema)}`);
    await packed.migrateMusterPostgres({ pool, schema });
    await packed.bootstrapMusterPostgres({
      pool,
      schema,
      initialQueue: {
        mode: "normal",
        updatedAt: "2026-08-08T10:00:00.000Z",
      },
    });
    return new Proxy({}, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        return (...arguments_) => {
          const restarted = new packed.PostgresStore({ pool, schema });
          const method = Reflect.get(restarted, property);
          if (typeof method !== "function") {
            throw new TypeError(`PostgresStore.${String(property)} is not callable`);
          }
          return Reflect.apply(method, restarted, arguments_);
        };
      },
    });
  };

  const storeCases = await runTask8StoreConformance(createRestartingStore);
  const protocolCases = await runTask9ProtocolConformance(
    createRestartingStore,
    fixtures,
  );
  if (storeCases.length === 0 || protocolCases.length === 0) {
    throw new Error("packed conformance suites returned no cases");
  }
  process.stdout.write(
    `packed PostgreSQL conformance ok (${storeCases.length} Store, ${protocolCases.length} protocol)\n`,
  );
} finally {
  if (pool !== undefined) {
    for (const schema of schemas) {
      await pool.query(`DROP SCHEMA ${quoteSchema(schema)} CASCADE`);
    }
    await pool.end();
  }
  await container?.stop();
  const expectedPrefix = `${packageRoot}${sep}.packed-test-`;
  if (!temporaryRoot.startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove unexpected path ${temporaryRoot}`);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
