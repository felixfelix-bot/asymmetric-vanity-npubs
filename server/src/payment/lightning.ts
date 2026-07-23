/**
 * Lightning — BOLT11 invoice generation stub.
 *
 * Per the Implementation Plan (Phase 6.4), the Lightning backend is optional.
 * This module provides a stub interface that can be wired to LND, LNURL,
 * or a hosted service. When no backend is configured (`lnBackend = "none"`),
 * the methods return an error so the caller can fall back to Cashu.
 *
 * In the V1 payment flow:
 *   1. Server creates an invoice for the calculated price
 *   2. Client pays the invoice
 *   3. Server waits for payment confirmation
 *   4. Server grinds and returns the offset
 *
 * In the V2 atomic flow (ADR-008 Layer 4):
 *   1. Server finds offset d, computes h = SHA256(d)
 *   2. Client creates a Lightning HTLC with hashlock = h
 *   3. Server settles the HTLC by providing preimage d
 *   4. d is revealed in the settlement → buyer learns the offset
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightning backend type (mirrors ServerConfig.lnBackend). */
export type LightningBackendType = "lnd" | "lnurl" | "none";

/** Result of creating a Lightning invoice. */
export interface InvoiceResult {
  /** BOLT11 invoice string (lnbc…) */
  invoice: string;
  /** Payment hash for tracking */
  paymentHash: string;
  /** Amount in sats */
  amountSats: number;
  /** Expiry in seconds from creation */
  expirySecs: number;
}

/** Result of checking payment status. */
export interface PaymentStatus {
  /** Whether the invoice has been paid */
  paid: boolean;
  /** Whether the invoice has expired */
  expired: boolean;
  /** Time remaining in seconds (0 if expired) */
  remainingSecs: number;
}

// ---------------------------------------------------------------------------
// LightningPayment
// ---------------------------------------------------------------------------

/**
 * Lightning payment handler — stub implementation.
 *
 * When `backendType` is "none", all methods reject with a clear error.
 * To enable Lightning, subclass or patch this to call an actual LND / LNURL
 * backend.
 */
export class LightningPayment {
  private readonly backendType: LightningBackendType;
  private readonly nodeUrl: string | null;

  constructor(backendType: LightningBackendType, nodeUrl?: string) {
    this.backendType = backendType;
    this.nodeUrl = nodeUrl ?? null;
  }

  /**
   * Create a BOLT11 invoice.
   *
   * @param _amountSats - Amount in satoshis
   * @param _description - Human-readable description for the invoice
   * @param _expirySecs - Invoice expiry in seconds (default: 3600 = 1 hour)
   * @returns Invoice result with the bolt11 string
   */
  async createInvoice(
    _amountSats: number,
    _description: string,
    _expirySecs: number = 3600,
  ): Promise<InvoiceResult> {
    if (this.backendType === "none") {
      throw new Error(
        "Lightning backend is not configured (LN_BACKEND=none). " +
          "Set LN_BACKEND=lnd or lnurl and configure the node URL.",
      );
    }

    // --- LND backend stub ---
    if (this.backendType === "lnd") {
      // TODO: Call LND REST API: POST /v1/invoices
      //   { value: amountSats, memo: description, expiry: expirySecs }
      // Parse response for payment_request (bolt11) and r_hash
      throw new Error(
        `LND backend not yet implemented. Configure node URL: ${this.nodeUrl ?? "(not set)"}`,
      );
    }

    // --- LNURL backend stub ---
    if (this.backendType === "lnurl") {
      // TODO: Call LNURL-pay endpoint with amount = amountSats * 1000 msat
      // Parse response for pr (bolt11 invoice)
      throw new Error(
        `LNURL backend not yet implemented. Configure pay endpoint: ${this.nodeUrl ?? "(not set)"}`,
      );
    }

    // Exhaustive check
    throw new Error(`Unknown Lightning backend type: ${this.backendType}`);
  }

  /**
   * Check whether an invoice has been paid.
   *
   * @param _invoice - BOLT11 invoice string (or payment hash)
   * @returns Payment status
   */
  async checkPayment(_invoice: string): Promise<PaymentStatus> {
    if (this.backendType === "none") {
      throw new Error("Lightning backend is not configured.");
    }

    // TODO: Poll LND /v1/invoice/{r_hash} or LNURL verify endpoint
    throw new Error(
      `Payment checking not yet implemented for backend: ${this.backendType}`,
    );
  }

  /**
   * Wait for an invoice to be paid, polling at intervals.
   *
   * @param invoice - BOLT11 invoice string
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @param pollIntervalMs - Polling interval (default: 5000 = 5s)
   * @returns `true` if paid within timeout, `false` otherwise
   */
  async waitForPayment(
    invoice: string,
    timeoutMs: number,
    pollIntervalMs: number = 5000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const status = await this.checkPayment(invoice);
        if (status.paid) return true;
        if (status.expired) return false;
      } catch {
        // Backend error — keep polling until timeout
      }

      // Sleep for poll interval (capped to remaining time)
      const remaining = deadline - Date.now();
      const sleepMs = Math.min(pollIntervalMs, Math.max(0, remaining));
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }

    return false;
  }

  /** Whether this Lightning backend is available (not "none"). */
  get available(): boolean {
    return this.backendType !== "none";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LightningPayment handler from config.
 *
 * @param backendType - "lnd", "lnurl", or "none"
 * @param nodeUrl - Optional node URL for LND/LNURL
 * @returns LightningPayment instance
 */
export function createLightningPayment(
  backendType: LightningBackendType,
  nodeUrl?: string,
): LightningPayment {
  return new LightningPayment(backendType, nodeUrl);
}