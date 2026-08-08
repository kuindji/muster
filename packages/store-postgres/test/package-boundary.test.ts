import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as packageExports from "../src/index.js";

describe("package boundary", () => {
  it("declares ESM, CommonJS, and type exports", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<
        string,
        { import: string; require: string; types: string }
      >;
    };
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
  });

  it("exports the connection, migration, and bootstrap boundaries", () => {
    expect(packageExports.PostgresStore).toBeTypeOf("function");
    expect(packageExports.migrateMusterPostgres).toBeTypeOf("function");
    expect(packageExports.bootstrapMusterPostgres).toBeTypeOf("function");
  });

  it("contains no staged Store stubs, core policy evaluators, or OAuth subjects", async () => {
    const source = await readFile(
      new URL("../src/postgres-store.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/notImplemented|not_implemented/);
    expect(source).not.toMatch(
      /ReputationPolicy|privacyLedgerEntry|privacyNotificationContent|\.assess\(/,
    );
    expect(source).not.toMatch(
      /oauthSubject|oauth_subject|rawOAuth|raw_oauth|subjectId|subject_id/i,
    );
  });
});
