import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const fail = (msg) => {
  console.error(`INVARIANT VIOLATION: ${msg}`);
  process.exitCode = 1;
};

// --- §4.1: muster-contract has zero runtime dependencies ---
const contractPkgPath = "packages/contract/package.json";
if (!existsSync(contractPkgPath)) fail(`${contractPkgPath} missing`);
else {
  const pkg = JSON.parse(readFileSync(contractPkgPath, "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length > 0)
    fail(`muster-contract has runtime dependencies: ${deps.join(", ")}`);
}

// --- §4.1 + §8.3: muster-core has exactly one runtime dependency ---
const corePkgPath = "packages/core/package.json";
if (existsSync(corePkgPath)) {
  const pkg = JSON.parse(readFileSync(corePkgPath, "utf8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length !== 1 || deps[0] !== "@kuindji/muster-contract")
    fail(
      `muster-core runtime deps must be exactly [\"@kuindji/muster-contract\"], got: ${JSON.stringify(deps)}`,
    );
}

// --- §8.3: no network or filesystem API references in contract/core sources ---
const FORBIDDEN = [
  /from\s+["']node:/,
  /require\(\s*["']node:/,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /from\s+["']fs["']/,
  /from\s+["']http["']/,
  /from\s+["']net["']/,
  /\bprocess\.env\b/,
  /\bDeno\./,
  /import\s*\(/,
];
function scan(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      scan(p);
      continue;
    }
    if (!/\.(ts|js|mjs|cjs)$/.test(entry)) continue;
    const text = readFileSync(p, "utf8");
    for (const re of FORBIDDEN)
      if (re.test(text)) fail(`${p} matches forbidden pattern ${re}`);
  }
}
scan("packages/contract/src");
scan("packages/core/src");

// --- Revision 12 §2/§7: raw OAuth identity stops at muster-mcp ---
const CORE_IDENTITY_FORBIDDEN = [
  /\bAuthenticatedWorkerSubject\b/,
  /\bworkerSubject\b/,
  /\bissuer\s*:/,
  /\bsubject\s*:/,
];
function scanCoreIdentity(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      scanCoreIdentity(p);
      continue;
    }
    if (!/\.(ts|js|mjs|cjs)$/.test(entry)) continue;
    const text = readFileSync(p, "utf8");
    for (const re of CORE_IDENTITY_FORBIDDEN)
      if (re.test(text))
        fail(`${p} leaks raw OAuth identity into core via ${re}`);
  }
}
scanCoreIdentity("packages/core/src");

if (process.exitCode !== 1) console.log("invariants ok");
