/**
 * Browser fallback backend.
 *
 * This backend doesn't actually grind on the server. Instead, it returns
 * `use_client_fallback` instructions with JavaScript code the client can
 * run locally using @noble/secp256k1.
 *
 * This is always available and serves as the last resort in the priority
 * chain when no server-side compute backends (GPU, rana) are available.
 */

import type { GrindBackend, GrindParams, GrindResult } from "../types.js";
import type { Logger } from "./types.js";
import { consoleLogger } from "./types.js";

/**
 * JavaScript code snippet for client-side offset grinding.
 *
 * The client uses @noble/secp256k1 to compute P + d·G for incrementing d,
 * bech32-encodes the result, and checks for the vanity pattern.
 */
const BROWSER_GRIND_SNIPPET = `
// Client-Side Vanity NPUB Offset Grinding
// Uses offset math: P + d·G (server never sees your secret key)
//
// Install: npm install @noble/secp256k1 bech32

import { secp256k1 } from '@noble/secp256k1';
import { bech32 } from 'bech32';

// Your existing keypair (keep nsec private!)
const privateKey = /* your 32-byte private key hex */;
const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed

// Vanity pattern to search for
const vanityPattern = 'YOUR_PATTERN_HERE';
const suffixPattern = null; // or 'suffix' if desired

// Grinding loop: P + d·G for d = 1, 2, 3, ...
let d = 1n;
const G = secp256k1.Point.BASE;
const P = secp256k1.Point.fromHex(publicKey);

while (true) {
  const newPoint = P.add(G.multiply(d));
  const xOnly = newPoint.toAffine().slice(0, 32); // x-only pubkey
  const npub = bech32.encode('npub', xOnly);

  if (npub.includes(vanityPattern) && (!suffixPattern || npub.endsWith(suffixPattern))) {
    console.log('Found!', { offset: d.toString(), vanity_npub: npub });
    break;
  }
  d++;
}

// Apply: new_nsec = (old_nsec + d) mod n
`;

/**
 * Browser fallback backend.
 *
 * Always available — returns instructions for client-side grinding
 * rather than performing any server-side computation.
 */
export class BrowserBackend implements GrindBackend {
  name = "browser" as const;
  available = true;
  estimatedRate = 5_000; // ~5K keys/sec in browser JS
  private readonly logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.logger = logger;
  }

  /**
   * Health check — browser backend is always available.
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Return client-side fallback instructions.
   *
   * Does not perform any grinding. Instead returns a GrindResult with
   * `found: false`, `backend: "browser"`, and `clientCode` containing
   * the JavaScript snippet the client should run locally.
   */
  async grind(params: GrindParams): Promise<GrindResult> {
    this.logger.info(
      `Browser fallback: returning client-side instructions for patterns [${params.vanityPatterns.join(", ")}]`
    );

    return {
      found: false,
      keysTried: 0,
      durationMs: 0,
      backend: "browser",
      fallbackReason:
        "No server-side compute backends available (GPU and/or rana not detected). " +
        "Grind locally in the browser using @noble/secp256k1.",
      clientCode: BROWSER_GRIND_SNIPPET,
    };
  }
}

/**
 * Factory: create a browser fallback backend instance.
 */
export function createBrowserBackend(logger?: Logger): BrowserBackend {
  return new BrowserBackend(logger);
}