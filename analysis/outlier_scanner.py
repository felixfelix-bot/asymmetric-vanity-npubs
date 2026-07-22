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

def sim():
    return ''.join(random.choice(BECH32) for _ in range(58))

WINDOW_SIZES = [3,4,5,6,7,8,9,10,12,14,16,18,20]

# === BASELINE ===
t0 = time.time()
print("=== BUILDING BASELINE (20k samples) ===")
baselines = {w: [] for w in WINDOW_SIZES}
N = 20000
for _ in range(N):
    d = sim()
    for w in WINDOW_SIZES:
        min_h = min(entropy(d[i:i+w]) for i in range(58-w+1))
        baselines[w].append(min_h)
print(f"Done in {time.time()-t0:.1f}s\n")

stats = {}
for w in WINDOW_SIZES:
    vals = sorted(baselines[w])
    n = len(vals)
    mean = sum(vals)/n
    std = (sum((v-mean)**2 for v in vals)/n)**0.5
    stats[w] = {'mean':mean, 'std':std if std > 0.001 else 0.001}

print(f"{'Win':>4} {'Mean':>6} {'Std':>6} {'p5':>6} {'p1':>6}")
for w in WINDOW_SIZES:
    s = stats[w]
    vals = sorted(baselines[w])
    p5 = vals[int(len(vals)*0.05)]
    p1 = vals[int(len(vals)*0.01)]
    print(f"{w:4d} {s['mean']:6.2f} {s['std']:6.3f} {p5:6.2f} {p1:6.2f}")

# === OUTLIER SCORING (always returns something) ===
def find_outlier(data):
    best_z = -999.0  # always finds something
    best = None
    for w in WINDOW_SIZES:
        if w > len(data): continue
        s = stats[w]
        for i in range(len(data) - w + 1):
            h = entropy(data[i:i+w])
            z = (s['mean'] - h) / s['std']
            if z > best_z:
                best_z = z
                best = {'w':w, 'pos':i, 'entropy':h, 'z':z, 'data':data[i:i+w]}
    return best

# === DISTRIBUTION ===
print("\n=== OUTLIER z-SCORE DISTRIBUTION (10k random) ===\n")
scores = []
for _ in range(10000):
    d = sim()
    info = find_outlier(d)
    scores.append(info['z'])

scores.sort()
n = len(scores)
print(f"  p50:    {scores[n//2]:.2f}")
print(f"  p90:    {scores[int(n*0.9)]:.2f}")
print(f"  p95:    {scores[int(n*0.95)]:.2f}")
print(f"  p99:    {scores[int(n*0.99)]:.2f}")
print(f"  p99.9:  {scores[min(int(n*0.999), n-1)]:.2f}")
print(f"  max:    {scores[-1]:.2f}")

# === WHICH WINDOW SIZES WIN? ===
print("\n=== WHICH WINDOW SIZE PRODUCES MAX OUTLIER? ===\n")
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
        target_z = scores[int(n * target_pct)]
    else:
        target_z = scores[-1]
    
    for _ in range(200000):
        d = sim()
        info = find_outlier(d)
        if target_pct:
            if abs(info['z'] - target_z) < 0.15:
                break
        else:
            if info['z'] > target_z - 0.2:
                break
    else:
        info = find_outlier(d)
    
    pat = info['data']
    distinct = len(set(pat))
    dstr = 'npub1' + d
    print(f"{label}: z={info['z']:.2f} | w={info['w']} pos={info['pos']} H={info['entropy']:.2f}")
    print(f"  Pattern: '{pat}' ({distinct} distinct chars)")
    marker_start = info['pos']
    marker_end = info['pos'] + info['w']
    display = dstr[:6] + '...' + dstr[marker_start+5:marker_end+5]
    print(f"  Location in npub: ...{pat}...")
    print()

# === COMPOSITE FINGERPRINT VECTOR ===
print("=== COMPOSITE FINGERPRINT: z-scores at all scales ===\n")
header = "  z    " + "".join(f"w={w:<4d}" for w in WINDOW_SIZES)
print(header)
for _ in range(10):
    d = sim()
    info = find_outlier(d)
    fp = []
    for w in WINDOW_SIZES:
        s = stats[w]
        min_h = min(entropy(d[i:i+w]) for i in range(len(d)-w+1))
        z = (s['mean'] - min_h) / s['std']
        fp.append(z)
    print(f" {info['z']:.1f}  " + "".join(f"{v:5.1f} " for v in fp))

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
print("\n=== GRINDING: budget vs best outlier found ===\n")
for budget in [10, 100, 1000, 10000]:
    best_z = 0
    for _ in range(budget):
        d = sim()
        info = find_outlier(d)
        if info['z'] > best_z:
            best_z = info['z']
    print(f"  {budget:>6d} tries -> best z = {best_z:.2f}")

