# VNAAS Grinder Server

ContextVM MCP server for vanity NPUB offset grinding over Nostr relays.

The server exposes a single MCP tool — `grind_npub` — that accepts a user's
public key and a vanity pattern, then grinds the offset `d` such that
`P + d·G` produces an NPUB containing the desired pattern. The server
**never sees the user's secret key** — only the public key and the offset.

## Architecture

```
Client (npub) → Nostr Relay → ContextVM Server → Backend Dispatcher
                                                      ↓
                                          GPU (CUDA) → Rana (Rust CPU) → Browser fallback
```

The server auto-detects available backends at startup and re-evaluates
every 60 seconds. Priority: GPU → Rana → Browser.

## Prerequisites

- **Node.js 20+** (or Bun)
- **npm** (comes with Node.js)
- **Rust + Cargo** (only if building rana from source)
- **CUDA toolkit + nvcc** (only for GPU backend)

## Quick Start (Development)

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set `VNAAS_SERVER_PRIVATE_KEY` to a hex-encoded Nostr
private key. Generate one with:

```bash
node -e "
  const {generateSecretKey, getPublicKey} = require('nostr-tools/pure');
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  console.log('Private key (hex):', Buffer.from(sk).toString('hex'));
  console.log('Public key (hex):', pk);
"
```

### 3. Build the rana binary (CPU backend)

```bash
cd ../rana-fork
cargo build --release
cp target/release/rana ../server/bin/rana
cd ../server
```

### 4. Build the GPU binary (optional, requires CUDA)

```bash
cd gpu
mkdir build && cd build
cmake .. -DCMAKE_CUDA_ARCHITECTURES=80  # adjust for your GPU arch
make -j$(nproc)
cp cuda_vanity_offset ../../bin/cuda_vanity_offset
cd ../..
```

### 5. Run the server

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

The server will start listening on the configured Nostr relays for
NIP-04 encrypted DMs addressed to the server's npub.

## Configuration

All configuration is via environment variables (`.env` file). See
`.env.example` for the full list with documentation.

### Key variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VNAAS_SERVER_PRIVATE_KEY` | Yes | — | Server's Nostr private key (hex) |
| `VNAAS_RELAYS` | No | `wss://relay.damus.io,wss://nos.lol` | Comma-separated relay URLs |
| `VNAAS_RANA_BINARY_PATH` | No | `rana` | Path to rana binary |
| `VNAAS_GPU_BINARY_PATH` | No | `cuda_vanity_offset` | Path to GPU binary |
| `VNAAS_ENABLE_GPU` | No | `true` | Attempt GPU backend detection |
| `VNAAS_ENABLE_RANA` | No | `true` | Attempt rana backend detection |
| `VNAAS_ENABLE_PAYMENTS` | No | `false` | Enable paid grinding |
| `VNAAS_CASHU_MINT_URL` | No | `https://mint.minibits.cash` | Cashu mint URL |
| `VNAAS_LN_BACKEND` | No | `none` | Lightning backend (`lnd`, `lnurl`, `none`) |
| `VNAAS_FREE_THRESHOLD` | No | `8` | Free difficulty threshold (bits) |
| `VNAAS_SATS_PER_BIT` | No | `10` | Sats per bit above threshold |

## Docker Deployment

### CPU-only (no GPU)

```bash
# Pre-build rana binary
cd rana-fork && cargo build --release
mkdir -p ../server/bin
cp target/release/rana ../server/bin/rana
cd ..

# Build and run
docker build -f docker/Dockerfile.cpu -t vnaas-grinder:cpu .
docker run --env-file server/.env vnaas-grinder:cpu
```

### GPU (CUDA)

```bash
# Pre-build rana binary (same as above)
cd rana-fork && cargo build --release
mkdir -p ../server/bin
cp target/release/rana ../server/bin/rana
cd ..

# Build and run (requires nvidia-docker)
docker build -f docker/Dockerfile.gpu -t vnaas-grinder:gpu .
docker run --gpus all --env-file server/.env vnaas-grinder:gpu
```

### Docker Compose

```bash
# CPU
docker compose --profile cpu up -d

# GPU
docker compose --profile gpu up -d
```

## Health Check

The server optionally runs an HTTP health endpoint on `VNAAS_PORT` (default 3000):

```
GET /health → {
  "status": "ok",
  "npub": "npub1...",
  "backends": {
    "gpu": { "available": true, "device": "RTX 4090", "rate": "50M/s" },
    "rana": { "available": true, "version": "0.6.0", "rate": "800K/s" },
    "browser": { "available": true }
  },
  "uptime": "3d 4h",
  "grinds_completed": 42
}
```

## How It Works

1. **Client** generates a Nostr keypair locally (has nsec + npub)
2. **Client** sends an MCP `grind_npub` request via NIP-04 encrypted DM to
   the server's npub, including their public key and desired vanity pattern
3. **Server** dispatches to the fastest available backend:
   - **GPU** (CUDA): 10–50M keys/sec — EC point addition in CUDA kernel
   - **Rana** (Rust): 200K–1M keys/sec — offset grinding via `secp256k1`
   - **Browser fallback**: returns JS code for client-side grinding
4. **Backend** grinds: for `d = 1, 2, 3, ...`, computes `P + d·G`,
   bech32-encodes the result, checks for the vanity pattern
5. **Server** returns the offset `d` and vanity NPUB to the client
6. **Client** verifies: `new_npub == bech32((k + d) mod n · G)`
7. **Client** applies: `new_nsec = (old_nsec + d) mod n`

The server never sees, holds, or needs the user's secret key.

## Project Structure

```
server/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Environment config loader
│   ├── types.ts                 # Shared type definitions
│   ├── server/
│   │   ├── contextvm-server.ts  # ContextVM MCP server setup
│   │   └── tools.ts             # MCP tool definitions (grind_npub)
│   ├── backends/
│   │   ├── types.ts             # GrindBackend interface
│   │   ├── dispatcher.ts        # Backend selector (GPU → rana → browser)
│   │   ├── detector.ts          # Auto-detect available backends
│   │   ├── gpu-backend.ts       # GPU (CUDA) subprocess wrapper
│   │   ├── rana-backend.ts      # Rana (Rust CLI) subprocess wrapper
│   │   └── browser-backend.ts   # Client-side fallback
│   ├── grinding/
│   │   ├── offset.ts            # Offset math: P + d·G, bech32 encoding
│   │   ├── vanity-check.ts      # Pattern matching
│   │   ├── entropy-scanner.ts   # Multi-scale unique char count scan
│   │   └── verify.ts            # Verify offset correctness
│   ├── payment/
│   │   ├── pricing.ts           # Cost calculation
│   │   ├── cashu.ts             # Cashu ecash token handling
│   │   ├── lightning.ts         # Lightning invoice generation
│   │   └── atomic-swap.ts       # Hash-locked atomic swap (ADR-008)
│   └── utils/
│       ├── bech32.ts            # bech32 encode/decode
│       ├── crypto.ts            # secp256k1 point operations
│       └── logger.ts            # Structured logging
├── gpu/                         # CUDA kernel source
├── package.json
├── tsconfig.json
├── .env.example
└── README.md                    # ← you are here
```

## Testing

```bash
npm test
```

Tests cover:
- Offset math verification (P + d·G correctness)
- Backend dispatch and fallback chain
- Entropy scanner unique char count computation
- Payment pricing and Cashu token handling
- NIP-04 encryption/decryption roundtrip

## See Also

- [Implementation Plan](../docs/IMPLEMENTATION-PLAN.md) — full architecture and phases
- [ADR-006: Offset Grinding](../docs/adr/ADR-006-offset-grinding.md)
- [ADR-007: Rana Fork](../docs/adr/ADR-007-rana-fork.md)
- [ADR-008: Atomic Sale](../docs/adr/ADR-008-atomic-sale.md)
- [BLOCKERS.md](../BLOCKERS.md) — known issues and untested components