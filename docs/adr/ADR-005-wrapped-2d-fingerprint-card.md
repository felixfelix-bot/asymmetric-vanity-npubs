# ADR-005: Wrapped 2D Fingerprint Card Rendering

## Status

Proposed

## Date

2026-07-22

## Related

- ADR-001: Anti-phishing via low-entropy outlier discovery
- ADR-002: Split zones — disjoint charsets
- ADR-003: Multi-scale z-score outlier detection

## Context

ADR-003 produces a "winning W" — the single window position and size with the
highest z-score across all 13 scales. This is the NPUB's fingerprint anchor.

The question is how to render this fingerprint anchor to a human user for
anti-phishing verification.

Three rendering approaches were evaluated:

**1D string**: Show the winning section as highlighted text within the NPUB.
Problem: even when highlighted, a string of 16 bech32 characters is hard to
verify at a glance. The user must read each character, track position, and
compare mentally. Slow. Error-prone. Does not work at thumbnail size.

**Full 2D heatmap**: Show all W values as a position × window-size grid with
z-score colors. Problem: too much information. The user sees 13 × 58 = 754
cells. The winning W is just one row. Cognitive overload. Useful for analysis,
not for end-user identity verification.

**Wrapped 2D card**: Take ONLY the winning W characters. Wrap them into a
square grid. Render as a compact color tile. Simple, memorable, works at
thumbnail size.

## Decision

Use the **wrapped 2D fingerprint card** as the standard rendering for the
winning W section.

### Rendering Rules

```
INPUT: winning section (W characters from the NPUB)
OUTPUT: square grid of colored cells

1. Compute grid side: N = ceil(sqrt(W))
2. Fill grid left-to-right, top-to-bottom with the W characters
3. If W is not a perfect square, the last row is partially filled
4. Each cell is colored using the character's assigned palette color
5. Grid is rendered as a rounded-corner card with N×N cells
```

### Grid Sizes by Window Size

| Winning W | Grid  | Cells | Visual density |
|----------:|:-----:|------:|----------------|
| 4         | 2×2   | 4     | Minimal — very simple shape |
| 9         | 3×3   | 9     | Compact — simple recognizable shape |
| 16        | 4×4   | 16    | Standard — rich pattern, still compact |
| 20        | 5×4   | 20    | Dense — complex pattern |
| 25        | 5×5   | 25    | Maximum — most complex, highest PoW |

### Display Properties

The card encodes three pieces of information simultaneously:

1. **SHAPE** (color pattern within the grid) = fingerprint identity.
   Alice's checkerboard looks different from attacker's diagonal stripe.
   This is the primary anti-phishing signal.

2. **SIZE** (grid dimensions) = fingerprint strength.
   Larger grid = longer winning W = higher z-score = more grinding invested.
   User gets an intuitive sense of PoW without understanding z-scores.

3. **PALETTE** (which colors appear) = character set of the outlier.
   Per ADR-002, anti-phish zone uses complement charset → different palette
   from vanity zone. Two-color card (e.g., red+teal) = 2-char pattern.
   Three-color card (e.g., blue+yellow+purple) = 3-char pattern.

### Thumbnail Rendering

The card must be legible at three display sizes:

| Context        | Card size  | Cell size | Use case                      |
|----------------|-----------|-----------|-------------------------------|
| Full profile   | 144×144px | 36px      | Profile page, identity setup  |
| Contact list   | 56×56px   | 14px      | Chat app, direct messages     |
| Inline mention | 28×28px   | 7px       | Compact message header        |

At all three sizes, the card's SHAPE (color arrangement) must be
distinguishable. This requires:
- High contrast between palette colors (no two chars with similar hues)
- Minimum 2 distinct colors per card (single-color cards are a trivial edge case)
- Grid border or background to define card boundaries at small sizes

### Verification Model

The user verifies identity by RECOGNIZING the card's shape, not by reading
characters. This is pre-attentive visual processing — the same mechanism used
for face recognition, flag identification, and pattern matching.

The verification flow:

1. User sees contact's fingerprint card during initial connection
2. User's client stores the card locally (associated with the npub)
3. On subsequent interactions, client displays the stored card alongside
   the live card computed from the incoming npub
4. If cards match: green checkmark (identity confirmed)
5. If cards differ: red warning (possible phishing — different fingerprint)
6. User can manually compare: "Is this the same red-teal checkerboard I saw
   before?" — instant visual verification

This is analogous to Signal's safety numbers or SSH host key fingerprints,
but visual instead of numeric.

## Invariants

1. Card is ALWAYS rendered from the winning W section only (ADR-003 output).
2. Grid dimensions are deterministic from W: N = ceil(sqrt(W)).
3. Same NPUB always produces the same card (no randomization in rendering).
4. Card must be legible at 28×28px minimum.
5. Palette colors must be from the fixed bech32 character color mapping.
6. Vanity zone and anti-phish zone cards use disjoint palettes (per ADR-002).

## Consequences

### Positive
- Pre-attentive visual recognition (faster than reading, no character-by-character comparison)
- Works at thumbnail size in chat apps and contact lists
- Grid size implicitly communicates PoW strength
- Three orthogonal signals (shape, size, palette) make forgery obvious
- Familiar pattern: similar to identicons, GitHub avatars, Signal safety numbers
- No new concepts for end users — "look at the picture, is it the same?"

### Costs
- Partially-filled grids (non-perfect-square W) look slightly asymmetric
- Palette design matters: poor color choices reduce distinguishability
- Does not convey the full 13D fingerprint vector (ADR-003) — only the winning W
- User must have seen the card before to verify (first-contact has no reference)
- Clients must agree on the same color mapping for cross-client compatibility

## Color Palette Specification

Fixed mapping from bech32 characters to display colors. All clients MUST use
this mapping to ensure visual consistency:

```
q=#ff6b6b  p=#4ecdc4  z=#45b7d1  r=#f9ca24  y=#6c5ce7  9=#a29bfe
x=#fd79a8  8=#fdcb6e  g=#6ab04c  f=#badc58  2=#00b894  t=#00cec9
v=#0984e3  d=#6c5ce7  w=#e17055  0=#dfe6e9  s=#2d3436  3=#fab1a0
j=#74b9ff  n=#a29bfe  5=#55efc4  4=#81ecec  k=#ffeaa7  h=#dfe6e9
c=#b2bec3  e=#636e72  6=#2d3436  m=#e84393  u=#fd79a8  a=#e17055
7=#00b894  l=#0984e3
```

Colors chosen for maximum pairwise contrast in the bech32 charset. Pairs that
share hue (e.g., h=#dfe6e9 and 0=#dfe6e9) are acceptable because they are
unlikely to co-occur in a low-entropy window — if they did, the visual
similarity would itself be a recognizable feature.

## Notes

Future enhancement candidates:
- **Mirror symmetry** (like GitHub identicons): fold the grid along the
  vertical axis to double the pattern space and improve aesthetics
- **Animation**: subtle pulse or shimmer on the card to draw attention during
  identity verification prompts
- **Color-blind safe palette**: alternative palette set for accessibility
- **Card fingerprint hash**: short hash of the grid contents for text-based
  fallback (e.g., "card:qp4x" = 4×4 grid starting with qp)
