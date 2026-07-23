# PR Plan: Entropy-based npub mining for rana

- **Branch**: `feat/entropy-mining`, based off clean `upstream/main` (`bb4d6b8`, v0.5.5).
- **Goal**: Two opt-in mining modes that produce visually recognizable npubs with an asymmetric anti-impersonation advantage (Zucos triangle mitigation).
- **Commit 1** (done): `--entropy-threshold` — full-string Shannon entropy mode.
- **Commit 2** (in progress): `--entropy-difficulty` — dynamic edge-resolver mode with difficulty metric `L×(5−H)`.

## Motivation (the "why")

Vanity npubs (e.g. `npub1rana…`) are forgeable: an attacker can mine a look-alike
prefix at the same cost the original holder paid. This is the **Zucos triangle**
problem — the vanity property is symmetric, so it provides no lasting identity
guarantee.

Mining for a *target entropy* instead flips this into an **asymmetric** defense:

- The holder picks npubs with unusually low Shannon entropy (high character
  repetition / visual order) in the bech32 data portion.
- An attacker can reproduce the *property* "low entropy" at similar cost, but the
  residual randomness in the bech32 encoding forces the resulting npub to look
  recognisably *different* from the original.
- Pattern-imitation is not identity-imitation. The holder keeps a visual edge.

## Two mining modes

### Mode 1: `--entropy-threshold <FLOAT>` (commit 1 — done)

Simple full-string Shannon entropy. User specifies max entropy (0.0–5.0 bits/char).
Visually subtle because repetition is diluted across 59 characters.

### Mode 2: `--entropy-difficulty <FLOAT>` (commit 2 — in progress)

Dynamic edge-resolver that auto-discovers the best prefix or suffix edge. Uses the
**difficulty metric**: `L × (5−H)` ("bits of pattern"). The npub is self-describing
— any client can compute the optimal display edge without knowing mining parameters.

**Why `L×(5−H)` instead of `2^L×(5−H)`**: The exponential `2^L` overwhelms the
entropy term — random 20-char edges would outscore genuinely mined 10-char edges.
`L×(5−H)` correctly rewards both length and low entropy; random edges score ~0–8,
mined edges score 40+. Directly analogous to rana's existing `--difficulty` (leading
zero bits).

**Formula constants**: `5.0 = log₂(32)` is the maximum Shannon entropy of the bech32
alphabet. Not arbitrary — determined by the 32-symbol charset. Any positive scalar
multiplier on the whole metric preserves the ranking (cosmetic only).

## Architecture decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Mode combination | All modes mutually exclusive | Matches existing `check_args()` convention. |
| Entropy base | bech32 npub data portion (strips `npub1`) | Matches visual-recognition motivation. |
| Match behavior | Continuous; track best-so-far; emit milestones | Mirrors existing vanity UX. User Ctrl+C's. |
| Difficulty formula | `L × (5−H)` bits of pattern | Bounded, principled, rewards long+low-entropy. |
| Edge resolution | `best_edge()` scans prefix/suffix lengths 1..29 | O(1,856) ops/npub — trivial vs secp256k1 keygen. |
| Edge visibility | Colored green highlighting in terminal output | Zero mining cost; npub stays clean for copy/paste. |
| Branch base | Clean `upstream/main` | PR contains only entropy commits. |
| Test depth | Unit tests only, colocated in `src/entropy.rs` | Zero new `[dev-dependencies]`. |
| nsite demo | Separate repo (`entropy-edge-demo`) | Reference JS impl for client developers. |

## Change list

### Rust changes (`feat/entropy-mining` branch)

#### `src/entropy.rs`
- `shannon_entropy(s)`, `npub_entropy(npub)`, `BECH32_MAX_ENTROPY` (done)
- `EdgeSide` enum, `EdgeResult` struct (done)
- `edge_difficulty(data)` → `L × (5−H)` (done)
- `best_edge(npub) → EdgeResult` — incremental prefix/suffix scan (done)
- Unit tests for all new functions (in progress)

#### `src/cli.rs`
- `--entropy-threshold <f64>` (done)
- `--entropy-difficulty <f64>` (in progress) — joins mutual-exclusion counter

#### `src/main.rs`
- `--entropy-threshold` mining branch (done)
- `--entropy-difficulty` mining branch (in progress) — calls `best_edge()`,
  tracks best difficulty, colored milestone output showing winning edge
- Benchmark skip for both entropy modes (done for threshold)

#### `README.md`
- `--entropy-threshold` docs (done)
- `--entropy-difficulty` docs (in progress)

### nsite demo (`entropy-edge-demo` repo — separate)

Static single-page app, no build step, no dependencies. Reference JS implementation
of `best_edge()` for Nostr client developers.

- `app.js` — Shannon entropy + `bestEdge()` resolver + DOM rendering (~200 lines)
- `index.html` — 3 sections: interactive resolver, gallery, formula explainer (~80 lines)
- `style.css` — dark theme, green edge highlights, bar chart (~80 lines)
- `README.md` — nsite publishing instructions + formula reference

**Section 1 — Interactive resolver**: paste npub → see best edge highlighted green +
bar chart of difficulty vs edge length.
**Section 2 — Gallery**: random vs mined npubs side-by-side.
**Section 3 — Explainer**: formula breakdown + Zucos triangle.

## Testing strategy

Unit tests only, no new dependencies. `cargo test --verbose` (existing CI).

**Existing tests (9)**: empty, repeated char, distinct chars, bech32 cap, prefix
stripping, bounds, monotonicity, symmetry.

**New tests for difficulty mode**: `best_edge` on random npub (low difficulty),
repetitive prefix (prefix wins), repetitive suffix (suffix wins), `edge_difficulty`
on known strings, empty string, monotonicity.

## Performance framing

- secp256k1 keygen (~µs) dominates the loop.
- `best_edge()` per npub: O(1,856) ops ≈ ~500ns.
- **Existing modes: zero cost** — new branches never taken when flags absent.
- **Entropy modes**: ~10-20% slower than pure difficulty. Disclosed in PR body.

## Pre-PR verification

1. `cargo fmt --all && cargo clippy --all-targets`
2. `cargo test --verbose` — all tests pass
3. `cargo build --release`
4. Smoke: `--entropy-difficulty 40` (should find milestones),
   `--entropy-difficulty 40 -d 10` (panic: mutual exclusion),
   `-e 4.0` (threshold mode still works), `-d 10` (no regression)
5. Diff scoped to expected files.

## Risks / out-of-scope

- `BestMatch.entropy` field reused as "best difficulty" in difficulty mode — init
  `f64::MAX` works for min-tracking (threshold) but difficulty uses max-tracking.
  Need to handle both modes or use separate field.
- Pre-existing `calculate_string_similarity` duplication NOT refactored.
- No `benches/` infrastructure — performance claims are manual.

---

## Checklist

### Commit 1: `--entropy-threshold` (full-string entropy mode) — DONE

- [x] Create `feat/entropy-mining` branch off clean `upstream/main`
- [x] Implement `src/entropy.rs` (`shannon_entropy` + `npub_entropy` + 9 unit tests)
- [x] Register `pub mod entropy;` in `src/lib.rs` (centralised `BECH32_PREFIX`)
- [x] Add `--entropy-threshold` CLI arg + `check_args` validation in `src/cli.rs`
- [x] Wire entropy branch into mining loop in `src/main.rs`
- [x] Update `README.md`
- [x] `cargo fmt` / `cargo clippy` / `cargo test` (11 passed) / `cargo build --release`
- [x] Smoke tests pass
- [x] Committed `c00cc6a`, pushed to `github/feat/entropy-mining`

### Commit 2: `--entropy-difficulty` (dynamic edge resolver) — DONE

- [x] Add `BECH32_MAX_ENTROPY` constant to `src/entropy.rs`
- [x] Add `EdgeSide` enum + `EdgeResult` struct to `src/entropy.rs`
- [x] Add `edge_difficulty()` function to `src/entropy.rs`
- [x] Add `best_edge()` function to `src/entropy.rs`
- [x] Add unit tests for `edge_difficulty` + `best_edge` in `src/entropy.rs` (11 new)
- [x] Add `--entropy-difficulty` CLI arg + validation in `src/cli.rs`
- [x] Wire difficulty mining branch + colored output in `src/main.rs`
- [x] Update `README.md` with `--entropy-difficulty` docs
- [x] `cargo fmt` / `cargo clippy` / `cargo test` (21 passed) / `cargo build --release`
- [x] Smoke test: `--entropy-difficulty 25` (milestones 28→48 bits), mutual exclusion, validation
- [x] Commit `f786d5e`, pushed to `github/feat/entropy-mining`

### nsite demo (`entropy-edge-demo`) — DONE

- [x] Create new repo `/home/c03rad0r/entropy-edge-demo/`
- [x] Implement `app.js` (entropy math + `bestEdge()` resolver + rendering)
- [x] Create `index.html` (3 sections: resolver, gallery, explainer)
- [x] Create `style.css` (dark theme, green highlights, bar chart)
- [x] Create `README.md` (nsite publishing + formula reference)
- [x] Verified JS `bestEdge()` matches Rust `best_edge()` on 3 test npubs
- [x] Committed `4aa2a97`

### Pre-PR (manual)

- [ ] Write the PR body (motivation, non-breaking claim, performance notes)
- [ ] Commit + push final state
- [ ] Open PR against `grunch/rana`

