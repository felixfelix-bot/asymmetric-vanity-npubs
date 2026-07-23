# Blockers & Known Issues

This file tracks unresolved blockers, untested components, and missing
dependencies in the asymmetric-vanity-npubs project. Items are ordered by
impact on the core grinding pipeline.

---

## 1. GPU CUDA Kernel Not Compilable Without `nvcc`

**Status:** Code written (Phase 4), untested — **no nvcc available in dev environment**

**Affected files:**
- `server/gpu/src/main.cu`
- `server/gpu/src/offset_grind.cu`
- `server/gpu/include/secp256k1.cuh`
- `server/gpu/include/vanity.cuh`
- `server/gpu/CMakeLists.txt`

**Description:**

The CUDA kernel for offset grinding (`P + d·G` on GPU) was written as part
of Phase 4, but has never been compiled or tested. The development
environment does not have the CUDA toolkit (`nvcc`) installed, so the
following are unverified:

- **Compilation**: The `.cu` files and CMake build configuration have not
  been validated against any CUDA toolkit version. Syntax errors, missing
  includes, or incorrect API usage are possible.
- **Correctness**: The EC point addition logic in the CUDA kernel has not
  been cross-verified against the CPU reference implementation
  (`@noble/secp256k1`). The implementation plan requires all backends to
  produce identical results for the same `(P, d)` pair.
- **Performance**: The expected 10–50M keys/sec throughput is an estimate
  based on the original `v0l/cuda_vanity` project and has not been measured.
- **GPU architecture**: The CMake configuration targets
  `-DCMAKE_CUDA_ARCHITECTURES=80` (Ampere, e.g. RTX 3090/4090). Other
  architectures (Turing, Hopper, etc.) may need different flags.

**To unblock:**
1. Install CUDA toolkit 12.x with `nvcc`
2. Run `cd server/gpu && mkdir build && cd build && cmake .. && make -j$(nproc)`
3. Fix any compilation errors
4. Run the cross-verification test against the CPU reference
5. Benchmark actual keys/sec on target GPU hardware

---

## 2. Lightning Invoice Generation Is a Stub

**Status:** Stub implementation (Phase 6) — **needs LND or LNURL backend**

**Affected files:**
- `server/src/payment/lightning.ts`

**Description:**

The `LightningPayment` class in `lightning.ts` is a stub. The
`createInvoice()` and `checkPayment()` methods throw "not yet implemented"
errors for both `lnd` and `lnurl` backend types. The `waitForPayment()`
method polls `checkPayment()` but will always fail since the underlying
methods are stubs.

When `VNAAS_LN_BACKEND=none` (the default), all Lightning methods reject
with a clear error message, and the server falls back to Cashu-only
payments (or free grinding if payments are disabled).

**What's implemented:**
- Interface and types (`InvoiceResult`, `PaymentStatus`)
- Factory function (`createLightningPayment`)
- Polling logic in `waitForPayment()`
- Error handling and backend availability check

**What's missing:**
- **LND backend**: REST API calls to `POST /v1/invoices` and
  `GET /v1/invoice/{r_hash}` — needs `VNAAS_LN_NODE_URL` and
  TLS certificate / macaroon configuration
- **LNURL backend**: LNURL-pay endpoint integration — needs
  `VNAAS_LN_NODE_URL` pointing to a LNURL-pay service
- **Invoice expiry handling**: Proper expiry detection in `checkPayment()`
- **Webhook/push notifications**: Current implementation only polls

**To unblock:**
1. Choose a Lightning backend (LND recommended for self-hosted)
2. Implement the LND REST API calls in `createInvoice()` and `checkPayment()`
3. Add `VNAAS_LN_NODE_URL`, `VNAAS_LN_TLS_CERT`, `VNAAS_LN_MACAROON` env vars
4. Test with a testnet LND node
5. Alternatively, integrate an LNURL-pay service for hosted Lightning

---

## 3. Cashu Requires `@cashu/cashu-ts` npm Package

**Status:** Code written (Phase 6), not installed — **`@cashu/cashu-ts` missing from dependencies**

**Affected files:**
- `server/src/payment/cashu.ts`
- `server/src/payment/atomic-swap.ts`
- `server/package.json` (missing dependency)

**Description:**

The `CashuPayment` class uses a dynamic `import()` to load
`@cashu/cashu-ts` at runtime. This design allows the server to start and
run without the package installed (payments disabled by default), but
means Cashu payment functionality is **non-functional** until the package
is installed.

The dynamic import will fail with a clear error message:
> "@cashu/cashu-ts is not installed or failed to load. Install it to
> enable Cashu payments."

**What's implemented:**
- `CashuPayment` class with `receiveToken()`, `createHtlcRequest()`,
  and `claimHtlcToken()` methods
- Dynamic import with graceful fallback
- SHA256 hash computation for atomic swap commitments
- HTLC request/response structures (NUT-11)

**What's missing:**
- `@cashu/cashu-ts` in `package.json` dependencies
- NUT-11 HTLC support verification (depends on mint capabilities)
- Token format validation (cashuA / cashuB)
- Error handling for mint-specific edge cases

**To unblock:**
1. Install the package: `npm install @cashu/cashu-ts`
2. Test `receiveToken()` with a real Cashu token from a supported mint
3. Test `createHtlcRequest()` and `claimHtlcToken()` with a NUT-11
   compatible mint
4. Verify the dynamic import path works with the installed version
5. Add integration tests in `tests/payment.test.ts`

---

## Summary

| # | Blocker | Impact | Effort to Fix |
|---|---------|--------|---------------|
| 1 | GPU kernel uncompiled | GPU backend unavailable | Medium — needs CUDA toolkit + debugging |
| 2 | Lightning invoice stub | No Lightning payments | Medium — needs LND node or LNURL service |
| 3 | Cashu package missing | No Cashu payments | Low — `npm install @cashu/cashu-ts` + test |

The core grinding pipeline (CPU via rana + browser fallback) is functional
without resolving these blockers. Payment and GPU features are optional
enhancements that can be enabled incrementally.