import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startStub } from "../server.js";

let baseUrl: string;
let logPath: string;
let close: () => Promise<void>;

beforeAll(async () => {
  logPath = join(mkdtempSync(join(tmpdir(), "gate-")), "gate-log.jsonl");
  const started = await startStub({ port: 0, logPath, nonce: "n1" });
  baseUrl = `http://127.0.0.1:${started.port}/mcp`;
  close = started.close;
});

afterAll(async () => {
  await close();
});

async function connect() {
  const client = new Client({ name: "gate-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  // SDK 1.x transport declarations are not exactOptionalPropertyTypes-safe.
  await client.connect(transport as unknown as Transport);
  return client;
}

describe("gate stub", () => {
  it("lists exactly the two gate tools", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(["lease_job", "submit_result"]);
    await client.close();
  });

  it("lease_job returns the nonce-bound canned lease and logs the call", async () => {
    const client = await connect();
    const response = await client.callTool({
      name: "lease_job",
      arguments: {},
    });
    const body = JSON.parse(
      (response.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(body).toEqual({
      lease_id: "gate-lease-n1",
      input_hash: "gate-input-hash-n1",
      payload: {
        instruction: 'Return {"echo":"muster-gate-n1"} exactly.',
      },
    });
    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ tool: "lease_job" });
    expect(typeof lines.at(-1)!.at).toBe("string");
    await client.close();
  });

  it("submit_result accepts only a nonce-echoing result and logs args", async () => {
    const client = await connect();
    const response = await client.callTool({
      name: "submit_result",
      arguments: {
        lease_id: "gate-lease-n1",
        input_hash: "gate-input-hash-n1",
        result: { echo: "muster-gate-n1" },
      },
    });
    const body = JSON.parse(
      (response.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(body).toEqual({
      outcome: "accepted",
      lease_id: "gate-lease-n1",
    });
    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({
      tool: "submit_result",
      args: {
        lease_id: "gate-lease-n1",
        input_hash: "gate-input-hash-n1",
        result: { echo: "muster-gate-n1" },
      },
    });
    await client.close();
  });

  it("submit_result flags a wrong-nonce result", async () => {
    const client = await connect();
    const response = await client.callTool({
      name: "submit_result",
      arguments: {
        lease_id: "gate-lease-n1",
        input_hash: "gate-input-hash-n1",
        result: { echo: "muster-gate" },
      },
    });
    const body = JSON.parse(
      (response.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    expect(body).toEqual({
      outcome: "nonce_mismatch",
      lease_id: "gate-lease-n1",
    });
    await client.close();
  });
});
