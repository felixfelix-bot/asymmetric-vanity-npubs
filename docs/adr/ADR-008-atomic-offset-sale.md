# ADR-008: Atomic Sale of Grinding Offsets

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-006: Offset grinding — VNAAS without key custody

## Context

ADR-006 establishes that a service can sell vanity NPUB offsets without key
custody. The buyer sends their public key, the service grinds, and returns an
offset integer `d`. The buyer applies `d` to their secret key.

The question: how to make this exchange **atomic** — either both parties get
what they want, or neither does — without trusting the other party.

### What "Atomic" Means

In cryptography, an atomic swap ensures simultaneous completion. The classic
trick uses a **hash lock**:

1. Alice has a secret `s`. She publishes `h = H(s)`.
2. Bob locks payment: "reveal a value x where H(x) = h to claim these funds."
3. To claim the funds, Alice MUST publish `s` on-chain (or in-protocol).
4. Bob reads `s` from the public claim. Both sides complete simultaneously.
5. If Alice never claims: Bob gets a timed refund. Nobody loses.

The hash lock guarantees: claiming the payment automatically reveals the secret.

### Why the Offset Is a Perfect Atomic Swap Asset

The offset `d` has ideal properties for hash-locked atomic swaps:

- **Small**: ~5 bytes for typical vanity grind. Fits in any hash preimage.
- **Verifiable**: buyer can check the resulting NPUB before paying (public key
  is computable from the buyer's existing pubkey + d*G).
- **Useless to third parties**: without the buyer's original nsec, knowing d
  reveals nothing. The discrete log from d*G to d is intractable.
- **Hash-lockable**: standard SHA256 or HASH160 works. No custom crypto needed.

## Decision

Support a layered approach, from simple to fully atomic:

### Layer 1: Simple Cashu (V1 — Demo/Early)

Reputation-based, not atomic. Sufficient for small amounts.

```
1. Seller finds offset, sends Buyer: target_npub (proof it exists)
2. Buyer verifies target_npub contains desired vanity + has high z-score
3. Buyer sends Cashu ecash token to Seller
4. Seller sends offset d to Buyer
5. Buyer verifies: (old_nsec + d) mod n → derives pubkey → matches target_npub
```

Not atomic: seller could pocket the ecash and not send `d`. Mitigated by
reputation and small transaction amounts (hundreds of sats).

### Layer 2: Cashu NUT-11 HTLC (V2 — Production)

NUT-11 defines spending conditions for Cashu proofs, including HTLC hash locks.
This makes the exchange truly atomic within the ecash system.

```
1. Seller finds offset d, computes h = SHA256(d)
2. Seller sends Buyer: target_npub + h (hash commitment, does NOT reveal d)
3. Buyer verifies target_npub independently
4. Buyer creates Cashu token locked with NUT-11 HTLC condition: hashlock = h
5. Seller claims ecash from mint by providing preimage d
6. Mint verifies H(d) = h, releases ecash to Seller
7. Buyer reads d (from mint's claim record or seller's notification)
8. Buyer computes new_nsec = (old_nsec + d) mod n
9. Buyer verifies: derived npub matches target_npub
```

Atomic: seller cannot claim the ecash without revealing `d`. Buyer cannot
learn `d` without the seller claiming (which requires correct `d`).

Mint learns `d` during verification, but `d` is useless without the buyer's
secret key.

### Layer 3: Bitcoin On-Chain HTLC (Optional)

Standard cross-chain atomic swap using Bitcoin script:

```
Buyer creates P2WSH:
  OP_IF
    OP_SHA256 <h> OP_EQUALVERIFY <seller_pubkey> OP_CHECKSIG
  OP_ELSE
    <48h CSV> <buyer_pubkey> OP_CHECKSIG
  OP_ENDIF

Seller spends by revealing d in witness data.
Buyer reads d from blockchain.
```

Battle-tested but expensive for small amounts. On-chain fees ($1-10) may
exceed the service price. Best reserved for high-value custom vanity words.

### Layer 4: Lightning HTLC (Optional)

Same mechanism as on-chain but off-channel. Near-zero fees, instant settlement.
Requires both parties to have Lightning channels and inbound liquidity.

## Why Adaptor Signatures Don't Work Here

Adaptor signatures reveal a **curve point** (d*G), not the **scalar** (d). The
buyer could learn d*G and compute the new public key (new_pub = old_pub + d*G)
but cannot compute the new secret key (new_nsec) from d*G alone — that would
require solving the elliptic curve discrete logarithm problem.

Therefore adaptor signatures give the buyer verification ability but not key
usability. A second mechanism would still be needed to transmit the scalar d,
breaking the one-shot atomicity.

## Why Cashu Is Better Than Bitcoin for This Use Case

| Property          | Bitcoin On-Chain | Lightning | Cashu        |
|-------------------|:----------------:|:---------:|:------------:|
| Atomic (HTLC)     | ✓                | ✓         | ✓ (NUT-11)   |
| Fee               | $1-10            | ~$0.001   | $0           |
| Privacy           | ✗                | partial   | ✓ (Chaumian) |
| Micropayment      | ✗                | ✓         | ✓            |
| No channel needed | ✓                | ✗         | ✓            |
| Nostr-native      | ✗                | partial   | ✓            |
| Setup complexity  | low              | high      | low          |

Vanity NPUB offsets are low-value (hundreds to thousands of sats). Bitcoin
on-chain fees would dominate the transaction. Cashu with NUT-11 HTLC provides
atomicity at zero cost with full privacy.

## Invariants

1. The offset `d` is always the HTLC preimage. `h = SHA256(d)` is the hash lock.
2. Buyer can ALWAYS verify the target NPUB before committing funds — this is a
   public operation (compute P + d*G from the buyer's own pubkey).
3. Seller can ALWAYS claim payment by revealing `d` — the hash lock guarantees this.
4. If either party walks away: buyer gets a timed refund (on-chain) or the
   locked ecash expires (Cashu).
5. The offset `d` is useless to any party who doesn't have the buyer's original
   secret key.

## Consequences

### Positive
- True atomic exchange is possible and practical
- Cashu NUT-11 provides the best fit: zero-fee, private, Nostr-native
- Works for any amount (micropayments to large custom orders)
- Multiple payment rails can be layered (Cashu, Lightning, on-chain)
- The offset's cryptographic properties make it an ideal atomic swap asset

### Costs
- Cashu NUT-11 HTLC not yet widely implemented by all mints
- The mint learns d during NUT-11 verification (but d is useless without nsec)
- On-chain/Lightning options require more setup
- For V1: simple Cashu is not truly atomic (reputation-based trust)

## Notes

The hash-locked atomic swap is the natural complement to offset grinding
(ADR-006). Together they form a complete trustless VNAAS marketplace:

- **ADR-006**: HOW to grind without key custody (offset grinding)
- **ADR-008**: HOW to sell the result without trust (atomic hash-locked swap)

For the demo: use Layer 1 (simple Cashu). For production: upgrade to Layer 2
(Cashu NUT-11 HTLC).
