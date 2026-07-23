/**
 * MCP tool definition for `grind_npub`.
 *
 * This tool accepts a user's public key (npub) and a vanity pattern,
 * then dispatches to the appropriate grinding backend (GPU → Rana → Browser fallback).
 *
 * Phase 1: returns `use_client_fallback` with instructions for client-side grinding.
 * Phase 6: adds `payment_required` status when the calculated cost exceeds
 *   the client's `max_cost_sats` budget. The response includes a Lightning
 *   invoice and/or Cashu HTLC request and a SHA256(d) hash commitment for
 *   atomic swap (ADR-008).
 */

import { z } from "zod";
import type { GrindNpubParams, GrindNpubResult } from "../types.js";
import {
  calculatePrice,
  isFreePattern,
  pricingConfigFromServer,
} from "../payment/pricing.js";
import { createLightningPayment } from "../payment/lightning.js";
import { createCashuPayment } from "../payment/cashu.js";

// Note: buildAtomicSwapOffer from "../payment/atomic-swap.js" will be used
// in the V2 atomic swap flow when server-side backends are available.
// It's intentionally not imported here yet to satisfy noUnusedLocals.

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
 * Phase 6 addition: checks pricing before grinding. If the pattern difficulty
 * exceeds the free threshold and the cost exceeds `max_cost_sats`, returns
 * `payment_required` with a Lightning invoice and/or Cashu HTLC request.
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

  // ── Phase 6: Pricing check ──────────────────────────────────────────
  //
  // Calculate the cost of grinding this pattern. If it exceeds the client's
  // max_cost_sats budget, return `payment_required` with payment instructions.
  const scanEntropy = params.options?.min_z_score !== undefined && params.options.min_z_score > 0;
  const pricingConfig = pricingConfigFromServer({
    freeThreshold: parseInt(process.env.VNAAS_FREE_THRESHOLD ?? "8", 10),
    satsPerBit: parseInt(process.env.VNAAS_SATS_PER_BIT ?? "10", 10),
  });
  const costSats = calculatePrice(params.vanity_pattern, scanEntropy, pricingConfig);

  if (costSats > 0) {
    const maxCostSats = params.options?.max_cost_sats ?? 0;

    if (maxCostSats > 0 && costSats > maxCostSats) {
      // Cost exceeds budget — return payment_required
      const result: GrindNpubResult = {
        status: "payment_required",
        invoice: undefined,
        hash_commitment: undefined,
      };

      // Try to generate a Lightning invoice
      const lnBackend = (process.env.VNAAS_LN_BACKEND as "lnd" | "lnurl" | "none") ?? "none";
      if (lnBackend !== "none") {
        try {
          const ln = createLightningPayment(lnBackend, process.env.VNAAS_LN_NODE_URL);
          const invoiceResult = await ln.createInvoice(
            costSats,
            `Vanity NPUB grinding: pattern "${params.vanity_pattern}"`
          );
          result.invoice = invoiceResult.invoice;
        } catch {
          // Lightning not available — fall through to Cashu
        }
      }

      // Try to provide a Cashu HTLC request as alternative
      const cashuMintUrl = process.env.VNAAS_CASHU_MINT_URL ?? "https://mint.minibits.cash";
      const enablePayments = process.env.VNAAS_ENABLE_PAYMENTS === "true";
      if (enablePayments && !result.invoice) {
        // Provide Cashu mint info so the client can prepare a token
        const cashu = createCashuPayment(cashuMintUrl);
        // For V1 (simple): just tell the client the price and mint
        // For V2 (atomic): the server would grind first, then build an offer
        // Since we don't have a backend yet, we provide the V1 payment request
        result.invoice = JSON.stringify({
          type: "cashu_v1",
          mint: cashu.mintUrl,
          amount: costSats,
          description: `Vanity NPUB grinding: pattern "${params.vanity_pattern}"`,
        });
      }

      // If no payment method is available, return the cost info anyway
      if (!result.invoice) {
        result.invoice = JSON.stringify({
          type: "payment_request",
          amount_sats: costSats,
          message: "No payment backend configured. Contact the server operator.",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                cost_sats: costSats,
                max_cost_sats: maxCostSats,
                pattern: params.vanity_pattern,
                difficulty_bits: params.vanity_pattern.length * 5,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Cost is within budget but non-zero — would proceed to grind after payment
    // For now, since no backends are available, fall through to browser fallback
    // with a note about the cost.
  }

  // ── Phase 1: Browser fallback ───────────────────────────────────────
  //
  // No server-side compute backends available yet. Return client-side
  // grinding instructions.
  const result: GrindNpubResult = {
    status: "use_client_fallback",
    fallback_reason:
      "No server-side compute backends available yet (Phase 1). " +
      "Grind locally in the browser using @noble/secp256k1.",
  };

  // If the pattern is not free, note the cost
  if (!isFreePattern(params.vanity_pattern, pricingConfig)) {
    result.fallback_reason += ` (Estimated cost: ${costSats} sats for paid grinding when backends are available.)`;
  }

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