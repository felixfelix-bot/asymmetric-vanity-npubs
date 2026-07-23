/**
 * Environment configuration for the VNAAS Grinder Server.
 *
 * Loads from environment variables with sensible defaults.
 * Never logs the private key.
 */

import type { ServerConfig } from "./types.js";

/**
 * Default Nostr relays for the server to listen on.
 */
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
];

/**
 * Load server configuration from environment variables.
 *
 * Required env vars:
 *   - VNAAS_SERVER_PRIVATE_KEY  — hex-encoded Nostr private key (nsec)
 *
 * Optional env vars (with defaults):
 *   - VNAAS_RELAYS              — comma-separated relay URLs
 *   - VNAAS_RANA_BINARY_PATH    — path to rana binary (default: "rana")
 *   - VNAAS_GPU_BINARY_PATH     — path to cuda_vanity binary (default: "cuda_vanity")
 *   - VNAAS_ENABLE_GPU          — "true"/"false" (default: "true")
 *   - VNAAS_ENABLE_RANA         — "true"/"false" (default: "true")
 *   - VNAAS_ENABLE_PAYMENTS     — "true"/"false" (default: "false")
 *   - VNAAS_CASHU_MINT_URL      — Cashu mint URL
 *   - VNAAS_LN_BACKEND          — "lnd" | "lnurl" | "none" (default: "none")
 */
export function loadConfig(): ServerConfig {
  const serverPrivateKey = process.env.VNAAS_SERVER_PRIVATE_KEY ?? "";
  if (!serverPrivateKey) {
    throw new Error(
      "VNAAS_SERVER_PRIVATE_KEY environment variable is required. " +
        "Generate a Nostr keypair and set this to the hex private key."
    );
  }

  const relays = process.env.VNAAS_RELAYS
    ? process.env.VNAAS_RELAYS.split(",").map((r) => r.trim()).filter(Boolean)
    : DEFAULT_RELAYS;

  // Derive npub from private key (lazy import to avoid circular deps)
  // We'll compute this at server startup, but store a placeholder here.
  const serverNpub = process.env.VNAAS_SERVER_NPUB ?? "";

  return {
    serverPrivateKey,
    serverNpub,
    relays,
    ranaBinaryPath: process.env.VNAAS_RANA_BINARY_PATH ?? "rana",
    gpuBinaryPath: process.env.VNAAS_GPU_BINARY_PATH ?? "cuda_vanity",
    enableGpu: process.env.VNAAS_ENABLE_GPU !== "false",
    enableRana: process.env.VNAAS_ENABLE_RANA !== "false",
    enableBrowserFallback: true,
    enablePayments: process.env.VNAAS_ENABLE_PAYMENTS === "true",
    cashuMintUrl:
      process.env.VNAAS_CASHU_MINT_URL ?? "https://mint.minibits.cash",
    lnBackend: (process.env.VNAAS_LN_BACKEND as "lnd" | "lnurl" | "none") ??
      "none",
    pricing: {
      freeThreshold: parseInt(
        process.env.VNAAS_FREE_THRESHOLD ?? "8",
        10
      ),
      satsPerBit: parseInt(
        process.env.VNAAS_SATS_PER_BIT ?? "10",
        10
      ),
    },
  };
}