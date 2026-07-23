/**
 * Pricing — difficulty-based cost calculation for vanity NPUB grinding.
 *
 * Each bech32 character represents 5 bits of search space. The difficulty
 * of a vanity pattern is `pattern.length * 5` bits. Patterns below the free
 * threshold are ground for free; above it, the price scales linearly with
 * sats per bit, optionally multiplied by an entropy-scan surcharge.
 *
 * Per the Implementation Plan (Phase 6.1) and ADR-008.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Pricing configuration.
 *
 * Loaded from environment / ServerConfig.pricing, with sensible defaults.
 */
export interface PricingConfig {
  /** Patterns below this difficulty (in bits) are free. Default: 20 (~1M keys) */
  freeThresholdBits: number;
  /** Sats per bit of difficulty above the free threshold. Default: 1 */
  satsPerBit: number;
  /** Multiplier when entropy scanning is requested (more work). Default: 1.5 */
  entropyScanMultiplier: number;
  /** Minimum price in sats (after free threshold). Default: 21 */
  minPriceSats: number;
  /** Maximum price in sats — cap for very long patterns. Default: 10 000 */
  maxPriceSats: number;
}

/** Default pricing configuration (matches IMPLEMENTATION-PLAN.md §6.1). */
export const DEFAULT_PRICING: PricingConfig = {
  freeThresholdBits: 20,
  satsPerBit: 1,
  entropyScanMultiplier: 1.5,
  minPriceSats: 21,
  maxPriceSats: 10_000,
};

// ---------------------------------------------------------------------------
// Difficulty calculation
// ---------------------------------------------------------------------------

/**
 * Compute the difficulty (in bits) of a vanity pattern.
 *
 * Each bech32 character represents 5 bits of search space (bech32 uses
 * a 32-symbol alphabet → log₂(32) = 5 bits per character).
 *
 * For "contains" matching (the pattern can appear anywhere in the NPUB),
 * the effective search space is larger, but we use the simple linear
 * approximation `pattern.length * 5` as specified in the plan.
 *
 * @param pattern - Vanity pattern string (e.g. "meshmate")
 * @returns Difficulty in bits
 */
export function calculateDifficultyBits(pattern: string): number {
  return pattern.length * 5;
}

/**
 * Determine whether a pattern falls within the free threshold.
 *
 * @param pattern - Vanity pattern string
 * @param config - Pricing configuration (defaults to DEFAULT_PRICING)
 * @returns `true` if the pattern is free to grind
 */
export function isFreePattern(
  pattern: string,
  config: PricingConfig = DEFAULT_PRICING,
): boolean {
  return calculateDifficultyBits(pattern) <= config.freeThresholdBits;
}

// ---------------------------------------------------------------------------
// Price calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the price in sats for grinding a vanity pattern.
 *
 * Formula:
 *   difficultyBits = pattern.length * 5
 *   if difficultyBits <= freeThresholdBits → 0 sats (free)
 *   baseSats = (difficultyBits - freeThresholdBits) * satsPerBit
 *   if scanEntropy → baseSats *= entropyScanMultiplier
 *   return clamp(baseSats, minPriceSats, maxPriceSats)
 *
 * @param pattern - Vanity pattern string
 * @param scanEntropy - Whether entropy scanning is also requested
 * @param config - Pricing configuration (defaults to DEFAULT_PRICING)
 * @returns Price in sats (0 if free)
 */
export function calculatePrice(
  pattern: string,
  scanEntropy: boolean = false,
  config: PricingConfig = DEFAULT_PRICING,
): number {
  const difficultyBits = calculateDifficultyBits(pattern);

  // Below free threshold → no charge
  if (difficultyBits <= config.freeThresholdBits) {
    return 0;
  }

  // Base price: sats per bit above the free threshold
  let sats = (difficultyBits - config.freeThresholdBits) * config.satsPerBit;

  // Entropy scanning surcharge
  if (scanEntropy) {
    sats = Math.round(sats * config.entropyScanMultiplier);
  }

  // Clamp to [minPriceSats, maxPriceSats]
  return Math.max(config.minPriceSats, Math.min(sats, config.maxPriceSats));
}

/**
 * Build a PricingConfig from the ServerConfig.pricing fields.
 *
 * The ServerConfig has a simpler two-field pricing object; this function
 * fills in the remaining defaults to produce a full PricingConfig.
 *
 * @param serverPricing - The `pricing` field from ServerConfig
 * @returns Complete PricingConfig
 */
export function pricingConfigFromServer(serverPricing: {
  freeThreshold: number;
  satsPerBit: number;
}): PricingConfig {
  return {
    ...DEFAULT_PRICING,
    freeThresholdBits: serverPricing.freeThreshold,
    satsPerBit: serverPricing.satsPerBit,
  };
}