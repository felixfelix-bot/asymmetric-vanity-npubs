/**
 * Type definitions for the VNAAS Grinder Server.
 *
 * These types define the MCP tool interface for vanity NPUB offset grinding,
 * the backend dispatch chain, and configuration structures.
 */

// ---------------------------------------------------------------------------
// MCP Tool: grind_npub
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by the `grind_npub` MCP tool.
 */
export interface GrindNpubParams {
  /** User's public key in npub format (npub1...) */
  npub: string;
  /** Desired vanity word/prefix to match in the resulting NPUB */
  vanity_pattern: string;
  /** Optional grinding parameters */
  options?: {
    /** Also match a suffix pattern in the NPUB */
    suffix?: string;
    /** Minimum entropy outlier z-score (ADR-003) */
    min_z_score?: number;
    /** Minimum fingerprint window size: 16, 25, 36, or 49 */
    min_window_size?: number;
    /** Maximum grind time in seconds (default: 300) */
    timeout_secs?: number;
    /** Maximum cost in sats for paid grinding */
    max_cost_sats?: number;
  };
}

/**
 * Result returned by the `grind_npub` MCP tool.
 */
export interface GrindNpubResult {
  /** Outcome status */
  status: "found" | "timeout" | "payment_required" | "use_client_fallback" | "error";

  // --- When status === "found" ---
  /** The offset integer d (as decimal string, can be very large) */
  offset?: string;
  /** The resulting vanity NPUB (npub1...) */
  vanity_npub?: string;
  /** Entropy outlier z-score if scanned */
  z_score?: number;
  /** Fingerprint window analysis */
  fingerprint_window?: {
    size: number;
    position: number;
    unique_chars: number;
    quality_db: number;
  };
  /** Grinding statistics */
  grind_stats?: {
    keys_tried: number;
    duration_secs: number;
    rate_per_sec: number;
    backend: "gpu" | "rana" | "browser";
  };

  // --- When status === "payment_required" ---
  /** Lightning invoice or Cashu token */
  invoice?: string;
  /** SHA256(d) hash commitment for atomic swap (ADR-008) */
  hash_commitment?: string;

  // --- When status === "use_client_fallback" ---
  /** Why the server couldn't grind */
  fallback_reason?: string;
}

// ---------------------------------------------------------------------------
// Backend Interface (Phase 2 placeholder types)
// ---------------------------------------------------------------------------

/**
 * Interface that all grinding backends must implement.
 * Defined here for forward compatibility; actual implementations in Phase 2.
 */
export interface GrindBackend {
  name: "gpu" | "rana" | "browser";
  available: boolean;
  estimatedRate: number; // keys/sec estimate
  grind(params: GrindParams): Promise<GrindResult>;
  healthCheck(): Promise<boolean>;
}

/**
 * Parameters passed to a grinding backend.
 */
export interface GrindParams {
  pubKeyBytes: Uint8Array; // 32-byte x-only public key
  vanityPatterns: string[];
  suffixPatterns?: string[];
  startOffset: bigint;
  maxOffset: bigint;
  timeoutMs: number;
  scanEntropy: boolean;
  minZScore: number;
  minWindowSize: number;
}

/**
 * Result from a grinding backend.
 */
export interface GrindResult {
  found: boolean;
  offset?: bigint;
  vanityNpub?: string;
  zScore?: number;
  fingerprint?: FingerprintInfo;
  keysTried: number;
  durationMs: number;
  backend: string;
  fallbackReason?: string;
  clientCode?: string;
}

/**
 * Fingerprint analysis info (ADR-003/004).
 */
export interface FingerprintInfo {
  size: number;
  position: number;
  uniqueChars: number;
  qualityDb: number;
}

// ---------------------------------------------------------------------------
// Server Configuration
// ---------------------------------------------------------------------------

/**
 * Server configuration loaded from environment variables.
 */
export interface ServerConfig {
  /** Server's Nostr private key (hex) */
  serverPrivateKey: string;
  /** Server's derived npub */
  serverNpub: string;
  /** Nostr relays to listen on */
  relays: string[];
  /** Path to rana binary (or "rana" if in PATH) */
  ranaBinaryPath: string;
  /** Path to cuda_vanity binary */
  gpuBinaryPath: string;
  /** Try to use GPU backend */
  enableGpu: boolean;
  /** Try to use rana backend */
  enableRana: boolean;
  /** Always true — browser fallback is always available */
  enableBrowserFallback: boolean;
  /** Enable payment processing */
  enablePayments: boolean;
  /** Cashu mint URL */
  cashuMintUrl: string;
  /** Lightning backend type */
  lnBackend: "lnd" | "lnurl" | "none";
  /** Pricing configuration */
  pricing: {
    freeThreshold: number;
    satsPerBit: number;
  };
}