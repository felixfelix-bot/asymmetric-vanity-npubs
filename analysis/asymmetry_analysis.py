import random, math
from collections import Counter
from math import comb

BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
ALL_CHARS = set(BECH32)

VANITY = "meshmate"
VANITY_CHARS = set(VANITY)
COMPLEMENT = ALL_CHARS - VANITY_CHARS

print("=== SPLIT APPROACH: Vanity + Independent Anti-Phishing ===\n")
print(f"Vanity: '{VANITY}' uses {{{','.join(sorted(VANITY_CHARS))}}} = {len(VANITY_CHARS)} chars")
print(f"Complement: {len(COMPLEMENT)} chars (visually distinct palette)\n")

VANITY_LEN = 8
NPUB_DATA_LEN = 58

# === COMBINED (baseline) ===
print("--- APPROACH 1: COMBINED (same charset, meshmate blends in) ---\n")
k=6; W=16
p_alice = 1-(1-comb(32,k)*(k/32)**W)**43
p_atk = (k/32)**W
ac = 1/p_alice; tc = 1/p_atk
print(f"  Alice: ~2^{math.log2(ac):.1f}  Attacker: ~2^{math.log2(tc):.1f}  Asymmetry: {tc/ac:.0f}x")
print(f"  Visual: meshmate chars blend into same palette\n")

# === SPLIT: complement chars ===
print("--- APPROACH 2: SPLIT (complement charset anti-phish) ---\n")
print(f"  Vanity 'meshmate' at pos A, low-entropy window at pos B")
print(f"  Anti-phish section uses ONLY complement chars ({len(COMPLEMENT)} available)\n")

for k2 in [2,3,4,5]:
    for ap_len in [10,12,14,16]:
        # P(vanity at specific pos) — let's say we try 15 positions
        p_v = 15 * (1/32)**VANITY_LEN  # approx, small probabilities
        
        # P(anti-phish: any k2-char set from complement, in ap_len window, non-overlapping)
        # Available positions after reserving vanity zone: ~35
        p_ap_specific = (k2/32)**ap_len  # specific k2 chars
        n_sets = comb(len(COMPLEMENT), k2)
        p_ap_any = n_sets * p_ap_specific
        n_positions = 35 - ap_len + 1
        p_ap_anywhere = 1-(1-p_ap_any)**max(n_positions,1) if p_ap_any < 1 else 1
        
        if p_ap_anywhere < 1e-300:
            continue
        
        # Combined Alice
        p_alice_total = p_v * p_ap_anywhere
        if p_alice_total < 1e-300:
            continue
        alice_cost = 1/p_alice_total
        
        # Attacker: match specific vanity + specific anti-phish
        p_atk = (1/32)**VANITY_LEN * p_ap_specific
        if p_atk < 1e-300:
            continue
        atk_cost = 1/p_atk
        
        asym = atk_cost / alice_cost
        log2_asym = math.log2(asym) if asym > 0 else float('inf')
        
        print(f"  k2={k2}, anti-phish={ap_len}ch: "
              f"Alice~2^{math.log2(alice_cost):.0f} "
              f"Atk~2^{math.log2(atk_cost):.0f} "
              f"Asymmetry~2^{log2_asym:.0f}")
    print()

# === SPLIT: minimal constraint ===
print("--- APPROACH 3: SPLIT (minimal: just 'low entropy', no charset restriction) ---\n")
print("  Anti-phish section = ANY low-entropy anomaly, discovered by scanner")
print("  No charset constraint at all\n")

# From our z-score analysis
for z_thresh, p_outlier_label in [(3.0,"~3%"),(4.0,"~1%"),(5.0,"~0.3%"),(6.0,"~0.1%")]:
    p_v = 15 * (1/32)**8
    p_outlier = 10**(-z_thresh*0.7)  # rough from our data
    p_alice = p_v * p_outlier
    if p_alice < 1e-300: continue
    alice_cost = 1/p_alice
    
    print(f"  z>{z_thresh}: Alice~2^{math.log2(alice_cost):.0f}, "
          f"Attacker must match SPECIFIC anomaly (much harder)")

# === THE REAL INSIGHT ===
print("\n=== THE KEY INSIGHT ===\n")
print("Split approach INCREASES asymmetry because constraints are ORTHOGONAL:\n")
print("1. Vanity constraint: 'must contain meshmate'")
print("   -> reduces keyspace by factor 32^8 = 2^40")
print("   -> SAME for Alice and attacker (no asymmetry from this alone)\n")
print("2. Anti-phish constraint: 'must have low-entropy section'")
print("   -> Alice accepts MANY different low-entropy patterns (low cost)")
print("   -> Attacker must match ONE specific pattern (high cost)")
print("   -> THIS is where asymmetry comes from\n")
print("3. Using COMPLEMENT chars for anti-phish section:")
print("   -> Visual contrast is free (different colors)")
print("   -> Doesn't reduce Alice's keyspace more than needed")
print("   -> Maximizes entropy of the BOUNDARY between sections")
print("     (attacker can't infer anti-phish pattern from vanity chars)\n")
print("4. Minimizing constraints on anti-phish section:")
print("   -> More valid patterns = lower Alice cost")
print("   -> Same specific-match cost for attacker")
print("   -> Asymmetry = valid_patterns / 1 = MAXIMIZED")

# === GRINDING FEASIBILITY ===
print("\n=== GRINDING FEASIBILITY ===\n")
print("Most practical split: vanity='meshmate' + 2-char complement anti-phish (14 chars)")
k2=2; ap_len=14
p_v = 15*(1/32)**8
p_ap = comb(26,k2)*(k2/32)**ap_len
n_pos = 30
p_ap_any = 1-(1-p_ap)**n_pos
p_alice = p_v * p_ap_any
print(f"  P(Alice succeeds per try) = {p_alice:.2e}")
print(f"  Expected tries = {1/p_alice:.0f} = 2^{math.log2(1/p_alice):.0f}")
print(f"  At 10k keys/sec on laptop: {1/p_alice/10000:.0f} seconds")
print(f"\n  But wait — we can do this SEQUENTIALLY:")
print(f"  Step 1: grind meshmate prefix: 2^{math.log2(32**8/15):.0f} tries")
print(f"  Step 2: among those, find one with complement outlier: 2^{math.log2(1/p_ap_any):.0f} tries")
print(f"  Total: 2^{math.log2(32**8/15)+math.log2(1/p_ap_any):.0f} tries")
