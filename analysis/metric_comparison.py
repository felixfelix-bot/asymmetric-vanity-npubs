#!/usr/bin/env python3
"""
Compare three metrics for vanity npub recognizability:
1. Max frequency (count of most common hex char in 16-char window)
2. Average frequency (= 16 / unique_char_count)
3. Combination of max_freq + unique_count

16 hex symbols (0-9,a-f), window of 16 chars.
"""
import random
import math
from collections import Counter
from itertools import product

HEX_SYMS = "0123456789abcdef"
W = 16  # window size
N_SIM = 5_000_000  # Monte Carlo samples

def random_hex_window():
    return ''.join(random.choice(HEX_SYMS) for _ in range(W))

def max_freq(s):
    return max(Counter(s).values())

def unique_count(s):
    return len(set(s))

def avg_freq(s):
    return W / unique_count(s)

def run_simulation():
    """Monte Carlo: count occurrences of each (max_freq, unique_count) pair."""
    max_freq_dist = Counter()
    unique_dist = Counter()
    joint_dist = Counter()  # (max_freq, unique) -> count
    
    for _ in range(N_SIM):
        s = random_hex_window()
        mf = max_freq(s)
        uc = unique_count(s)
        max_freq_dist[mf] += 1
        unique_dist[uc] += 1
        joint_dist[(mf, uc)] += 1
    
    return max_freq_dist, unique_dist, joint_dist

def p_ge(dist, threshold):
    """P(X >= threshold) from distribution counter."""
    total = sum(dist.values())
    return sum(dist[k] for k in dist if k >= threshold) / total

def p_le(dist, threshold):
    """P(X <= threshold) from distribution counter."""
    total = sum(dist.values())
    return sum(dist[k] for k in dist if k <= threshold) / total

def p_joint_ge_le(joint, mf_thresh, uc_thresh):
    """P(max_freq >= mf_thresh AND unique <= uc_thresh)"""
    total = sum(joint.values())
    return sum(joint[(m, u)] for (m, u) in joint if m >= mf_thresh and u <= uc_thresh) / total

def keys_to_grind(prob):
    if prob <= 0:
        return float('inf')
    return 1.0 / prob

def time_str(keys, rate=1_000_000):
    """Human-readable time at given keys/sec."""
    seconds = keys / rate
    if seconds < 1:
        return f"{seconds*1000:.1f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    if seconds < 3600:
        return f"{seconds/60:.1f} min"
    if seconds < 86400:
        return f"{seconds/3600:.1f} h"
    if seconds < 86400*365:
        return f"{seconds/86400:.1f} days"
    if seconds < 86400*365*1000:
        return f"{seconds/(86400*365):.1f} yr"
    if seconds < 86400*365*1e9:
        return f"{seconds/(86400*365*1e6):.1f} Myr"
    return f"{seconds/(86400*365*1e9):.1e} Gyr"

def generate_examples(target_metric, metric_fn, n=5):
    """Generate n random hex strings matching a specific metric value."""
    examples = []
    attempts = 0
    while len(examples) < n and attempts < 100000:
        s = random_hex_window()
        if metric_fn(s) == target_metric:
            examples.append(s)
        attempts += 1
    return examples

def generate_combo_examples(mf_target, uc_target, n=5):
    """Generate examples where max_freq == mf_target AND unique == uc_target."""
    examples = []
    attempts = 0
    while len(examples) < n and attempts < 200000:
        s = random_hex_window()
        if max_freq(s) == mf_target and unique_count(s) == s and unique_count(s) == uc_target:
            examples.append(s)
        attempts += 1
    return examples

def generate_combo_ge_le(mf_min, uc_max, n=5):
    """Generate examples where max_freq >= mf_min AND unique <= uc_max."""
    examples = []
    attempts = 0
    while len(examples) < n and attempts < 100000:
        s = random_hex_window()
        if max_freq(s) >= mf_min and unique_count(s) <= uc_max:
            examples.append(s)
        attempts += 1
    return examples

def format_hex_visual(s):
    """Add visual grouping to hex string for readability."""
    # Group in 4s
    return ' '.join(s[i:i+4] for i in range(0, len(s), 4))

def color_code_hex(s):
    """Return ANSI-colored hex string, each unique char gets a color."""
    colors = {
        '0': '\033[91m', '1': '\033[92m', '2': '\033[93m', '3': '\033[94m',
        '4': '\033[95m', '5': '\033[96m', '6': '\033[31m', '7': '\033[32m',
        '8': '\033[33m', '9': '\033[34m', 'a': '\033[35m', 'b': '\033[36m',
        'c': '\033[41m', 'd': '\033[42m', 'e': '\033[43m', 'f': '\033[44m',
    }
    reset = '\033[0m'
    return ''.join(f"{colors.get(c, '')}{c}{reset}" for c in s)

def print_table_header():
    print(f"{'Metric':<30} {'Threshold':<12} {'P(random)':<14} {'Keys to grind':<16} {'Time @1M/s':<14}")
    print("-" * 88)

def print_row(metric, threshold, prob):
    k = keys_to_grind(prob)
    print(f"{metric:<30} {threshold:<12} {prob:<14.2e} {k:<16.0f} {time_str(k):<14}")

def main():
    random.seed(42)
    
    print("=" * 88)
    print("VANITY NPUB METRIC COMPARISON")
    print(f"Window: {W} hex chars, {len(HEX_SYMS)} symbols, {N_SIM:,} Monte Carlo samples")
    print("=" * 88)
    
    # Run simulation
    print(f"\nRunning {N_SIM:,} simulations...")
    max_freq_dist, unique_dist, joint_dist = run_simulation()
    
    # Expected values
    e_unique = sum(k * v for k, v in unique_dist.items()) / N_SIM
    e_max_freq = sum(k * v for k, v in max_freq_dist.items()) / N_SIM
    e_avg_freq = W / e_unique
    
    print(f"\nExpected values for random key:")
    print(f"  E[unique_chars] = {e_unique:.2f}")
    print(f"  E[max_freq]     = {e_max_freq:.2f}")
    print(f"  E[avg_freq]     = {e_avg_freq:.2f}")
    
    # Distribution tables
    print(f"\n{'='*88}")
    print("DISTRIBUTION: max_freq (count of most common char)")
    print(f"{'='*88}")
    print(f"{'max_freq':<10} {'P(=k)':<14} {'P(>=k)':<14} {'Keys (>=k)':<16} {'Time @1M/s':<14}")
    print("-" * 70)
    for k in sorted(max_freq_dist.keys()):
        p_eq = max_freq_dist[k] / N_SIM
        p_ge_k = p_ge(max_freq_dist, k)
        keys = keys_to_grind(p_ge_k)
        print(f"{k:<10} {p_eq:<14.6f} {p_ge_k:<14.6e} {keys:<16.0f} {time_str(keys):<14}")
    
    print(f"\n{'='*88}")
    print("DISTRIBUTION: unique_count (distinct hex chars)")
    print(f"{'='*88}")
    print(f"{'unique':<10} {'avg_freq':<10} {'P(=k)':<14} {'P(<=k)':<14} {'Keys (<=k)':<16} {'Time @1M/s':<14}")
    print("-" * 80)
    for k in sorted(unique_dist.keys()):
        p_eq = unique_dist[k] / N_SIM
        p_le_k = p_le(unique_dist, k)
        keys = keys_to_grind(p_le_k)
        af = W / k
        print(f"{k:<10} {af:<10.2f} {p_eq:<14.6f} {p_le_k:<14.6e} {keys:<16.0f} {time_str(keys):<14}")
    
    # Comparison table
    print(f"\n{'='*88}")
    print("ANTI-SPOOFING COMPARISON")
    print(f"{'='*88}")
    print_table_header()
    
    print("\n--- Max Frequency ---")
    for t in [3, 4, 5, 6, 7, 8, 10, 12, 14, 16]:
        p = p_ge(max_freq_dist, t)
        print_row("max_freq >=", f">= {t}", p)
    
    print("\n--- Unique Count (avg_freq = 16/unique) ---")
    for t in [2, 3, 4, 5, 6, 7, 8, 10]:
        p = p_le(unique_dist, t)
        af = W / t
        print_row(f"unique <= (avg_freq>={af:.1f})", f"<= {t}", p)
    
    print("\n--- Combination (max_freq >= M AND unique <= U) ---")
    combos = [
        (4, 6), (5, 5), (6, 8), (8, 10), (5, 4), (6, 6), 
        (8, 8), (10, 10), (7, 7), (4, 4), (3, 3),
    ]
    for mf_t, uc_t in combos:
        p = p_joint_ge_le(joint_dist, mf_t, uc_t)
        print_row(f"max>={mf_t} & uniq<={uc_t}", f"{mf_t},{uc_t}", p)
    
    # Visual examples
    print(f"\n{'='*88}")
    print("VISUAL EXAMPLES — Do these look recognizable to you?")
    print(f"{'='*88}")
    
    print("\n--- MAX FREQUENCY examples ---")
    for mf_target in [3, 4, 5, 6, 8, 12, 16]:
        examples = generate_examples(mf_target, max_freq, n=3)
        if examples:
            print(f"\n  max_freq = {mf_target}  (P >= {mf_target} = {p_ge(max_freq_dist, mf_target):.2e}):")
            for ex in examples:
                uc = unique_count(ex)
                print(f"    {color_code_hex(ex)}  [unique={uc}, avg_freq={W/uc:.1f}]")
    
    print("\n--- UNIQUE COUNT examples (= avg_freq metric) ---")
    for uc_target in [2, 3, 4, 5, 6, 8, 10]:
        examples = generate_examples(uc_target, unique_count, n=3)
        if examples:
            print(f"\n  unique = {uc_target}  (avg_freq = {W/uc_target:.1f}, P <= {uc_target} = {p_le(unique_dist, uc_target):.2e}):")
            for ex in examples:
                mf = max_freq(ex)
                print(f"    {color_code_hex(ex)}  [max_freq={mf}]")
    
    print("\n--- COMBINATION examples ---")
    for mf_min, uc_max in [(4, 6), (6, 8), (8, 10), (5, 5)]:
        examples = generate_combo_ge_le(mf_min, uc_max, n=3)
        if examples:
            p = p_joint_ge_le(joint_dist, mf_min, uc_max)
            print(f"\n  max_freq >= {mf_min} AND unique <= {uc_max}  (P = {p:.2e}):")
            for ex in examples:
                mf = max_freq(ex)
                uc = unique_count(ex)
                print(f"    {color_code_hex(ex)}  [max_freq={mf}, unique={uc}, avg_freq={W/uc:.1f}]")
    
    # Blind spot analysis
    print(f"\n{'='*88}")
    print("BLIND SPOT ANALYSIS")
    print(f"{'='*88}")
    
    print("\nCase: 9 chars are 'a', other 7 are all different")
    print("  String:  aaaaaaaaa1234567  (illustrative)")
    s_blind = "aaaaaaaaa1234567"
    mf_b = max_freq(s_blind)
    uc_b = unique_count(s_blind)
    af_b = W / uc_b
    print(f"  max_freq  = {mf_b}  ← HIGH, clearly recognizable")
    print(f"  unique    = {uc_b}  ← below average (10.3) but not extreme")
    print(f"  avg_freq  = {af_b:.1f}  ← slightly above average (1.6)")
    print(f"  → max_freq catches this. unique_count partially catches it.")
    print(f"  → Combination catches it best.")
    
    print("\nCase: 5 'a's, 5 'b's, 6 'c's")
    s_blind2 = "aaaaabbbbbccccc6"
    mf_b2 = max_freq(s_blind2)
    uc_b2 = unique_count(s_blind2)
    af_b2 = W / uc_b2
    print(f"  String:  {s_blind2}")
    print(f"  max_freq  = {mf_b2}  ← moderate")
    print(f"  unique    = {uc_b2}  ← LOW (3), very recognizable")
    print(f"  avg_freq  = {af_b2:.1f}  ← HIGH (5.3), very recognizable")
    print(f"  → unique_count/avg_freq catches this better than max_freq.")
    
    print("\nCase: all different except 2 pairs")
    s_blind3 = "0123456789abcdee"
    mf_b3 = max_freq(s_blind3)
    uc_b3 = unique_count(s_blind3)
    af_b3 = W / uc_b3
    print(f"  String:  {s_blind3}")
    print(f"  max_freq  = {mf_b3}  ← low (barely above random)")
    print(f"  unique    = {uc_b3}  ← high ({uc_b3}), not recognizable")
    print(f"  avg_freq  = {af_b3:.1f}  ← low, not recognizable")
    print(f"  → None of the metrics flag this. Correct — it's not recognizable.")
    
    # Summary
    print(f"\n{'='*88}")
    print("SUMMARY: Tradeoffs")
    print(f"{'='*88}")
    print("""
MAX FREQUENCY:
  + Catches "biggest raindrop" (one char dominating)
  + Monotonic with recognizability
  + Simple to explain: "how many times does the most common digit repeat?"
  + Good anti-spoofing at high thresholds
  - Misses "aaaaabbbbbccccc" (max=5, but clearly recognizable)
  - Doesn't capture overall monotony

UNIQUE COUNT / AVG FREQUENCY:
  + Captures overall monotony (few distinct symbols)
  + avg_freq = 16/unique (same info, different scale)
  + Simple to explain: "how many different hex digits appear?"
  - Misses "aaaaaaaaa1234567" (unique=8, looks normal-ish)
  - Blind spot: high max_freq with moderate unique count

COMBINATION (max_freq + unique):
  + Catches BOTH types of patterns
  + Best anti-spoofing (harder to fake two metrics simultaneously)
  + Two-dimensional — richer classification
  - Slightly more complex to explain
  - Two thresholds to set instead of one

RECOMMENDATION:
  Use combination as primary, display both values:
    "max_repeat: N | unique: M/16"
  This gives best recognizability coverage + strongest anti-spoofing.
  Pattern recognizer (roadmap) can add even richer detection later.
""")

if __name__ == "__main__":
    main()