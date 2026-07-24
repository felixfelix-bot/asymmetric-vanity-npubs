import random, math
from collections import Counter
import time

BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def entropy(s):
    if not s: return 0.0
    f = Counter(s); n = len(s); h = 0.0
    for c in f.values():
        p = c/n; h -= p*math.log2(p)
    return h

def unique_chars(s):
    """Count distinct characters in a string."""
    return len(set(s))

def sim():
    return ''.join(random.choice(BECH32) for _ in range(58))

WINDOW_SIZES = [3,4,5,6,7,8,9,10,12,14,16,18,20]

# Expected unique chars for 16-symbol alphabet (hex), window size w
# Formula: E[U] = k * (1 - ((k-1)/k)^n) where k=16, n=window size
# For bech32 (32 symbols), we compute empirically
SYMBOLS = 32  # bech32 alphabet size
def expected_unique(w, k=SYMBOLS):
    """Expected number of unique symbols in a window of size w, given k possible symbols."""
    return k * (1 - ((k - 1) / k) ** w)

EXPECTED = {w: expected_unique(w) for w in WINDOW_SIZES}

# === BASELINE (still useful for reference) ===
t0 = time.time()
print("=== BUILDING BASELINE (20k samples) ===")
baselines = {w: [] for w in WINDOW_SIZES}
N = 20000
for _ in range(N):
    d = sim()
    for w in WINDOW_SIZES:
        min_uc = min(unique_chars(d[i:i+w]) for i in range(58-w+1))
        baselines[w].append(min_uc)
print(f"Done in {time.time()-t0:.1f}s\n")

print(f"{'Win':>4} {'E[U]':>6} {'Mean':>6} {'p5':>6} {'p1':>6}")
for w in WINDOW_SIZES:
    vals = sorted(baselines[w])
    n = len(vals)
    mean = sum(vals)/n
    p5 = vals[int(len(vals)*0.05)]
    p1 = vals[int(len(vals)*0.01)]
    print(f"{w:4d} {EXPECTED[w]:6.2f} {mean:6.2f} {p5:6.2f} {p1:6.2f}")

# === OUTLIER SCORING (unique char count + rarity) ===
def find_outlier(data):
    """Find the window with the fewest unique characters (highest rarity).
    rarity = expected_unique - actual_unique (higher = rarer = more recognizable)
    """
    best_rarity = -999.0  # always finds something
    best = None
    for w in WINDOW_SIZES:
        if w > len(data): continue
        exp = EXPECTED[w]
        for i in range(len(data) - w + 1):
            uc = unique_chars(data[i:i+w])
            r = exp - uc  # rarity
            if r > best_rarity:
                best_rarity = r
                best = {'w':w, 'pos':i, 'unique':uc, 'rarity':r,
                        'expected':exp, 'data':data[i:i+w]}
    return best

# === DISTRIBUTION ===
print("\n=== OUTLIER RARITY DISTRIBUTION (10k random) ===\n")
scores = []
for _ in range(10000):
    d = sim()
    info = find_outlier(d)
    scores.append(info['rarity'])

scores.sort()
n = len(scores)
print(f"  p50:    {scores[n//2]:.2f}")
print(f"  p90:    {scores[int(n*0.9)]:.2f}")
print(f"  p95:    {scores[int(n*0.95)]:.2f}")
print(f"  p99:    {scores[int(n*0.99)]:.2f}")
print(f"  p99.9:  {scores[min(int(n*0.999), n-1)]:.2f}")
print(f"  max:    {scores[-1]:.2f}")

# === WHICH WINDOW SIZES WIN? ===
print("\n=== WHICH WINDOW SIZE PRODUCES MAX RARITY? ===\n")
window_wins = Counter()
for _ in range(10000):
    d = sim()
    info = find_outlier(d)
    window_wins[info['w']] += 1

for w in sorted(window_wins.keys()):
    pct = window_wins[w] / 100
    bar = '#' * int(pct)
    print(f"  w={w:2d}: {pct:5.1f}% {bar}")

# === EXAMPLE OUTLIERS ===
print("\n=== EXAMPLE OUTLIERS ===\n")
for label, target_pct in [("typical (p50)", 0.50), ("notable (p90)", 0.90), 
                            ("rare (p99)", 0.99), ("extreme (max)", None)]:
    if target_pct:
        target_r = scores[int(n * target_pct)]
    else:
        target_r = scores[-1]
    
    for _ in range(200000):
        d = sim()
        info = find_outlier(d)
        if target_pct:
            if abs(info['rarity'] - target_r) < 0.15:
                break
        else:
            if info['rarity'] > target_r - 0.2:
                break
    else:
        info = find_outlier(d)
    
    pat = info['data']
    distinct = len(set(pat))
    dstr = 'npub1' + d
    print(f"{label}: rarity={info['rarity']:.2f} | w={info['w']} pos={info['pos']} "
          f"unique={info['unique']}/{info['expected']:.1f}")
    print(f"  Pattern: '{pat}' ({distinct} distinct chars)")
    print(f"  Location in npub: ...{pat}...")
    print()

# === COMPOSITE FINGERPRINT VECTOR ===
print("=== COMPOSITE FINGERPRINT: rarity at all scales ===\n")
header = "  best " + "".join(f"w={w:<4d}" for w in WINDOW_SIZES)
print(header)
for _ in range(10):
    d = sim()
    info = find_outlier(d)
    fp = []
    for w in WINDOW_SIZES:
        exp = EXPECTED[w]
        min_uc = min(unique_chars(d[i:i+w]) for i in range(len(d)-w+1))
        r = exp - min_uc
        fp.append(r)
    print(f" {info['rarity']:.1f}  " + "".join(f"{v:5.1f} " for v in fp))

# === FEATURE TYPES ===
print("\n=== WHAT DO OUTLIERS LOOK LIKE? ===\n")
types = Counter()
for _ in range(10000):
    d = sim()
    info = find_outlier(d)
    pat = info['data']
    distinct = len(set(pat))
    if distinct == 1:
        types['single-char run'] += 1
    elif distinct == 2:
        types['2-char pattern'] += 1
    elif distinct <= 4:
        types['3-4 char'] += 1
    else:
        types['5+ chars'] += 1

for t, c in types.most_common():
    print(f"  {t}: {c/100:.1f}%")

# === GRINDING SIMULATION ===
print("\n=== GRINDING: budget vs best rarity found ===\n")
for budget in [10, 100, 1000, 10000]:
    best_r = -999
    for _ in range(budget):
        d = sim()
        info = find_outlier(d)
        if info['rarity'] > best_r:
            best_r = info['rarity']
    print(f"  {budget:>6d} tries -> best rarity = {best_r:.2f}")

