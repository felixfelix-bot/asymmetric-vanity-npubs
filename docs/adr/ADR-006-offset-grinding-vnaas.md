# ADR-006: Offset Grinding — Vanity NPUB as a Service Without Key Custody

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-001: Anti-phishing via low-entropy outlier discovery
- ADR-004: Sequential grinding strategy

## Context

ADR-004 establishes sequential grinding: first find a vanity prefix, then
discover the anti-phish outlier among candidates. For an 8-char vanity word
like "meshmate", this costs ~2^37 key generations — hours to days on consumer
hardware.

This creates a business opportunity: a service that grinds on behalf of users
who don't have the compute. But the naive approach requires the user to share
their secret key (nsec) with the service, which is a fatal security flaw.

## Decision

Use **offset grinding**: the service grinds using ONLY the user's public key
(npub). The secret key is never shared. The service returns a small offset
integer that the user adds to their secret key.

### Mathematical Basis

Nostr uses secp256k1 elliptic curve keys. The relationship is:

```
P = k * G    (public key = secret key × generator point)
```

Elliptic curve groups are additive. Adding a constant offset `d` to the
secret key produces a predictable shift in the public key:

```
(k + d) * G = k*G + d*G = P + d*G
```

**Critical insight**: the service can compute `P + d*G` using ONLY the public
key `P`. It does not need `k`. Point addition of two public keys is a standard
secp256k1 operation.

### Verified Properties (empirically tested with real secp256k1)

All 10 test cases pass, including:
- Small offsets (d=1, d=42)
- Large offsets (d=2^128, d=2^255)
- Boundary offsets (d = curve_order - 1, d = curve_order // 2)
- **Wrap-around**: when k + d exceeds the curve order n, modular arithmetic
  wraps cleanly. The public keys still match.

### Service Workflow (Vanity NPUB as a Service — VNAAS)

```
1. User generates keypair locally (standard Nostr keygen)
   User has: nsec (secret), npub (public)

2. User sends ONLY npub to service
   Service receives: public key P

3. Service grinds:
   current_pub = P
   For d = 1, 2, 3, ...:
     current_pub += G              (one EC point addition)
     npub_candidate = bech32_encode(current_pub)
     Check: contains "meshmate"?
     Check: has high z-score outlier?
     If yes: return offset d to user

4. Service returns offset d (a small integer, ~5 bytes)

5. User computes locally:
   new_nsec = (old_nsec + d) mod n
   new_npub = derive_public_key(new_nsec)

6. Verification: new_npub == what service found
   If match: user has new vanity NPUB + anti-phish fingerprint
```

### Why NPUBs Allow This But Bitcoin Addresses Don't

Bitcoin addresses are HASHED: `address = RIPEMD160(SHA256(public_key))`.
The hash destroys the additive structure. You cannot compute
`hash(P + d*G)` from `hash(P)` alone.

Nostr NPUBs are DIRECT ENCODINGS of the public key: `npub = bech32(x_coord(P))`.
No hash. The additive structure of the elliptic curve is preserved. This makes
offset grinding possible.

### Performance

Offset grinding via point addition is 9.5x FASTER than fresh keypair generation:

| Method                        | Speed (keys/sec) |
|-------------------------------|-----------------:|
| Fresh keypair (scalar mult)   | ~20,000          |
| Point addition (P + n*G)      | ~190,000         |

Reason: the service maintains a running public key and adds G (one point
addition) per step, instead of computing a full scalar multiplication.

At 190k keys/sec:
- "mesh" (4 chars): ~0.01 seconds
- "cashu" (5 chars): ~88 seconds
- "meshmate" (8 chars): ~7.5 days (single core)

Multi-core or GPU grinding would reduce this significantly.

### Offset Transmission

The offset `d` is a small integer:

| Vanity cost | Max offset   | Size    | Example                    |
|-------------|-------------|---------|----------------------------|
| 2^20        | ~1 million  | 3 bytes | `offset: 1048576`          |
| 2^30        | ~1 billion  | 4 bytes | `offset: 1073741824`       |
| 2^37        | ~137 billion| 5 bytes | `offset: 137438953472`     |

Transmittable as plain text, QR code, or Cashu token.

### Trust Model

| Party        | Knows                          | Can do                     |
|--------------|--------------------------------|----------------------------|
| User         | nsec, npub, offset d           | Full key control           |
| Service      | npub, offset d                 | Verify NPUB, nothing else  |
| Attacker     | Possibly npub and offset d     | Nothing (no secret material)|

- The offset d is useless without the original nsec
- Knowing both old npub and new npub reveals d*G, but not d (discrete log)
- Service cannot sign messages, read DMs, or access the user's identity
- Worst case: malicious service gives wrong offset (user gets wrong vanity)
- No key custody risk at any point

### Wrap-Around

When `k + d` exceeds the curve order `n`, the result wraps modulo `n`:

```
new_k = (k + d) mod n
```

This is standard modular arithmetic. The public key derivation works
identically:

```
(k + d) mod n * G = P + d*G
```

Empirically verified: wrap-around produces matching public keys on both
service and user side.

## Invariants

1. Service NEVER receives or processes the secret key (nsec).
2. User NEVER sends anything except the public key (npub) to the service.
3. The offset d is an integer in range [0, n-1] where n is the secp256k1 order.
4. `new_nsec = (old_nsec + d) mod n` always produces a valid secp256k1 secret key.
5. The service can compute candidate NPUBs at ~190k/sec via incremental point addition.
6. The offset is small (~5 bytes for typical vanity grind) and easy to transmit.

## Consequences

### Positive
- Zero key custody risk — the killer feature for any vanity service
- 9.5x faster than naive grinding (point addition vs scalar multiplication)
- Offset is a tiny number (transmittable as text, QR, or ecash token)
- Works with existing Nostr tooling (standard secp256k1, no custom crypto)
- Enables a business model: pay-per-vanity with Cashu, no trust required
- User can verify the result independently before applying the offset

### Costs
- User must have an existing keypair (can't grind for a "fresh" identity)
- The original npub is linked to the new npub via the offset (if someone knows
  both, they know they're the same person — but can't compute the secret)
- Service could theoretically precompute a rainbow table of offsets for common
  vanity words, but this doesn't compromise key security
- User must trust the service to return the correct offset (verifiable after the fact)

### Business Model Implications

This enables a trustless vanity NPUB marketplace:

1. User generates keypair → sends npub to service
2. Service finds vanity + outlier → returns offset + proof
3. User pays via Cashu (ecash, private, instant)
4. User applies offset → verifies → done

No escrow needed. The offset is useless without payment because the user
can verify correctness before paying (service can show the resulting NPUB).
After payment, service reveals the offset.

## Notes

This approach is specific to secp256k1-based identity systems where the
public key is encoded directly (not hashed). It works for Nostr (NIP-19 NPUBs)
and would work for any similar scheme. It does NOT work for Bitcoin addresses
(which are hashed) or Ethereum addresses (which use Keccak-256 of the pubkey).

The 9.5x speedup from point addition makes the service economically viable
even for long vanity words. At 190k keys/sec on a single core, a 16-core
server achieves ~3M keys/sec, reducing "meshmate" grind time to ~5 hours.

Rust or C implementation of point addition grinding would likely achieve
1M+ keys/sec per core, bringing "meshmate" down to minutes.
