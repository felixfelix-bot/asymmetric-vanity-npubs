# ADR-007: Tooling Strategy — Fork Rana for Offset Grinding

## Status

Proposed

## Date

2026-07-23

## Related

- ADR-004: Sequential grinding strategy
- ADR-006: Offset grinding — VNAAS without key custody

## Context

ADR-006 defines offset grinding (P + d*G) for trustless vanity NPUB service.
Several existing vanity NPUB miners exist, but none support offset mode —
they all generate fresh keypairs. We need to choose a base to fork.

### Existing Tools Evaluated

| Tool | Lang | Speed | Offset? | Multi-target? | Verdict |
|------|------|-------|---------|---------------|---------|
| v0l/cuda_vanity | C++/CUDA | 10-50M/s (GPU) | No | No | Kernel rewrite needed |
| chawyehsu/vanity-gen | Rust | 50-200K/s | No | No | Simplest, but no infra |
| grunch/rana | Rust | 200K-1M/s | No | YES | Best candidate |
| Spl0itable/vanitynpub | JS/WASM | Browser | No | No | Too slow for service |
| lacaulac/nostr-pubminer | Rust | ~200K/s | No | No | Minimal |

None of the existing tools support offset grinding. All generate fresh random
keypairs. This is expected — offset grinding is a novel contribution of
ADR-006.

### GPU Mining (v0l/cuda_vanity)

The CUDA tool achieves 10-50M keys/sec on high-end NVIDIA GPUs. This is
100-500x faster than CPU mining. However:

- It generates fresh keypairs, not offset grinding
- The GPU kernel would need EC point addition (P + Q), which it doesn't have
- CUDA kernel modifications are significantly harder than Rust changes
- Defer to V2 after CPU prototype proves the concept

The offset grinding modification to the GPU kernel would require:
1. Loading base point P onto GPU memory
2. Implementing EC point addition in CUDA device functions
3. Restructuring kernel from "random d → d*G" to "incrementing d → P + d*G"
4. This is a major CUDA engineering effort

### Why rana is the best fork candidate

grunch/rana is the strongest base for offset grinding modification:

1. **Multi-target**: Already supports multiple vanity patterns simultaneously
2. **Multi-threaded**: Rayon parallelism scales to all cores
3. **Rust + libsecp256k1**: `pubkey_tweak_add` and `ec_pubkey_combine` directly available
4. **Clean structure**: Proper CLI (clap), progress bars (indicatif), modular code
5. **Most mature**: Best structured of all candidates

### Why Not Others

- **cuda_vanity**: 10-50x faster but kernel rewrite is HARD. V2 optimization.
- **chawyehsu**: Simplest offset modification (~20 lines) but no multi-threading,
  no multi-target. Good reference implementation, not production base.
- **Browser tools**: Too slow for a service. Useful for end-user verification only.
- **NIP-13 miners** (gpu-nip13-miner, notemine): Wrong use case — these mine
  event PoW (SHA256 leading zeros), not vanity pubkeys.

## Decision

**Fork grunch/rana** as the base for VNAAS offset grinding.

### Modification Plan

Core changes (~50-100 lines):

1. **Add `--pubkey <npub>` flag**: Parse user's existing public key P
2. **Replace `Keys::generate()` with offset grinding**:
   - Maintain `Arc<AtomicU64>` nonce counter
   - Per thread: load nonce d, compute P + d*G via `secp256k1::PublicKey::add_exp`
   - Check resulting NPUB against patterns
3. **Parallelism**: Switch from par_iter to chunked nonce dispatch
   - Each thread gets range [start..end]
   - Within range: iterate d = start, start+1, ...
4. **Output**: Return offset d (not private key) when match found
5. **Add z-score scanning**: After finding vanity match, scan NPUB for
   highest-z outlier (ADR-003) to discover anti-phish fingerprint
6. **Add complement charset filter** (ADR-002): Optional filter on outlier

### After Vanity Match: Outlier Discovery

Following ADR-004 (sequential grinding):

```
Step 1: Offset grind for vanity prefix (find d values matching "meshmate")
Step 2: Among matching candidates, scan each for multi-scale z-score outlier
Step 3: Return the candidate with highest z-score + its offset d
```

Step 2 is free — no additional key generation, just entropy computation on
already-found NPUBs.

### GPU Path (V2)

Once the CPU prototype proves the concept and we have real customers:

1. Fork cuda_vanity
2. Add EC point addition to the CUDA kernel
3. Accept base pubkey P as input
4. This gives 10-50M keys/sec, reducing "meshmate" grind from hours to minutes

Collaborator with GPU can work on this in parallel once we have the CPU
prototype to validate against.

### nak for Verification

fiatjaf/nak should be integrated as the end-user verification tool:

```bash
# User receives offset d from service
# User verifies locally:
nak key derive --offset 137438953472 <nsec>
# OR (if nak doesn't support this yet):
# User computes: python3 derive.py <nsec> 137438953472
# Then compares resulting npub to what service promised
```

## Invariants

1. Fork rana under felixfelix-bot namespace (fork-first strategy)
2. Offset mode is the default; fresh-keypair mode remains as legacy fallback
3. Output is always the offset integer d, never a private key
4. Multi-target support must be preserved (grind for multiple users simultaneously)
5. z-score outlier scanner integrated into post-match step (ADR-003/004)

## Consequences

### Positive
- Fastest path to working VNAAS prototype
- Multi-target = multiple users' patterns in one grind pass
- Rust + libsecp256k1 = safe, fast, well-tested crypto
- Clean fork history for upstream contributions if desired

### Costs
- CPU-only initially (200K-1M keys/sec)
- 8-char vanity ("meshmate") takes hours on CPU
- GPU support requires separate fork of cuda_vanity (V2)
- rana uses `nostr` crate which abstracts secp256k1 — may need to drop to
  raw secp256k1 crate for point addition operations

## Notes

The collaborator with GPU should fork v0l/cuda_vanity and add offset mode.
This is the V2 path. The CPU prototype (rana fork) validates the concept and
produces reference NPUBs to cross-check against.

nak (fiatjaf) is the recommended end-user tool for key derivation and NPUB
verification. If nak doesn't yet support offset derivation, a simple Python
script (using coincurve, ~20 lines) can serve as the verification tool.
