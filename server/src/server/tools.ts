/**
 * MCP tool definition for `grind_npub`.
 *
 * This tool accepts a user's public key (npub) and a vanity pattern,
 * then dispatches to the appropriate grinding backend (GPU → Rana → Browser fallback).
 *
 * In Phase 1, only the browser fallback path is implemented — the server returns
 * `use_client_fallback` with instructions for client-side grinding.
 */

import { z } from "zod";
import type { GrindNpubParams, GrindNpubResult } from "../types.js";

/**
 * Zod schema for the grind_npub tool input parameters.
 */
export const grindNpubSchema = {
  npub: z.string().describe("Your public key (npub1...)"),
  vanity_pattern: z.string().describe("Desired vanity word/prefix in the NPUB"),
  options: z
    .object({
      suffix: z.string().optional().describe("Also match a suffix pattern"),
      min_z_score: z.number().optional().describe("Minimum entropy outlier z-score (ADR-003)"),
      min_window_size: z.number().optional().describe("Minimum fingerprint window size (16|25|36|49)"),
      timeout_secs: z.number().optional().describe("Max grind time in seconds (default: 300)"),
      max_cost_sats: z.number().optional().describe("Max willing to pay in sats"),
    })
    .optional(),
};

/**
 * Handle a grind_npub tool call.
 *
 * Phase 1 implementation: returns `use_client_fallback` since no server-side
 * compute backends are wired up yet. The browser fallback provides JavaScript
 * code the client can run locally using @noble/secp256k1.
 *
 * @param args - Parsed tool arguments
 * @returns Tool result as MCP CallToolResult content
 */
export async function handleGrindNpub(
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const params = args as unknown as GrindNpubParams;

  // Validate npub format
  if (!params.npub?.startsWith("npub1")) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: "Invalid npub: must start with 'npub1'",
          } satisfies GrindNpubResult & { message: string }),
        },
      ],
      isError: true,
    };
  }

  // Validate vanity pattern
  if (!params.vanity_pattern || params.vanity_pattern.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            message: "vanity_pattern is required and must not be empty",
          } satisfies GrindNpubResult & { message: string }),
        },
      ],
      isError: true,
    };
  }

  // Phase 1: return browser fallback instructions
  const result: GrindNpubResult = {
    status: "use_client_fallback",
    fallback_reason:
      "No server-side compute backends available yet (Phase 1). " +
      "Grind locally in the browser using @noble/secp256k1.",
  };

  // Include client-side grinding instructions
  const clientInstructions = `
# Client-Side Vanity NPUB Grinding

Since the server has no GPU or Rana backends available yet, you can grind
your vanity NPUB locally. Here's how:

\`\`\`javascript
import { secp256k1 } from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { encode as bech32Encode } from 'bech32';

// Your existing keypair (keep nsec private!)
const privateKey = /* your 32-byte private key */;
const publicKey = secp256k1.getPublicKey(privateKey, true); // x-only (33 bytes, first byte 0x02/0x03)

// Vanity pattern to search for
const vanityPattern = '${params.vanity_pattern}';
const suffixPattern = ${params.options?.suffix ? `'${params.options.suffix}'` : "null"};

// Grinding loop: P + d·G for d = 1, 2, 3, ...
let d = 1n;
const G = secp256k1.Point.BASE;
const P = secp256k1.Point.fromAffine(
  secp256k1.getPublicKey(privateKey, true).slice(1) // strip parity byte
);

while (true) {
  const newPoint = P.add(G.multiply(d));
  const newPubkey = newPoint.toAffine().slice(0, 32); // x-only
  const npub = bech32Encode('npub', newPubkey);

  if (npub.includes(vanityPattern) && (!suffixPattern || npub.endsWith(suffixPattern))) {
    console.log('Found!', { offset: d.toString(), vanity_npub: npub });
    break;
  }
  d++;
}
\`\`\`

**Important**: The server never sees your secret key. The offset \`d\` is applied
client-side: \`new_nsec = (old_nsec + d) mod n\`.
`;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
      {
        type: "text",
        text: clientInstructions,
      },
    ],
  };
}

/**
 * The grind_npub MCP tool definition object.
 * Used for registration with the MCP server.
 */
export const grindNpubTool = {
  name: "grind_npub",
  description:
    "Grind a vanity NPUB offset for a public key using offset grinding (P + d·G). " +
    "The server never sees your secret key. Returns an offset integer you add to your nsec. " +
    "Dispatches to GPU, CPU (rana), or instructs client to grind in-browser.",
  inputSchema: grindNpubSchema,
  handler: handleGrindNpub,
};