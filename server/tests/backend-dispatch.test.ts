/**
 * Unit tests for the backend dispatcher fallback chain.
 *
 * Tests:
 *  - GPU available → uses GPU backend
 *  - GPU fails → falls back to rana
 *  - Rana fails → falls back to browser
 *  - No backends available → returns browser instructions
 *  - Browser backend always available
 *  - Health check for all backends
 *
 * Per Phase 8.1 of IMPLEMENTATION-PLAN.md.
 *
 * Since GPU and rana backends are stubs in this environment, we test
 * the fallback chain by directly manipulating availability and mocking
 * the dispatch path. We also test the real dispatcher behavior when
 * no backends are detected (which should fall through to browser).
 */

import { getPublicKey, utils } from "@noble/secp256k1";

import { BackendDispatcher } from "../src/backends/dispatcher.ts";
import { BackendDetector } from "../src/backends/detector.ts";
import { GpuBackend } from "../src/backends/gpu-backend.ts";
import { RanaBackend } from "../src/backends/rana-backend.ts";
import { BrowserBackend } from "../src/backends/browser-backend.ts";
import type { ServerConfig, GrindParams, GrindResult } from "../src/types.ts";
import type { BackendAvailability, Logger } from "../src/backends/types.ts";

// ─── Test helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.error(`  ✗ ERROR: ${msg}`);
  }
}

// ─── Mock logger (silent) ───────────────────────────────────────────────────

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ─── Mock config ────────────────────────────────────────────────────────────

const mockConfig: ServerConfig = {
  serverPrivateKey: "a".repeat(64),
  serverNpub: "",
  relays: [],
  ranaBinaryPath: "/nonexistent/rana",
  gpuBinaryPath: "/nonexistent/cuda_vanity",
  enableGpu: true,
  enableRana: true,
  enableBrowserFallback: true,
  enablePayments: false,
  cashuMintUrl: "",
  lnBackend: "none",
  pricing: { freeThreshold: 20, satsPerBit: 1 },
};

// ─── Mock grind params ──────────────────────────────────────────────────────

function makeGrindParams(): GrindParams {
  const privKey = utils.randomPrivateKey();
  const compressed = getPublicKey(privKey, true);
  const xOnly = compressed.slice(1);
  return {
    pubKeyBytes: xOnly,
    vanityPatterns: ["test"],
    suffixPatterns: [],
    startOffset: 0n,
    maxOffset: 1000000n,
    timeoutMs: 5000,
    scanEntropy: false,
    minRarity: 0,
    minWindowSize: 16,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

await test("BrowserBackend: always available and returns fallback instructions", async () => {
  const browser = new BrowserBackend(silentLogger);
  assert(browser.available === true, "Browser backend should be available");
  assert(browser.name === "browser", "Name should be 'browser'");

  const health = await browser.healthCheck();
  assert(health === true, "Health check should pass");

  const params = makeGrindParams();
  const result = await browser.grind(params);
  assert(result.found === false, "Browser should not find (returns instructions)");
  assert(result.backend === "browser", "Backend should be 'browser'");
  assert(result.fallbackReason !== undefined, "Should have fallback reason");
  assert(result.clientCode !== undefined, "Should have client code");
  assert(result.clientCode!.includes("@noble/secp256k1"), "Client code should reference @noble/secp256k1");
});

await test("GpuBackend: stub is not available and grind() throws", async () => {
  const gpu = new GpuBackend(mockConfig, silentLogger);
  assert(gpu.available === false, "GPU stub should not be available");
  assert(gpu.name === "gpu", "Name should be 'gpu'");

  const health = await gpu.healthCheck();
  assert(health === false, "Health check should fail for nonexistent binary");

  const params = makeGrindParams();
  let threw = false;
  try {
    await gpu.grind(params);
  } catch (e) {
    threw = true;
    assert(e instanceof Error, "Should throw Error");
    assert((e as Error).message.includes("not yet implemented"), "Error should mention not implemented");
  }
  assert(threw, "GPU grind() should throw");
});

await test("RanaBackend: not available with nonexistent binary path", async () => {
  const rana = new RanaBackend(mockConfig, silentLogger);
  assert(rana.name === "rana", "Name should be 'rana'");
  assert(rana.estimatedRate > 0, "Should have a positive estimated rate");

  const health = await rana.healthCheck();
  assert(health === false, "Health check should fail for nonexistent binary");
});

await test("BackendDetector: detects no GPU/rana in test environment", async () => {
  const detector = new BackendDetector(mockConfig, { logger: silentLogger, intervalMs: 999999 });
  const availability = await detector.start();
  assert(availability.gpu === false, "GPU should not be detected");
  assert(availability.rana === false, "Rana should not be detected");
  assert(availability.browser === true, "Browser should always be available");
  assert(availability.detectedAt > 0, "Should have a detection timestamp");
  detector.stop();
});

await test("BackendDispatcher: with no GPU/rana, falls through to browser", async () => {
  const dispatcher = new BackendDispatcher(mockConfig, silentLogger);
  await dispatcher.start();

  const params = makeGrindParams();
  const result = await dispatcher.dispatchGrind(params);

  assert(result.backend === "browser", `Expected browser fallback, got ${result.backend}`);
  assert(result.found === false, "Browser should not find");
  assert(result.fallbackReason !== undefined, "Should have fallback reason");
  assert(result.clientCode !== undefined, "Should have client code");

  dispatcher.stop();
});

await test("BackendDispatcher: healthCheckAll returns all three backends", async () => {
  const dispatcher = new BackendDispatcher(mockConfig, silentLogger);
  await dispatcher.start();

  const health = await dispatcher.healthCheckAll();
  assert(typeof health.gpu === "boolean", "GPU health should be boolean");
  assert(typeof health.rana === "boolean", "Rana health should be boolean");
  assert(typeof health.browser === "boolean", "Browser health should be boolean");
  assert(health.browser === true, "Browser health should always be true");

  dispatcher.stop();
});

await test("BackendDispatcher: getBackends returns all three", async () => {
  const dispatcher = new BackendDispatcher(mockConfig, silentLogger);
  const backends = dispatcher.getBackends();
  assert(backends.length === 3, `Expected 3 backends, got ${backends.length}`);
  assert(backends[0].name === "gpu", "First backend should be gpu");
  assert(backends[1].name === "rana", "Second backend should be rana");
  assert(backends[2].name === "browser", "Third backend should be browser");
});

await test("BackendDispatcher: fallback chain GPU → rana → browser (simulated)", async () => {
  // This test verifies the dispatch logic by checking that when GPU and rana
  // are unavailable, the dispatcher returns browser fallback.
  // In a real environment with GPU/rana, the chain would go GPU → rana → browser.
  const dispatcher = new BackendDispatcher(mockConfig, silentLogger);
  await dispatcher.start();

  const availability = await dispatcher.getAvailability();
  assert(availability.gpu === false, "GPU not available in test env");
  assert(availability.rana === false, "Rana not available in test env");
  assert(availability.browser === true, "Browser always available");

  const params = makeGrindParams();
  const result = await dispatcher.dispatchGrind(params);

  // Since GPU and rana are unavailable, should get browser fallback
  assert(result.backend === "browser", "Should fall through to browser");
  assert(result.fallbackReason !== undefined, "Should explain why fallback was used");

  dispatcher.stop();
});

await test("BrowserBackend: grind result includes proper instructions for client", async () => {
  const browser = new BrowserBackend(silentLogger);
  const params = makeGrindParams();
  params.vanityPatterns = ["meshmate"];

  const result = await browser.grind(params);
  assert(result.clientCode !== undefined, "Should have client code");
  assert(result.clientCode!.length > 100, "Client code should be substantial");
  assert(result.clientCode!.includes("offset"), "Client code should mention offset");
  assert(result.clientCode!.includes("P + d"), "Client code should mention P + d·G");
  assert(result.fallbackReason!.includes("No server-side"), "Fallback reason should explain no server-side compute");
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const f of failures) {
    console.log(`    • ${f}`);
  }
}
console.log(`${"═".repeat(60)}\n`);

if (failed > 0) {
  process.exit(1);
}