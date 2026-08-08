import { describe, expect, it } from "vitest";
import {
  createMusterMcpConfig,
  type MusterMcpConfigInput,
} from "../src/index.js";
import { validConfigInput } from "./helpers.js";

describe("MCP immutable configuration", () => {
  it("normalizes and recursively freezes the reviewed boundary", () => {
    const config = createMusterMcpConfig(validConfigInput());
    expect(config.resourceUrl).toBe("https://muster.example/mcp");
    expect(config.resourceOrigin).toBe("https://muster.example");
    expect(config.allowedOrigins).toEqual(["https://client.example"]);
    expect(config.protectedResourceMetadataPaths).toEqual([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.authorizationServers)).toBe(true);
    expect(Object.isFrozen(config.authorizationServers[0])).toBe(true);
    expect(Object.isFrozen(config.toolDescriptions)).toBe(true);
  });

  it.each([
    ["insecure resource", { resourceUrl: "http://muster.example/mcp" }],
    ["path mismatch", { endpointPath: "/other" }],
    ["audience mismatch", { audience: "https://muster.example/other" }],
    ["missing issuers", { authorizationServers: [] }],
    ["insecure origin", { allowedOrigins: ["http://client.example/"] }],
    ["small body limit", { bodyLimitBytes: 1_023 }],
    ["large clock skew", { clockSkewSeconds: 301 }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      createMusterMcpConfig({ ...validConfigInput(), ...change }),
    ).toThrow(RangeError);
  });

  it("rejects duplicate issuers, open algorithms, and open descriptions", () => {
    const input = validConfigInput();
    expect(() =>
      createMusterMcpConfig({
        ...input,
        authorizationServers: [
          ...input.authorizationServers,
          input.authorizationServers[0]!,
        ],
      }),
    ).toThrow(/duplicate issuer/);
    expect(() =>
      createMusterMcpConfig({
        ...input,
        authorizationServers: [
          {
            ...input.authorizationServers[0]!,
            algorithms: ["HS256"],
          },
        ] as unknown as MusterMcpConfigInput["authorizationServers"],
      }),
    ).toThrow(/closed JWT set/);
    expect(() =>
      createMusterMcpConfig({
        ...input,
        toolDescriptions: {
          ...input.toolDescriptions,
          extra: "not frozen",
        } as typeof input.toolDescriptions,
      }),
    ).toThrow(/exactly the frozen tool names/);
    expect(() =>
      createMusterMcpConfig({
        ...input,
        toolDescriptions: {
          ...input.toolDescriptions,
          lease_job: "Deployment-controlled prompt text.",
        },
      }),
    ).toThrow(/closed package value/);
  });
});
