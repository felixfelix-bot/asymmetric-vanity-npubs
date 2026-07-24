# ADR-009: Unique Char Count as Primary Raindrop Metric

**Status:** Accepted  
**Date:** 2026-07-24  
**Supersedes:** ADR-003 (partially — Z-score demoted to secondary)

## Context

The original implementation (ADR-003) used Shannon entropy Z-score as the primary metric for detecting recognizable windows in vanity npubs. While statistically rigorous, Z-score is:

- **Non-intuitive** — "z=6.31" doesn't communicate recognizability to users
- **Computationally indirect** — requires baseline mean/std tables per window size
- **Overkill** — the dramatic cases (long runs of same char) are obvious without statistical modeling

User feedback identified a simpler, more direct metric: **unique character count** within a sliding window. A window of 16 hex characters that contains only 1 or 2 unique symbols is visually striking and astronomically rare — no statistics needed.

## Decision

Replace Z-score with **unique character count** as the primary raindrop/recognizability metric.

- **Lower unique count = rarer = more recognizable**
- Scanner ranks windows by unique char count ascending (fewest = best)
- Z-score retained as **secondary** display info for statistical context

### Expected Unique Characters (Occupancy Distribution)

For hex (16 symbols), window of size W:

| Window Size (W) | Expected Unique E[U] | Std Dev |
|------------------|---------------------|---------|
| 16               | ~10.3               | ~1.6    |
| 25               | ~12.1               | ~1.3    |
| 36               | ~13.5               | ~1.0    |
| 49               | ~14.5               | ~0.8    |

Formula: E[U] = k × (1 - ((k-1)/k)^n) where k=16 symbols, n=window size

### Rarity Examples (W=16)

| Unique Chars | Example | Approximate Probability |
|--------------|---------|------------------------|
| 1            | `0000000000000000` | ~10⁻¹⁸ |
| 2            | `0000000000000aa0` | ~10⁻¹³ |
| 3            | `00000000aa00bb0`  | ~10⁻⁹  |
| 4            | `0a0b0c0d00000000` | ~10⁻⁶  |

## Consequences

### Positive

- **Simpler computation** — `len(set(window))`, no baseline tables needed
- **More intuitive** — "2 unique chars" is immediately understandable
- **Exactly computable** — probability distribution via occupancy/Stirling numbers
- **Unified metric** — serves both raindrop counting and recognizability scoring

### Negative

- **Misses structured patterns** — "deadbeefdeadbeef" has 8 unique chars (unremarkable) but is highly recognizable (repeating pattern)
- **Misses sequential patterns** — "0123456789abcdef" has 16 unique chars (maximum diversity) but is the most recognizable string possible
- **Misses palindromes/symmetry** — structural patterns with normal diversity

## Future Work

**Pattern Recognizer (Roadmap):** A secondary detection layer that identifies structured patterns the unique char count misses:

- Repeating substrings (e.g., "deadbeefdeadbeef")
- Sequential runs (e.g., "0123456789abcdef")
- Palindromic windows
- Other structural regularities

This would be a **secondary metric** alongside unique char count, not a replacement. Two scores: one for character diversity (unique count), one for structural pattern (recognizer).