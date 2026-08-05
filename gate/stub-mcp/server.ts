import express from "express";
import { appendFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

export async function startStub(options: {
  port: number;
  logPath: string;
  nonce: string;
}) {
  const { nonce } = options;
  if (existsSync(options.logPath)) {
    throw new Error(
      `${options.logPath} already exists — every gate attempt needs a fresh log`,
    );
  }

  const log = (tool: string, args: unknown) => {
    appendFileSync(
      options.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), nonce, tool, args })}\n`,
    );
  };

  const app = express();
  app.use(express.json());

  app.all("/mcp", async (request, response) => {
    // Stateless Streamable HTTP uses a fresh server and transport per request.
    const server = new McpServer({
      name: "muster-gate-stub",
      version: "0.0.1",
    });

    server.registerTool(
      "lease_job",
      {
        description: "Lease the single canned gate job.",
        inputSchema: {},
      },
      async () => {
        log("lease_job", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                lease_id: `gate-lease-${nonce}`,
                input_hash: `gate-input-hash-${nonce}`,
                payload: {
                  instruction: `Return {"echo":"muster-gate-${nonce}"} exactly.`,
                },
              }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "submit_result",
      {
        description: "Submit the canned gate result.",
        inputSchema: {
          lease_id: z.string(),
          input_hash: z.string(),
          result: z.object({ echo: z.string() }),
        },
      },
      async (args) => {
        const bound =
          args.lease_id === `gate-lease-${nonce}` &&
          args.input_hash === `gate-input-hash-${nonce}` &&
          args.result.echo === `muster-gate-${nonce}`;
        const outcome = bound ? "accepted" : "nonce_mismatch";
        log("submit_result", { ...args, outcome });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ outcome, lease_id: args.lease_id }),
            },
          ],
        };
      },
    );

    // The SDK documents explicit undefined as its stateless-mode switch, but
    // its declaration predates exactOptionalPropertyTypes compatibility.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<
      typeof StreamableHTTPServerTransport
    >[0]);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, request.body);
  });

  const listener = app.listen(options.port);
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

// Direct launch: `GATE_RUN_NONCE=<fresh> pnpm -F muster-gate-stub start`
if (process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 8787);
  const logPath = process.env.GATE_LOG_PATH ?? "./gate-log.jsonl";
  const nonce = process.env.GATE_RUN_NONCE;
  if (!nonce) {
    console.error("set GATE_RUN_NONCE to a fresh value for every gate attempt");
    process.exit(1);
  }
  startStub({ port, logPath, nonce }).then((started) => {
    console.log(
      `gate stub on :${started.port}/mcp, nonce ${nonce}, logging to ${logPath}`,
    );
  });
}
