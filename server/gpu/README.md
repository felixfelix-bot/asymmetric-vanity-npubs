# GPU CUDA Backend — Vanity NPUB Offset Grinding

Fork of the [`v0l/cuda_vanity`](https://github.com/v0l/cuda_vanity) approach,
modified for **offset grinding** (`P + d·G`) instead of fresh keypair
generation (`d·G`).

## Overview

This backend runs a CUDA kernel on NVIDIA GPUs to grind vanity NPUB offsets
at 10–50M keys/sec. It accepts a user's **public key** (npub) and a vanity
pattern, then searches for an offset `d` such that the NPUB of `P + d·G`
contains the desired pattern.

**The server never sees the user's secret key.** The user applies the offset
locally: `new_nsec = (old_nsec + d) mod n`.

## Algorithm

```
Input:  P (user's public key), pattern (vanity string)
Output: d (offset integer)

for d = 1, 2, 3, ...:
    Q = P + d·G          ← EC point addition (no secret key needed)
    npub = bech32(Q.x)   ← Encode x-coordinate as NPUB
    if npub contains pattern:
        return d
```

### GPU Optimization

Each thread uses **incremental point addition**:
- Thread computes `P + start·G` once (full scalar multiplication)
- Subsequent keys use `Q_{d+1} = Q_d + G` (one EC point addition per key)
- This reduces per-key cost from O(256) multiplications to O(1) addition

## Build

### Prerequisites

- NVIDIA GPU (compute capability 6.0+)
- CUDA Toolkit 11.0+ (`nvcc`)
- CMake 3.18+
- GCC 9+ or Clang 10+

### Build Instructions

```bash
cd server/gpu
mkdir -p build && cd build
cmake .. -DCMAKE_CUDA_ARCHITECTURES=80   # adjust for your GPU arch
make -j$(nproc)
```

The binary `cuda_vanity_offset` will be in `build/`.

### Auto-detect GPU Architecture

```bash
# Check your GPU's compute capability
nvidia-smi --query-gpu=compute_cap --format=csv

# Common architectures:
#   60 = Pascal (GTX 10x0)
#   70 = Volta (V100)
#   75 = Turing (RTX 20x0)
#   80 = Ampere (A100)
#   86 = Ampere (RTX 30x0)
#   89 = Ada (RTX 40x0)
#   90 = Hopper (H100)
```

## Usage

### Basic

```bash
./cuda_vanity_offset --pubkey npub1xyz... --pattern meshmate
```

### JSON Output (for VNAAS server)

```bash
./cuda_vanity_offset --pubkey npub1xyz... --pattern meshmate --json --timeout 300
```

### Probe Mode (check GPU availability)

```bash
./cuda_vanity_offset --probe
# Output: {"status":"ok","device_count":1,"devices":[{"id":0,"name":"NVIDIA GeForce RTX 3090","compute_capability":"8.6"}]}
```

### All Options

```
Required:
  --pubkey <npub>      User's public key (npub1...)
  --pattern <str>      Vanity pattern to match

Options:
  --suffix <str>       Also match suffix pattern
  --timeout <secs>     Max grind time (default: 300)
  --json               Output JSON for machine consumption
  --probe              Probe for CUDA device and exit
  --batch-size <n>     Keys per thread per launch (default: 1024)
  --blocks <n>         CUDA blocks (default: auto-detect)
  --threads <n>        Threads per block (default: 256)
  --scan-entropy       Scan for entropy outlier after match
  --min-unique <n>     Minimum unique char count for entropy acceptance
  --help               Show this help
```

## Output Format

### JSON (found)

```json
{
  "status": "found",
  "offset": "42",
  "npub": "npub1meshmate...",
  "keys_tried": 1000000,
  "duration_secs": 0.5,
  "rate_per_sec": 2000000,
  "backend": "gpu"
}
```

### JSON (timeout)

```json
{
  "status": "timeout",
  "tried": 50000000,
  "duration_secs": 5.0,
  "rate_per_sec": 10000000
}
```

### JSON (error)

```json
{
  "status": "error",
  "message": "No CUDA device found"
}
```

## File Structure

```
server/gpu/
├── CMakeLists.txt              # CMake build configuration
├── README.md                  # This file
├── src/
│   ├── offset_grind.cu        # CUDA kernel + host-side bech32 helpers
│   └── main.cu                # CLI entry point with --pubkey, --pattern, --json
└── include/
    ├── secp256k1.cuh          # secp256k1 curve params, EC point ops (device)
    └── vanity.cuh             # Bech32 encoding + pattern matching (device)
```

## Architecture Notes

### secp256k1 on GPU

The secp256k1 curve operations are implemented entirely in CUDA device code:
- 256-bit modular arithmetic (add, sub, mul, inverse) using 4×uint64 limbs
- Jacobian coordinate point addition and doubling
- Scalar multiplication via double-and-add
- Incremental addition (`point_add_G`) for the hot path

### Bech32 on GPU

Bech32 encoding is done on-device to avoid copying every key back to the host:
- 8-to-5 bit conversion
- Bech32 polymod checksum computation
- Only matched results are copied back to host

### Integration with VNAAS Server

The server's `gpu-backend.ts` spawns this binary as a subprocess:

```typescript
const args = [
  '--pubkey', npub,
  '--pattern', pattern,
  '--timeout', String(timeoutSecs),
  '--json',
];
const proc = spawn('cuda_vanity_offset', args);
// Parse JSON stdout for result
```

## Performance

| GPU              | Keys/sec  | Notes                          |
|------------------|-----------|--------------------------------|
| RTX 3090         | ~30M/s    | 10496 CUDA cores, 1.7GHz       |
| RTX 4090         | ~50M/s    | 16384 CUDA cores, 2.5GHz      |
| A100             | ~40M/s    | Data center, 40GB HBM          |
| GTX 1080         | ~10M/s    | Pascal, 2560 cores             |

Performance depends on pattern length (longer = more comparisons per key)
and whether the pattern is a prefix match (fast path) or contains match
(slower, full string scan).

## Limitations

- **No point decompression on host**: The current code passes the x-coordinate
  directly. In production, use libsecp256k1 on the host to decompress the
  user's public key to a full `(x, y)` point before copying to the GPU.
- **No entropy scanning**: The `--scan-entropy` flag is accepted but not yet
  implemented in the kernel. Entropy scanning is done server-side in
  TypeScript.
- **Suffix matching**: The `--suffix` flag is accepted but not yet
  implemented in the device-side pattern matcher.

## License

Same as the parent project (asymmetric-vanity-npubs).