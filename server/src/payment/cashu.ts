/**
 * Cashu — ecash token support for atomic swap (ADR-008).
 *
 * Supports two layers:
 *   Layer 1 (V1): Simple Cashu — reputation-based, not atomic.
 *     The server receives a Cashu token, claims the ecash, then delivers
 *     the offset `d`. Suitable for small amounts / demo.
 *
 *   Layer 2 (V2): Cashu NUT-11 HTLC — truly atomic.
 *     The server finds the offset first, computes h = SHA256(d), and
 *     sends the buyer a hash commitment. The buyer creates a Cashu token
 *     locked with a NUT-11 HTLC using that hash. The server claims the
 *     ecash by providing the preimage `d`, which simultaneously reveals
 *     the offset to the buyer.
 *
 * The `@cashu/cashu-ts` library is loaded dynamically at runtime so the
 * module can be imported even when the package is not installed (e.g.
 * payments disabled). When it is missing, methods throw clear errors.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of verifying / receiving a Cashu token. */
export interface CashuReceiveResult {
  /** Whether the token was successfully claimed */
  success: boolean;
  /** Amount received in millisats (0 on failure) */
  amountMsat: number;
  /** Error message if failed */
  error?: string;
}

/** Instructions for the client to create an HTLC-locked token. */
export interface HtlcRequest {
  /** Marker so the client knows this is an HTLC request */
  type: "htlc";
  /** Mint URL the client should use */
  mint: string;
  /** Amount in sats */
  amount: number;
  /** SHA256(d) as hex — the hash lock the client must use */
  hashLock: string;
  /** Human-readable description */
  description: string;
}

// ---------------------------------------------------------------------------
// CashuPayment
// ---------------------------------------------------------------------------

/**
 * Cashu payment handler.
 *
 * Wraps `@cashu/cashu-ts` to provide a clean interface for:
 *   - Receiving simple ecash tokens (V1)
 *   - Creating HTLC lock requests (V2)
 *   - Claiming HTLC-locked tokens by providing a preimage (V2)
 */
export class CashuPayment {
  private readonly _mintUrl: string;
  private wallet: unknown | null = null;
  private walletInitError: string | null = null;

  constructor(mintUrl: string) {
    this._mintUrl = mintUrl;
  }

  /**
   * Lazily initialise the CashuWallet.
   *
   * We do this lazily so the module can be imported even when
   * `@cashu/cashu-ts` is not installed (e.g. payments disabled).
   */
  private async getWallet(): Promise<unknown> {
    if (this.wallet) return this.wallet;
    if (this.walletInitError) throw new Error(this.walletInitError);

    try {
      // Dynamic import — avoids hard dependency at build time.
      // We use a variable so TypeScript does not try to resolve the module
      // (it may not be installed when payments are disabled).
      const moduleName = "@cashu/cashu-ts";
      const cashuModule = await import(/* @vite-ignore */ moduleName) as {
        CashuMint: new (url: string) => unknown;
        CashuWallet: new (mint: unknown) => unknown;
      };
      const CashuMint = cashuModule.CashuMint;
      const CashuWallet = cashuModule.CashuWallet;
      const mint = new CashuMint(this._mintUrl);
      this.wallet = new CashuWallet(mint);
      return this.wallet;
    } catch (_e) {
      this.walletInitError =
        "@cashu/cashu-ts is not installed or failed to load. " +
        "Install it to enable Cashu payments.";
      throw new Error(this.walletInitError);
    }
  }

  /**
   * Receive (claim) a simple Cashu token — V1 flow.
   *
   * @param token - Cashu token string (cashuA… / cashuB…)
   * @returns Whether the token was successfully claimed
   */
  async receiveToken(token: string): Promise<CashuReceiveResult> {
    try {
      const wallet = await this.getWallet();
      // The cashu-ts API: wallet.receive(token) → Proof[]
      const receive = (wallet as { receive: (t: string) => Promise<unknown[]> }).receive;
      const proofs = await receive.call(wallet, token);
      return {
        success: true,
        amountMsat: proofs.length > 0 ? proofs.length * 1000 : 0,
      };
    } catch (e) {
      return {
        success: false,
        amountMsat: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Create an HTLC request for the client (V2 flow).
   *
   * The server has already found the offset `d` and computed `h = SHA256(d)`.
   * This method returns instructions the client uses to create a NUT-11
   * HTLC-locked Cashu token with `hashLock = h`.
   *
   * @param hashLock - SHA256(d) as hex string
   * @param amount - Price in sats
   * @returns HTLC request object (to be JSON-serialised and sent to client)
   */
  createHtlcRequest(hashLock: string, amount: number): HtlcRequest {
    return {
      type: "htlc",
      mint: this._mintUrl,
      amount,
      hashLock,
      description: "Vanity NPUB grinding — reveal preimage to claim",
    };
  }

  /**
   * Claim an HTLC-locked Cashu token by providing the preimage `d` (V2 flow).
   *
   * The mint verifies H(d) = h and releases the ecash to the server.
   * The preimage `d` is revealed in the claim record, so the buyer can
   * read it from the mint or the server's notification.
   *
   * @param token - HTLC-locked Cashu token string
   * @param preimage - The offset `d` (as hex or decimal string)
   * @returns Whether the claim succeeded
   */
  async claimHtlcToken(
    token: string,
    preimage: string,
  ): Promise<CashuReceiveResult> {
    try {
      const wallet = await this.getWallet();
      // The cashu-ts API may accept a preimage option for NUT-11 HTLC
      const receive = (wallet as {
        receive: (t: string, opts?: { preimage?: string }) => Promise<unknown[]>;
      }).receive;
      const proofs = await receive.call(wallet, token, { preimage });
      return {
        success: true,
        amountMsat: proofs.length > 0 ? proofs.length * 1000 : 0,
      };
    } catch (e) {
      return {
        success: false,
        amountMsat: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Get the mint URL this handler is configured for. */
  get mintUrl(): string {
    return this._mintUrl;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CashuPayment handler.
 *
 * @param mintUrl - Cashu mint URL (e.g. "https://mint.minibits.cash")
 * @returns CashuPayment instance
 */
export function createCashuPayment(mintUrl: string): CashuPayment {
  return new CashuPayment(mintUrl);
}

// ---------------------------------------------------------------------------
// Hash utilities (used by atomic-swap.ts as well, but exported here for
// convenience)
// ---------------------------------------------------------------------------

/**
 * Compute SHA256 hex digest of a string.
 *
 * @param data - Input string (UTF-8 encoded)
 * @returns 64-character hex string
 */
export function sha256Hex(data: string): string {
  const bytes = new TextEncoder().encode(data);
  const hash = sha256(bytes);
  return bytesToHex(hash);
}