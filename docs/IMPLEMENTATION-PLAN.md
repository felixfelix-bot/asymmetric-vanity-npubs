# Implementation Plan: ContextVM Vanity NPUB Grinding Server

## Status

Proposed — 2026-07-23

## Related ADRs

- ADR-006: Offset Grinding — VNAAS Without Key Custody
- ADR-007: Tooling Strategy — Fork Rana for Offset Grinding
- ADR-008: Atomic Sale of Grinding Offsets

## Overview

This document specifies the backend system for the asymmetric-vanity-npubs
project: a **ContextVM server** that exposes vanity NPUB offset grinding as an
MCP (Model Context Protocol) tool over Nostr relays. The server dispatches
grinding work through a tiered fallback chain:

```
GPU (CUDA) → Rana (Rust CPU) → Browser client-side JS
```

The server auto-detects available backends at startup and continuously
re-evaluates. Clients (Nostr apps, AI agents, browsers) call the MCP tool with
their public key and desired vanity pattern. The server grinds using offset
mathematics (P + d·G) — never seeing the user's secret key — and returns the
offset integer `d`.

---

## Architecture

```
                         ┌─────────────────────────────────────────────────┐
                         │              Nostr Relay Network                  │
                         │  (wss://relay.damus.io, wss://nos.la, etc.)      │
                         └────────────┬───────────────────┬────────────────┘
                                      │                   │
                          MCP JSON-RPC │                   │ MCP JSON-RPC
                          (NIP-04 DMs)  │                   │ (NIP-04 DMs)
                                      │                   │
                         ┌────────────▼──────┐  ┌────────▼─────────┐
                         │  ContextVM Server  │  │  Nostr Client /   │
                         │  (TypeScript/Node) │  │  AI Agent / Browser│
                         │                    │  │                    │
                         │  @contextvm/sdk    │  │  @noble/secp256k1  │
                         │                    │  │  (client-side      │
                         │  ┌──────────────┐  │  │   fallback grind)  │
                         │  │ MCP Tool:    │  │  └────────────────────┘
                         │  │ grind_npub   │  │
                         │  │ ─────────── │  │
                         │  │ Backend      │  │
                         │  │ Dispatcher   │  │
                         │  └──────┬──────┘  │
                         │         │         │
                         │  ┌──────▼──────┐  │
                         │  │ Auto-Detect │  │
                         │  │ ┌─────────┐ │  │
                         │  │ │  GPU?   │ │  │  ┌─────────────────────┐
                         │  │ │ CUDA    │─┼──┼─▶│ GPU Backend          │
                         │  │ │ kernel  │ │  │  │ (fork of v0l/        │
                         │  │ └────┬────┘ │  │  │  cuda_vanity)        │
                         │  │      ▼      │  │  │                      │
                         │  │ ┌─────────┐ │  │  │ EC point addition    │
                         │  │ │ Rana?   │─┼──┼─▶│ in CUDA kernel       │
                         │  │ │ Rust    │ │  │  │ 10-50M keys/sec     │
                         │  │ │ CLI     │ │  │  └─────────────────────┘
                         │  │ └────┬────┘ │  │
                         │  │      ▼      │  │  ┌─────────────────────┐
                         │  │ ┌─────────┐ │  │  │ Rana Backend         │
                         │  │ │ Browser │─┼──┼─▶│ (Rust subprocess)    │
                         │  │ │ Fallback│ │  │  │                      │
                         │  │ └─────────┘ │  │  │ Fork: felixfelix-bot  │
                         │  └─────────────┘  │  │ /rana offset mode    │
                         │                   │  │ 200K-1M keys/sec     │
                         │  Payment Handler  │  └─────────────────────┘
                         │  (Cashu/LN)       │
                         └───────────────────┘
```

### Data Flow: Grinding Request

```
1. Client generates keypair locally → has nsec (secret) + npub (public)
2. Client calls MCP tool `grind_npub` with:
   - npub (public key only)
   - vanity_pattern (e.g., "meshmate")
   - options: min_entropy_outlier, max_cost_sats, timeout_secs
3. Server receives MCP JSON-RPC request over Nostr DM (NIP-04 encrypted)
4. Server dispatches to fastest available backend:
   a. GPU backend (if CUDA device detected) → 10-50M keys/sec
   b. Rana CLI subprocess (if rana binary available) → 200K-1M keys/sec
   c. Return "use_client_fallback" instruction → browser grinds locally
5. Backend grinds: for d = 1, 2, 3, ...:
   - Compute P + d·G (EC point addition, no secret key needed)
   - bech32-encode result → check for vanity pattern
   - On match: optionally scan for entropy outlier (ADR-003/004)
6. Server returns result:
   - Found: { offset: d, vanity_npub: "npub1...", unique_chars: 3, rarity: 7.3, ... }
   - Not found (timeout): { status: "timeout", tried: N, rate: "X/s" }
   - Payment required: { invoice: "lnbc...", cashu_token: "..." }
7. Client verifies: new_npub == bech32((k + d) mod n · G)
8. Client applies: new_nsec = (old_nsec + d) mod n
```

---

## ContextVM Server Structure

### Technology Stack

- **Runtime**: Node.js 20+ (or Bun)
- **Language**: TypeScript (strict mode)
- **Framework**: `@contextvm/sdk` — MCP server over Nostr
- **Crypto**: `@noble/secp256k1` + `@noble/hashes` (for verification, bech32)
- **Nostr**: `nostr-tools` (event creation, NIP-04 encryption, NIP-19 encoding)
- **Payment**: `@cashu/cashu-ts` (Cashu ecash), `lightning` (LN invoices)
- **Subprocess**: `child_process` (for rana CLI), `ffi-napi` (optional FFI path)

### MCP Tool Definition

The server exposes a single MCP tool:

```typescript
// Tool name: grind_npub
// Tool description: Grind a vanity NPUB offset for a given public key.
//   The server never sees the secret key. Uses offset grinding (P + d·G).
//   Dispatches to GPU, CPU (rana), or instructs client to grind in-browser.

interface GrindNpubParams {
  npub: string;              // User's public key (npub1...)
  vanity_pattern: string;    // Desired vanity word/prefix in the NPUB
  options?: {
    suffix?: string;          // Also match suffix pattern
    min_unique_chars?: number; // Minimum unique char count rarity (ADR-009)
    min_window_size?: number; // Minimum fingerprint window size (16|25|36|49)
    timeout_secs?: number;    // Max grind time (default: 300)
    max_cost_sats?: number;   // Max willing to pay (for paid grinding)
  };
}

interface GrindNpubResult {
  status: "found" | "timeout" | "payment_required" | "use_client_fallback";
  // When found:
  offset?: string;            // The offset d (as decimal string, can be large)
  vanity_npub?: string;       // The resulting NPUB (npub1...)
  unique_chars?: number;       // Unique chars in best window (if scanned)
  rarity?: number;             // Rarity score = expectedUnique - uniqueChars (ADR-009)
  fingerprint_window?: {
    size: number;             // W value (16, 25, 36, 49)
    position: number;          // Position in the bech32 data part
    unique_chars: number;     // Fewer = more recognizable
    quality_db: number;        // 10·log₁₀(z/unique³) in dB
  };
  grind_stats?: {
    keys_tried: number;
    duration_secs: number;
    rate_per_sec: number;
    backend: "gpu" | "rana" | "browser";
  };
  // When payment_required:
  invoice?: string;           // Lightning invoice or Cashu token
  hash_commitment?: string;   // SHA256(d) for atomic swap (ADR-008)
  // When use_client_fallback:
  fallback_reason?: string;   // Why server couldn't grind
}
```

---

## File Structure

```
server/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
│
├── src/
│   ├── index.ts                 # Entry point — starts ContextVM server
│   ├── config.ts                # Environment config, relay URLs, keys
│   │
│   ├── server/
│   │   ├── contextvm-server.ts  # ContextVM MCP server setup
│   │   ├── tools.ts             # MCP tool definitions (grind_npub)
│   │   └── nostr-handler.ts     # Nostr event handling, NIP-04 encryption
│   │
│   ├── backends/
│   │   ├── types.ts             # GrindBackend interface, shared types
│   │   ├── dispatcher.ts        # Backend selector — picks GPU/rana/browser
│   │   ├── detector.ts          # Auto-detect available backends at runtime
│   │   ├── gpu-backend.ts       # GPU (CUDA) backend — subprocess wrapper
│   │   ├── rana-backend.ts      # Rana (Rust CLI) backend — subprocess wrapper
│   │   └── browser-backend.ts   # Client-side fallback — returns JS instructions
│   │
│   ├── grinding/
│   │   ├── offset.ts            # Offset math: P + d·G, bech32 encoding
│   │   ├── vanity-check.ts      # Pattern matching (prefix, suffix, contains)
│   │   ├── entropy-scanner.ts   # Multi-scale unique char count scan (ADR-009)
│   │   └── verify.ts            # Verify offset: check P + d·G → expected NPUB
│   │
│   ├── payment/
│   │   ├── pricing.ts           # Cost calculation per vanity difficulty
│   │   ├── cashu.ts             # Cashu token creation/verification
│   │   ├── lightning.ts         # LN invoice generation
│   │   └── atomic-swap.ts       # Hash-locked atomic swap (ADR-008 Layer 2)
│   │
│   └── utils/
│       ├── bech32.ts            # bech32 encode/decode (reuse from demo)
│       ├── crypto.ts            # secp256k1 point operations
│       └── logger.ts            # Structured logging
│
├── gpu/
│   ├── README.md                # GPU backend build instructions
│   ├── CMakeLists.txt            # CMake build for CUDA kernel
│   ├── src/
│   │   ├── main.cpp              # Host code — CLI interface
│   │   ├── cuda_vanity.cu         # CUDA kernel — offset grinding
│   │   ├── ec_point_add.cu        # EC point addition device functions
│   │   └── secp256k1.cu           # secp256k1 curve params, point ops
│   ├── include/
│   │   ├── secp256k1.cuh          # Curve constants, point struct
│   │   └── vanity.cuh             # Vanity checking on GPU
│   └── tests/
│       ├── test_offset.cu        # Verify P + d·G matches CPU reference
│       └── test_vanity.cu        # Verify pattern matching
│
├── rana-fork/                    # Git submodule → felixfelix-bot/rana fork
│   └── (offset grinding patches — see Rana Integration section)
│
├── scripts/
│   ├── build-gpu.sh              # Build CUDA backend
│   ├── build-rana.sh             # Build rana fork with offset mode
│   ├── detect-backends.sh        # Shell script for runtime detection
│   └── dev-start.sh              # Start dev server with hot reload
│
├── tests/
│   ├── offset-math.test.ts       # Verify offset grinding math
│   ├── backend-dispatch.test.ts # Test fallback chain
│   ├── entropy-scanner.test.ts  # Verify unique char count scanning
│   ├── payment.test.ts           # Cashu/LN integration tests
│   └── e2e-grind.test.ts         # End-to-end grind → verify
│
└── docker/
    ├── Dockerfile                # Server image (Node + rana)
    ├── Dockerfile.gpu            # Server + CUDA toolkit
    └── docker-compose.yml        # Full stack: server + relay (optional)
```

---

## Implementation Phases

### Phase 1: ContextVM Server Core (Days 1-3)

**Goal**: Stand up a ContextVM MCP server that responds to `grind_npub` calls
using the browser fallback path (returns "use_client_fallback" with JS
instructions). This proves the Nostr transport layer works end-to-end.

#### 1.1 Project Setup

```
server/package.json
```

Dependencies:
- `@contextvm/sdk` — MCP server over Nostr
- `nostr-tools` — NIP-19, NIP-04, event handling
- `@noble/secp256k1` — secp256k1 point operations
- `@noble/hashes` — SHA256, etc.
- `typescript`, `tsx` — dev tooling
- `vitest` — testing

Scripts:
- `dev`: `tsx watch src/index.ts`
- `build`: `tsc`
- `start`: `node dist/index.js`
- `test`: `vitest`

#### 1.2 Configuration (`src/config.ts`)

```typescript
interface ServerConfig {
  // Nostr identity (server's own key)
  serverPrivateKey: string;  // hex nsec — the server's identity
  serverNpub: string;        // derived npub — the server's address

  // Relays to listen on
  relays: string[];          // e.g., ["wss://relay.damus.io", "wss://nos.la"]

  // Backend paths
  ranaBinaryPath: string;    // path to rana binary (or "rana" if in PATH)
  gpuBinaryPath: string;     // path to cuda_vanity binary

  // Auto-detect settings
  enableGpu: boolean;        // try to use GPU
  enableRana: boolean;       // try to use rana
  enableBrowserFallback: boolean; // always true

  // Payment
  enablePayments: boolean;
  cashuMintUrl: string;      // e.g., "https://mint.minibits.cash"
  lnBackend: string;         // "lnd" | "lnurl" | "none"

  // Pricing (sats per difficulty tier)
  pricing: {
    freeThreshold: number;   // patterns < this difficulty are free
    satsPerBit: number;      // sats per bit of difficulty
  };
}
```

Load from environment variables (`.env`), with sensible defaults.

#### 1.3 ContextVM Server (`src/server/contextvm-server.ts`)

```typescript
// Pseudocode structure:
import { ContextVMServer } from '@contextvm/sdk';
import { grindNpubTool } from './tools.js';

const server = new ContextVMServer({
  name: 'vanaas-grinder',
  version: '0.1.0',
  privateKey: config.serverPrivateKey,
  relays: config.relays,
  tools: [grindNpubTool],
});

server.on('request', async (event, params) => {
  // NIP-04 encrypted request received from client
  // Dispatch to grinding tool handler
});

await server.start();
console.log(`VNAAS server listening as ${config.serverNpub}`);
```

**Key design decisions:**

1. **Transport**: ContextVM SDK handles MCP JSON-RPC over Nostr. Requests
   arrive as NIP-04 encrypted DMs (kind 4 events). Responses are sent back
   as NIP-04 encrypted DMs to the requester.

2. **Server identity**: The server has its own Nostr keypair. Clients
   address the server by its npub. The server subscribes to NIP-04 DMs
   addressed to it on configured relays.

3. **Stateless tools**: Each `grind_npub` call is independent. No session
   state needed (stateless = scalable, simple).

#### 1.4 MCP Tool Registration (`src/server/tools.ts`)

```typescript
export const grindNpubTool = {
  name: 'grind_npub',
  description: 'Grind a vanity NPUB offset for a public key using offset \
   grinding (P + d·G). The server never sees your secret key. Returns an \
   offset integer you add to your nsec. Dispatches to GPU, CPU (rana), or \
   instructs client to grind in-browser.',
  inputSchema: {
    type: 'object',
    properties: {
      npub: { type: 'string', description: 'Your public key (npub1...)' },
      vanity_pattern: { type: 'string', description: 'Desired vanity word' },
      options: {
        type: 'object',
        properties: {
          suffix: { type: 'string' },
          min_unique_chars: { type: 'number' },
          min_window_size: { type: 'number' },
          timeout_secs: { type: 'number' },
          max_cost_sats: { type: 'number' },
        },
      },
    },
    required: ['npub', 'vanity_pattern'],
  },
  handler: handleGrindNpub,
};
```

#### 1.5 Nostr Event Flow

```
Client                          Server                  Relay
  │                                │                      │
  │  1. Generate keypair locally   │                      │
  │     k (nsec), P (npub)        │                      │
  │                                │                      │
  │  2. Build MCP JSON-RPC request │                      │
  │     { method: "tools/call",   │                      │
  │       params: { name:          │                      │
  │         "grind_npub",          │                      │
  │         arguments: {           │                      │
  │           npub: "npub1...",    │                      │
  │           vanity_pattern:      │                      │
  │             "meshmate"         │                      │
  │         }                      │                      │
  │       }                        │                      │
  │     }                          │                      │
  │                                │                      │
  │  3. NIP-04 encrypt to server   │                      │
  │     create kind:4 event        │                      │
  │     p-tag: server_npub         │                      │
  │                                │                      │
  │  4. Publish to relays ────────────────────────────────▶
  │                                │                      │
  │                                │ ◀──────────────────  │
  │                                │  5. Relay delivers    │
  │                                │     kind:4 event to   │
  │                                │     server (matches  │
  │                                │     p-tag)            │
  │                                │                      │
  │                                │  6. NIP-04 decrypt    │
  │                                │     parse JSON-RPC    │
  │                                │                      │
  │                                │  7. Dispatch to       │
  │                                │     backend (GPU/rana)│
  │                                │     grind: P + d·G    │
  │                                │     for d=1,2,3,...   │
  │                                │                      │
  │                                │  8. Match found:     │
  │                                │     offset = d        │
  │                                │     vanity_npub =     │
  │                                │       bech32(P+d·G)   │
  │                                │                      │
  │                                │  9. Build response   │
  │                                │     { result: {       │
  │                                │       offset: "42",   │
  │                                │       vanity_npub:    │
  │                                │         "npub1mesh..."│
  │                                │     }                │
  │                                │                      │
  │                                │ 10. NIP-04 encrypt   │
  │                                │     to client npub   │
  │                                │     kind:4 event     │
  │                                │     p-tag: client    │
  │                                │                      │
  │                                │ 11. Publish response  │
  │                                │     to relays ───────▶
  │                                │                      │
  │ ◀──────────────────────────────│──────────────────── │
  │  12. Relay delivers response   │                      │
  │      (NIP-04 DM from server)   │                      │
  │                                │                      │
  │  13. NIP-04 decrypt             │                      │
  │      parse JSON-RPC response   │                      │
  │                                │                      │
  │  14. Verify:                    │                      │
  │      new_npub = bech32(        │                      │
  │        (k + d)·G)              │                      │
  │      == vanity_npub from       │                      │
  │      server response ✓         │                      │
  │                                │                      │
  │  15. Apply:                     │                      │
  │      new_nsec = (k + d) mod n  │                      │
  │      Done!                     │                      │
```

**Progress events** (optional, kind 4 DMs during long grinds):
```
During grinding, server can send periodic progress DMs:
  { method: "notifications/progress",
    params: { keys_tried: 50000000, rate_per_sec: 1200000, backend: "gpu" } }
```

---

### Phase 2: Backend Dispatcher & Auto-Detection (Days 3-5)

**Goal**: Implement the backend selection logic and auto-detection of
available compute backends.

#### 2.1 Backend Interface (`src/backends/types.ts`)

```typescript
interface GrindBackend {
  name: 'gpu' | 'rana' | 'browser';
  available: boolean;
  estimatedRate: number;  // keys/sec estimate

  grind(params: GrindParams): Promise<GrindResult>;
  healthCheck(): Promise<boolean>;
}

interface GrindParams {
  pubKeyBytes: Uint8Array;   // 32-byte x-only public key
  vanityPatterns: string[];  // patterns to match
  suffixPatterns?: string[];
  startOffset: bigint;      // usually 0n, for resume
  maxOffset: bigint;        // limit
  timeoutMs: number;
  scanEntropy: boolean;     // whether to run entropy scanner on matches
  minUniqueChars: number;
  minWindowSize: number;
}

interface GrindResult {
  found: boolean;
  offset?: bigint;
  vanityNpub?: string;
  uniqueChars?: number;       // Unique chars in best window
  rarity?: number;             // Rarity score (expectedUnique - uniqueChars)
  fingerprint?: FingerprintInfo;
  keysTried: number;
  durationMs: number;
  backend: string;
}
```

#### 2.2 Auto-Detection (`src/backends/detector.ts`)

```typescript
async function detectBackends(): Promise<BackendAvailability> {
  const availability: BackendAvailability = {
    gpu: false,
    rana: false,
    browser: true,  // always available as fallback
  };

  // 1. Detect GPU (CUDA)
  // Check for nvidia-smi or CUDA device
  // Try running gpu binary with --probe flag
  try {
    const result = await execFile(config.gpuBinaryPath, ['--probe']);
    availability.gpu = result.exitCode === 0;
    if (availability.gpu) {
      availability.gpuInfo = parseGpuInfo(result.stdout);
    }
  } catch { /* GPU not available */ }

  // 2. Detect Rana
  // Check if rana binary exists and is executable
  try {
    const result = await execFile(config.ranaBinaryPath, ['--version']);
    availability.rana = result.exitCode === 0;
    if (availability.rana) {
      availability.ranaVersion = result.stdout.trim();
    }
  } catch { /* rana not available */ }

  return availability;
}

// Re-detect every 60 seconds (backends may come/go)
setInterval(detectBackends, 60_000);
```

#### 2.3 Dispatcher (`src/backends/dispatcher.ts`)

```typescript
async function dispatchGrind(params: GrindParams): Promise<GrindResult> {
  const availability = await getLatestAvailability();

  // Priority chain: GPU → Rana → Browser
  if (availability.gpu) {
    try {
      const result = await gpuBackend.grind(params);
      if (result.found || result.backend === 'gpu') return result;
      // GPU available but failed → fall through to rana
    } catch (e) {
      logger.warn('GPU backend failed, falling back to rana', e);
    }
  }

  if (availability.rana) {
    try {
      const result = await ranaBackend.grind(params);
      if (result.found || result.backend === 'rana') return result;
      // Rana failed → fall through to browser
    } catch (e) {
      logger.warn('Rana backend failed, falling back to browser', e);
    }
  }

  // Browser fallback: return instructions for client-side grinding
  return {
    found: false,
    keysTried: 0,
    durationMs: 0,
    backend: 'browser',
    fallbackReason: 'No server-side compute available. Grind in browser.',
    clientCode: BROWSER_GRIND_SNIPPET, // JS code for @noble/secp256k1
  };
}
```

---

### Phase 3: Rana Integration — CPU Backend (Days 5-8)

**Goal**: Integrate the rana fork with offset grinding mode as the CPU
backend. Called as a subprocess from the server.

#### 3.1 Rana Fork Modifications (under `felixfelix-bot/rana`)

Based on ADR-007, the fork needs these changes:

**New CLI flag**: `--pubkey <npub>`

```
rana --pubkey npub1xyz... --vanity-n-prefix meshmate -c 16
```

When `--pubkey` is provided:
1. Parse the npub to get 32-byte public key P
2. Instead of `Keys::generate()`, use offset grinding:
   - Maintain `Arc<AtomicU64>` nonce counter starting at 0
   - Each thread loads nonce d, computes `P + d·G` via
     `secp256k1::PublicKey::add_exp(&P, &d_scalar)`
   - bech32-encode the result, check against vanity patterns
3. On match: output `{ "offset": d, "npub": "npub1...", "pattern": "meshmate" }`
   as JSON to stdout (machine-readable mode)
4. Add `--json` flag for JSON output (vs human-readable)

**Key code changes in `src/main.rs`:**

```rust
// New: offset grinding mode
if let Some(ref pubkey_npub) = parsed_args.pubkey {
    // Parse npub → 32 bytes
    let pub_key_bytes = bech32_decode(pubkey_npub)?;
    let base_point = PublicKey::from_slice(&pub_key_bytes)?;

    // Each thread gets a nonce range
    let nonce = Arc::new(AtomicU64::new(0));
    let chunk_size: u64 = 1_000_000; // 1M per thread per batch

    thread::spawn(move || {
        loop {
            let start = nonce.fetch_add(chunk_size, Ordering::Relaxed);
            let end = start + chunk_size;

            // Compute P + start*G once (using add_exp with scalar)
            let mut current = base_point.clone();
            current = current.add_exp(&Scalar::from(start));

            for d in start..end {
                // Check current against patterns
                let npub = current.to_bech32()?;
                if check_vanity(&npub, &patterns) {
                    // Found! Output offset = d
                    if json_mode {
                        println!("{}", json!({
                            "offset": d.to_string(),
                            "npub": npub,
                            "pattern": matched_pattern,
                        }));
                    }
                    std::process::exit(0);
                }
                // Increment: current += G
                current = current.add_exp(&Scalar::one());
            }
        }
    });
}
```

**New CLI args in `src/cli.rs`:**

```rust
#[arg(
    long = "pubkey",
    required = false,
    help = "Grind offsets for an existing public key (npub1...). \
            Offset grinding mode — never generates private keys."
)]
pub pubkey: Option<String>,

#[arg(
    long = "json",
    required = false,
    default_value_t = false,
    help = "Output results as JSON (for machine consumption by VNAAS server)."
)]
pub json: bool,

#[arg(
    long = "scan-entropy",
    required = false,
    default_value_t = false,
    help = "After finding vanity match, scan for entropy outlier (ADR-009). \
            Returns unique char count, rarity, and window size."
)]
pub scan_entropy: bool,

#[arg(
    long = "min-unique-chars",
    required = false,
    default_value_t = 0,
    help = "Minimum unique char count for entropy acceptance. Only with --scan-entropy."
)]
pub min_unique_chars: u32,

#[arg(
    long = "timeout",
    required = false,
    default_value_t = 0,
    help = "Timeout in seconds. 0 = no timeout."
)]
pub timeout_secs: u64,
```

**New dependency in `Cargo.toml`:**

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

#### 3.2 Server-Side Rana Wrapper (`src/backends/rana-backend.ts`)

```typescript
import { spawn, ChildProcess } from 'child_process';

class RanaBackend implements GrindBackend {
  name = 'rana' as const;
  available = false;
  estimatedRate = 500_000; // ~500K/sec on multi-core

  async healthCheck(): Promise<boolean> {
    try {
      const { stdout } = await exec(this.binaryPath, ['--version']);
      return stdout.includes('rana');
    } catch {
      return false;
    }
  }

  async grind(params: GrindParams): Promise<GrindResult> {
    const npub = bech32Encode('npub', params.pubKeyBytes);

    const args = [
      '--pubkey', npub,
      '--vanity-n-prefix', params.vanityPatterns.join(','),
      '--json',
      '--cores', String(numCpus),
      '--timeout', String(Math.floor(params.timeoutMs / 1000)),
    ];

    if (params.scanEntropy) {
      args.push('--scan-entropy', '--min-unique-chars',
                String(params.minUniqueChars));
    }

    if (params.suffixPatterns?.length) {
      args.push('--vanity-n-suffix', params.suffixPatterns.join(','));
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        // Check for JSON result line
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.startsWith('{')) {
            try {
              const result = JSON.parse(line);
              if (result.offset) {
                resolve({
                  found: true,
                  offset: BigInt(result.offset),
                  vanityNpub: result.npub,
                  uniqueChars: result.unique_chars,
                  rarity: result.rarity,
                  fingerprint: result.fingerprint,
                  keysTried: result.keys_tried || 0,
                  durationMs: result.duration_ms || 0,
                  backend: 'rana',
                });
                proc.kill();
                return;
              }
            } catch { /* partial JSON, wait for more */ }
          }
        }
      });

      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && !stdout.includes('"offset"')) {
          // Timeout without finding
          resolve({
            found: false,
            keysTried: 0,
            durationMs: params.timeoutMs,
            backend: 'rana',
          });
        }
      });

      proc.on('error', reject);
    });
  }
}
```

#### 3.3 Build & Deployment

```bash
# scripts/build-rana.sh
#!/bin/bash
set -euo pipefail

RANA_DIR="${1:-$(pwd)/rana-fork}"

# Clone fork if not present
if [ ! -d "$RANA_DIR/.git" ]; then
  git clone https://github.com/felixfelix-bot/rana.git "$RANA_DIR"
fi

# Build release binary
cd "$RANA_DIR"
cargo build --release

# Copy to server bin
cp target/release/rana ../server/bin/rana
echo "Rana built: $(./server/bin/rana --version)"
```

---

### Phase 4: GPU Backend Integration (Days 8-14)

**Goal**: Fork `v0l/cuda_vanity`, add EC point addition to the CUDA kernel
for offset grinding, and integrate as the highest-priority backend.

#### 4.1 GPU Fork: `v0l/cuda_vanity` + Offset Mode

The original `v0l/cuda_vanity` generates fresh keypairs on GPU (10-50M
keys/sec). We need to modify it for offset grinding:

**What changes:**

1. **Input**: Accept base public key P (32 bytes) as command-line arg
2. **Kernel**: Replace `d*G` (scalar multiplication) with `P + d*G`
   (one EC point addition per thread, incrementing d)
3. **Output**: Return offset d (not private key) as JSON

**CUDA kernel changes (`gpu/src/cuda_vanity.cu`):**

```cuda
// Original kernel: generate random d, compute d*G, check NPUB
// Modified kernel: incrementing d from thread offset, compute P + d*G

__global__ void vanity_offset_kernel(
    const Point* base_point_P,    // User's public key P (loaded once)
    const char* target_pattern,    // Vanity pattern to match
    int pattern_len,
    unsigned long long start_offset, // Starting offset for this batch
    unsigned long long* found_offset, // Output: offset d when found
    int* found_flag                // Atomic flag: 1 = found
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;

    // Each thread computes P + (start_offset + tid) * G
    // Optimization: precompute G, use incremental addition

    unsigned long long d = start_offset + tid;

    // Compute d * G (scalar mult — expensive, but done once per thread)
    // Then add to base point: result = P + d*G
    Point dg = scalar_mul_G(d);
    Point result = point_add(base_point_P[threadIdx.x / 32], dg);

    // Convert to bech32 and check vanity
    // ... (bech32 encoding on GPU or copy back to host)

    if (matches_pattern(result, target_pattern, pattern_len)) {
        atomicExch(found_flag, 1);
        *found_offset = d;
    }
}
```

**Optimization note**: The ideal approach is to have each thread compute
P + d*G where d increments by 1 per thread, and threads share the G
precomputation. The current `cuda_vanity` kernel uses batched scalar
multiplication; we'd restructure to:
1. Load P into shared memory per block
2. Each thread computes one d*G and adds to P
3. Or: threads cooperatively compute sequential P + d*G using the fact that
   P + (d+1)*G = (P + d*G) + G (one point addition, not full scalar mult)

**Host code (`gpu/src/main.cpp`):**

```cpp
// CLI:
// cuda_vanity_offset --pubkey npub1xyz... --pattern meshmate \
//   --timeout 300 --json

int main(int argc, char* argv[]) {
    // Parse args
    std::string npub = parse_arg(argc, argv, "--pubkey");
    std::string pattern = parse_arg(argc, argv, "--pattern");
    int timeout = parse_int_arg(argc, argv, "--timeout", 300);
    bool json = has_flag(argc, argv, "--json");

    // Decode npub → 32-byte public key
    auto pub_bytes = bech32_decode(npub);
    Point P = decode_point(pub_bytes);

    // Select GPU device
    cudaSetDevice(0);

    // Allocate device memory for base point
    Point* d_P;
    cudaMalloc(&d_P, sizeof(Point));
    cudaMemcpy(d_P, &P, sizeof(Point), cudaMemcpyHostToDevice);

    // Launch kernel in batches
    unsigned long long batch_size = 1ULL << 20; // 1M per batch
    unsigned long long offset = 0;
    unsigned long long* d_found_offset;
    int* d_found_flag;
    cudaMalloc(&d_found_offset, sizeof(unsigned long long));
    cudaMalloc(&d_found_flag, sizeof(int));
    cudaMemset(d_found_flag, 0, sizeof(int));

    auto start = std::chrono::steady_clock::now();
    while (true) {
        vanity_offset_kernel<<<blocks, threads>>>(
            d_P, pattern.c_str(), pattern.length(),
            offset, d_found_offset, d_found_flag);

        int found_flag;
        cudaMemcpy(&found_flag, d_found_flag, sizeof(int),
                   cudaMemcpyDeviceToHost);
        if (found_flag) {
            unsigned long long found_offset;
            cudaMemcpy(&found_offset, d_found_offset,
                       sizeof(unsigned long long),
                       cudaMemcpyDeviceToHost);
            // Compute resulting NPUB on host (verify)
            Point result = point_add(P, scalar_mul_G(found_offset));
            auto result_npub = bech32_encode("npub", result.x);

            if (json) {
                printf("{\"offset\": \"%llu\", \"npub\": \"%s\"}\n",
                       found_offset, result_npub.c_str());
            }
            return 0;
        }

        offset += batch_size;

        // Check timeout
        auto elapsed = std::chrono::steady_clock::now() - start;
        if (timeout > 0 &&
            std::chrono::duration_cast<std::chrono::seconds>(elapsed)
              .count() > timeout) {
            if (json) {
                printf("{\"found\": false, \"tried\": %llu}\n", offset);
            }
            return 1;
        }
    }
}
```

#### 4.2 Server-Side GPU Wrapper (`src/backends/gpu-backend.ts`)

Similar to rana backend — spawns the `cuda_vanity_offset` binary as a
subprocess, parses JSON output.

```typescript
class GpuBackend implements GrindBackend {
  name = 'gpu' as const;
  available = false;
  estimatedRate = 10_000_000; // 10M+ keys/sec

  async healthCheck(): Promise<boolean> {
    try {
      const { stdout } = await exec(this.binaryPath, ['--probe']);
      return stdout.includes('CUDA device');
    } catch {
      return false;
    }
  }

  async grind(params: GrindParams): Promise<GrindResult> {
    const npub = bech32Encode('npub', params.pubKeyBytes);

    const args = [
      '--pubkey', npub,
      '--pattern', params.vanityPatterns[0],
      '--timeout', String(Math.floor(params.timeoutMs / 1000)),
      '--json',
    ];

    // Same subprocess pattern as rana backend
    // Parse JSON stdout for offset result
    // ... (analogous to rana-backend.ts)
  }
}
```

#### 4.3 GPU Build

```bash
# scripts/build-gpu.sh
#!/bin/bash
set -euo pipefail

GPU_DIR="${1:-$(pwd)/gpu}"

if ! command -v nvcc &> /dev/null; then
  echo "CUDA toolkit not found. Install nvcc to build GPU backend."
  exit 1
fi

cd "$GPU_DIR"
mkdir -p build && cd build
cmake .. -DCMAKE_CUDA_ARCHITECTURES=80  # adjust for GPU arch
make -j$(nproc)

cp cuda_vanity_offset ../../server/bin/cuda_vanity_offset
echo "GPU backend built."
```

---

### Phase 5: Browser Client-Side Fallback (Days 3-4)

**Goal**: When no server-side compute is available, the server returns
instructions and code for the client to grind in-browser. The existing
`demo/index.html` already has working browser-based offset grinding.

#### 5.1 Browser Fallback Response

When the dispatcher falls through to browser, the server returns:

```typescript
const BROWSER_GRIND_INSTRUCTIONS = {
  status: "use_client_fallback",
  fallback_reason: "No server-side GPU or CPU grinding backend available.",
  client_code: `
    // Browser-side offset grinding using @noble/secp256k1
    // (extracted from demo/index.html, Section 6)
    import { ProjectivePoint, utils } from '@noble/secp256k1';

    const G = ProjectivePoint.fromPrivateKey(1n);
    const userPoint = ProjectivePoint.fromHex(/* user's compressed pubkey */);

    let d = 0n;
    let current = userPoint;
    while (true) {
      d++;
      current = current.add(G);
      const npub = bech32Encode('npub', bigIntTo32Bytes(current.x));
      if (npub.includes(vanityPattern)) {
        console.log('Found offset:', d.toString());
        console.log('Vanity NPUB:', npub);
        break;
      }
    }
  `,
  estimated_rate: "~200 keys/sec (browser)",
  recommendation: "For faster grinding, consider running rana locally or \
    using a server with GPU support.",
};
```

#### 5.2 Reusing Demo Code

The browser grinding code in `demo/index.html` (Section 6, lines 1620-1755)
already implements:
- Offset grinding via `ProjectivePoint.add(G)` incremental point addition
- NPUB bech32 encoding
- Vanity pattern checking
- Progress reporting (keys tried, rate)
- Result display with offset and instructions

This code should be extracted into a reusable module:

```
server/src/backends/browser-backend.ts  → returns instructions
demo/grind-worker.js                      → Web Worker for browser grinding
demo/grind-client.js                      → Client-side grind orchestrator
```

The Web Worker version would run in a background thread to avoid blocking
the UI, using the same `@noble/secp256k1` incremental point addition approach.

---

### Phase 6: Payment Integration (Days 10-14)

**Goal**: Implement paid grinding using Cashu (V1 simple, V2 NUT-11 HTLC)
and optionally Lightning, per ADR-008.

#### 6.1 Pricing (`src/payment/pricing.ts`)

```typescript
interface PricingConfig {
  // Patterns below this difficulty (bits) are free
  freeThresholdBits: number;  // default: 20 (~1M keys, trivial)

  // Sats per bit of difficulty above the free threshold
  satsPerBit: number;         // default: 1

  // Multiplier for entropy scanning (more work = higher price)
  entropyScanMultiplier: number; // default: 1.5

  // Minimum price (sats)
  minPriceSats: number;       // default: 21

  // Maximum price (sats) — cap for very long patterns
  maxPriceSats: number;       // default: 10000
}

function calculatePrice(pattern: string, scanEntropy: boolean): number {
  // Difficulty in bits: each bech32 char = 5 bits of search space
  // For "contains" matching: difficulty = len * log2(32) = len * 5
  const difficultyBits = pattern.length * 5;
  if (difficultyBits <= config.freeThresholdBits) return 0;

  let sats = (difficultyBits - config.freeThresholdBits) * config.satsPerBit;
  if (scanEntropy) sats *= config.entropyScanMultiplier;
  return Math.max(config.minPriceSats, Math.min(sats, config.maxPriceSats));
}
```

#### 6.2 Payment Flow

**V1 (Simple Cashu — reputation-based, ADR-008 Layer 1):**

```
1. Client requests grind → server calculates price
2. If price > 0: server returns { status: "payment_required",
     price_sats: 210, cashu_mint: "https://..." }
3. Client sends Cashu token to server (via NIP-04 DM)
4. Server verifies Cashu token, claims ecash
5. Server grinds, returns offset d
6. Client verifies offset → done
```

**V2 (Cashu NUT-11 HTLC — atomic, ADR-008 Layer 2):**

```
1. Client requests grind → server calculates price
2. Server grinds FIRST, finds offset d
3. Server computes h = SHA256(d)
4. Server returns { status: "payment_required",
     target_npub: "npub1meshmate...", // proof it exists
     hash_commitment: h,             // SHA256(d) — doesn't reveal d
     price_sats: 210,
     cashu_mint: "https://..." }
5. Client verifies target_npub independently (public key math)
6. Client creates Cashu token locked with NUT-11 HTLC: hashlock = h
7. Client sends locked token to server
8. Server claims ecash by providing preimage d → mint verifies H(d)=h
9. d is revealed in the claim → server sends d to client (or client reads
   it from mint's claim record)
10. Client computes new_nsec = (old_nsec + d) mod n, verifies match
```

#### 6.3 Cashu Integration (`src/payment/cashu.ts`)

```typescript
import { CashuMint, CashuWallet, getEncodedToken } from '@cashu/cashu-ts';

class CashuPayment {
  private wallet: CashuWallet;

  constructor(mintUrl: string) {
    const mint = new CashuMint(mintUrl);
    this.wallet = new CashuWallet(mint);
  }

  async receiveToken(token: string): Promise<boolean> {
    try {
      const proofs = await this.wallet.receiveToken(token);
      // Verify proofs are valid
      return true;
    } catch {
      return false;
    }
  }

  // For V2: create HTLC-locked token request
  async createHtlcRequest(
    hashLock: string,      // SHA256(d) as hex
    amount: number,        // sats
  ): Promise<string> {
    // Returns instructions for client to create NUT-11 locked token
    return JSON.stringify({
      type: 'htlc',
      mint: this.wallet.mintUrl,
      amount,
      hashLock,
      description: 'Vanity NPUB grinding — reveal preimage to claim',
    });
  }

  async claimHtlcToken(
    token: string,
    preimage: string,      // the offset d as hex/decimal string
  ): Promise<boolean> {
    // Claim the HTLC-locked ecash by providing preimage
    try {
      await this.wallet.receiveToken(token, { preimage });
      return true;
    } catch {
      return false;
    }
  }
}
```

#### 6.4 Lightning Integration (`src/payment/lightning.ts`)

```typescript
import { LightningBackend } from './types.js';

class LightningPayment implements LightningBackend {
  // For LN: generate invoice, wait for payment, then grind
  async createInvoice(amountSats: number, description: string): Promise<string> {
    // Call LN backend (LND, LNURL, or hosted service)
    // Return bolt11 invoice string
  }

  async waitForPayment(invoice: string, timeoutMs: number): Promise<boolean> {
    // Poll or subscribe to invoice status
  }
}
```

---

### Phase 7: Entropy Scanner Integration (Days 6-9)

**Goal**: After finding a vanity match, scan the NPUB for entropy outliers
(ADR-003/004) to discover anti-phish fingerprints.

#### 7.1 Server-Side Scanner (`src/grinding/entropy-scanner.ts`)

Port the JavaScript entropy scanner from `demo/index.html` (lines
1012-1078) to TypeScript:

```typescript
const BASELINE = {
  16: { mean: 3.571, std: 0.187 },
  25: { mean: 3.993, std: 0.163 },
  36: { mean: 4.277, std: 0.138 },
  49: { mean: 4.468, std: 0.115 },
};
const WINDOW_SIZES = [16, 25, 36, 49];

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const c of str) freq[c] = (freq[c] || 0) + 1;
  let h = 0;
  const n = str.length;
  for (const c in freq) {
    const p = freq[c] / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function uniqueCharCount(str: string): number {
  const seen: Record<string, boolean> = {};
  for (const c of str) seen[c] = true;
  return Object.keys(seen).length;
}

interface ScanResult {
  bestZ: number;
  bestW: number;
  bestPos: number;
  bestEntropy: number;
  bestUnique: number;
  bestQuality: number;
}

function runEntropyScanner(dataStr: string, minW: number): ScanResult {
  let bestQuality = -1;
  let best: ScanResult = { bestZ: -1, bestW: 0, bestPos: 0,
    bestEntropy: 0, bestUnique: 0, bestQuality: -1 };

  for (const W of WINDOW_SIZES) {
    if (W < minW) continue;
    const base = BASELINE[W];
    for (let pos = 0; pos <= dataStr.length - W; pos++) {
      const window = dataStr.substring(pos, pos + W);
      const ent = shannonEntropy(window);
      const z = Math.max(0, (base.mean - ent) / base.std);
      const uniq = uniqueCharCount(window);
      const quality = z / (uniq * uniq * uniq);
      if (quality > bestQuality) {
        bestQuality = quality;
        best = { bestZ: z, bestW: W, bestPos: pos,
          bestEntropy: ent, bestUnique: uniq, bestQuality: quality };
      }
    }
  }
  return best;
}
```

#### 7.2 Rana-Side Scanner

Add entropy scanning to rana's offset grinding mode (Rust):

```rust
// In rana fork: after finding vanity match
if parsed_args.scan_entropy {
    let data = npub.strip_prefix("npub1").unwrap_or(&npub);
    let scan_result = entropy::multi_scale_scan(data, parsed_args.min_unique_chars);
    if let Some(scan) = scan_result {
        // Output with entropy info
        println!("{}", json!({
            "offset": d.to_string(),
            "npub": npub,
            "pattern": matched_pattern,
            "unique_chars": scan.unique_chars,
            "rarity": scan.rarity,
            "fingerprint": {
                "window_size": scan.window_size,
                "position": scan.position,
                "unique_chars": scan.unique_chars,
                "quality_db": scan.quality_db,
            }
        }));
    }
}
```

---

### Phase 8: Testing & Verification (Days 12-15)

#### 8.1 Unit Tests

```
tests/
├── offset-math.test.ts
│   - Verify P + d·G produces correct NPUB for known d values
│   - Test wrap-around: (k + d) mod n still produces P + d·G
│   - Cross-reference with @noble/secp256k1 scalar multiplication
│
├── backend-dispatch.test.ts
│   - GPU available → uses GPU
│   - GPU fails → falls back to rana
│   - Rana fails → falls back to browser
│   - No backends → returns browser instructions
│
├── entropy-scanner.test.ts
│   - Known NPUBs produce expected unique char counts
│   - Window sizes 16, 25, 36, 49 all scanned
│   - Quality metric matches demo/index.html output
│
├── payment.test.ts
│   - Free threshold patterns return price 0
│   - Long patterns calculate correct price
│   - Cashu token verification works
│   - HTLC preimage matching works
│
├── nostr-handler.test.ts
│   - NIP-04 encryption/decryption roundtrip
│   - MCP JSON-RPC parsing
│   - Response routing to correct client
│
└── e2e-grind.test.ts
│   - Full flow: generate keypair → call grind_npub → verify offset
│   - Test with rana backend (if available)
│   - Test with browser fallback
│   - Test with payment flow (mock Cashu)
```

#### 8.2 Integration Test: Cross-Verification

```typescript
// tests/e2e-grind.test.ts
test('offset grinding produces verifiable result', async () => {
  // 1. Generate keypair
  const privKey = utils.randomPrivateKey();
  const pubPoint = ProjectivePoint.fromPrivateKey(privKey);
  const pubBytes = pubPoint.toRawBytes(true).slice(1);
  const npub = bech32Encode('npub', pubBytes);

  // 2. Call server
  const result = await callGrindNpub({
    npub,
    vanity_pattern: 'mesh',
    options: { timeout_secs: 30 }
  });

  expect(result.status).toBe('found');
  expect(result.offset).toBeDefined();

  // 3. Verify: (k + d) * G == P + d*G
  const d = BigInt(result.offset);
  const newPrivKey = (bytesToBigInt(privKey) + d) % CURVE.n;
  const newPubPoint = ProjectivePoint.fromPrivateKey(newPrivKey);
  const newNpub = bech32Encode('npub',
    newPubPoint.toRawBytes(true).slice(1));

  expect(newNpub).toBe(result.vanity_npub);
  expect(newNpub.includes('mesh')).toBe(true);
});
```

---

### Phase 9: Deployment & Operations (Days 14-16)

#### 9.1 Docker

```dockerfile
# docker/Dockerfile
FROM node:20-slim AS base

WORKDIR /app

# Install rana (CPU backend)
RUN apt-get update && apt-get install -y \
    build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy server code
COPY server/ ./server/
WORKDIR /app/server
RUN npm ci --production
RUN npm run build

# Copy rana binary (pre-built)
COPY server/bin/rana ./bin/rana
RUN chmod +x ./bin/rana

# Environment
ENV RANA_BINARY_PATH=/app/server/bin/rana
ENV RELAYS=wss://relay.damus.io,wss://nos.la

CMD ["node", "dist/index.js"]
```

```dockerfile
# docker/Dockerfile.gpu
FROM nvidia/cuda:12.2.0-devel-ubuntu22.04 AS gpu-base

# Install Node.js
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs build-essential pkg-config libssl-dev

# Build GPU backend
COPY gpu/ ./gpu/
WORKDIR /app/gpu
RUN mkdir build && cd build && cmake .. && make -j$(nproc)

# Copy server
COPY server/ ./server/
WORKDIR /app/server
RUN npm ci --production && npm run build

# Copy binaries
COPY gpu/build/cuda_vanity_offset ./bin/cuda_vanity_offset
COPY server/bin/rana ./bin/rana
RUN chmod +x ./bin/*

ENV GPU_BINARY_PATH=/app/server/bin/cuda_vanity_offset
ENV RANA_BINARY_PATH=/app/server/bin/rana

CMD ["node", "dist/index.js"]
```

#### 9.2 Environment Configuration

```bash
# server/.env.example

# Nostr server identity (generate a new key for the server)
SERVER_NSEC=nsec1...                    # Server's secret key
SERVER_NPUB=npub1...                    # Derived (don't set manually)

# Relays to listen on (comma-separated)
RELAYS=wss://relay.damus.io,wss://nos.la,wss://relay.primal.net

# Backend configuration
RANA_BINARY_PATH=./bin/rana
GPU_BINARY_PATH=./bin/cuda_vanity_offset
ENABLE_GPU=true
ENABLE_RANA=true
ENABLE_BROWSER_FALLBACK=true

# Payment
ENABLE_PAYMENTS=false
CASHU_MINT_URL=https://mint.minibits.cash
LN_BACKEND=none

# Pricing
FREE_THRESHOLD_BITS=20
SATS_PER_BIT=1
MIN_PRICE_SATS=21
MAX_PRICE_SATS=10000

# Server
LOG_LEVEL=info
PORT=3000  # Optional HTTP health endpoint (Nostr is primary)
```

#### 9.3 Health Check

The server optionally runs a simple HTTP health endpoint alongside the
Nostr listener:

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

---

## Implementation Order Summary

| Phase | Days | Deliverable | Dependencies |
|-------|------|-------------|--------------|
| 1 | 1-3 | ContextVM server skeleton, MCP tool def, Nostr transport | @contextvm/sdk |
| 2 | 3-5 | Backend dispatcher + auto-detection | Phase 1 |
| 3 | 5-8 | Rana fork (offset mode) + subprocess integration | Rana repo |
| 4 | 8-14 | GPU fork (CUDA offset kernel) + subprocess integration | CUDA toolkit |
| 5 | 3-4 | Browser fallback (reuse demo code) | Phase 1 |
| 6 | 10-14 | Cashu/LN payment integration | @cashu/cashu-ts |
| 7 | 6-9 | Entropy scanner (TS port + rana Rust) | Phase 3 |
| 8 | 12-15 | Tests (unit, integration, e2e) | Phases 1-7 |
| 9 | 14-16 | Docker, deployment, ops | All phases |

**Critical path**: Phase 1 → Phase 2 → Phase 3 (rana) → Phase 5 (browser
fallback works immediately). GPU (Phase 4) and payments (Phase 6) can proceed
in parallel.

---

## Key Design Decisions

### Why subprocess over FFI for backends?

Both rana (Rust) and cuda_vanity (C++) are called as **subprocesses** rather
than FFI. Reasons:

1. **Isolation**: A crashing GPU kernel or panicking Rust thread doesn't
   take down the Node.js server
2. **Simplicity**: No FFI bindings to maintain. The subprocess interface is
   just JSON over stdout.
3. **Portability**: Same server code works whether backends are installed or
   not. FFI would require conditional compilation.
4. **Security**: Subprocess runs in its own address space. No shared memory
   with the server process.

Tradeoff: slightly higher latency (~10ms process spawn). Acceptable for
grinding jobs that take seconds to minutes.

### Why ContextVM over raw Nostr?

ContextVM provides:
- Standardized MCP JSON-RPC protocol (familiar to AI agents and tooling)
- Built-in NIP-04 encryption for request/response
- Service discovery via npub addressing
- Tool schema validation

Raw Nostr would require custom protocol design. ContextVM gives us
interoperability with the growing MCP ecosystem.

### Why not WebSocket instead of Nostr?

Nostr transport provides:
- **Censorship resistance**: Multiple relays, no single point of failure
- **Identity**: Server is addressable by npub, clients by their npubs
- **Encryption**: NIP-04 built-in
- **Offline delivery**: Relays store events, server can be offline briefly
- **Nostr-native**: Target users are Nostr users with npubs

### Offset grinding math verification

All implementations (GPU, rana, browser) must produce identical results for
the same (P, d) pair. Cross-verification test:

```
Given P (pubkey bytes) and d (offset):
  GPU result:        bech32(P + d·G) using CUDA EC point addition
  Rana result:       bech32(P + d·G) using libsecp256k1
  Browser result:    bech32(P + d·G) using @noble/secp256k1
  Server reference:  bech32(P + d·G) using @noble/secp256k1 (TS)

All four must produce the same npub string.
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| GPU kernel EC point addition bugs | Cross-verify against CPU reference for all offsets |
| Rana fork diverges from upstream | Keep changes modular, contribute upstream when stable |
| Cashu NUT-11 not widely supported | Start with V1 (simple), upgrade to V2 when mints support it |
| Nostr relay downtime | Multi-relay subscription, relay rotation |
| Server key compromise | Server key is only for service identity, not user funds. Rotate if needed. |
| Client doesn't verify offset | Always include verification instructions in response |

---

## Future Considerations

1. **Multi-server federation**: Multiple grinding servers advertising on
   Nostr, clients pick fastest/best-priced
2. **Job queue**: For high demand, queue grind requests with priority based
   on payment
3. **GPU marketplace**: Community GPU owners can register as backends,
   earning sats for grinding
4. **Precomputed offset table**: Server precomputes common vanity patterns
   for instant response
5. **WASM rana**: Compile rana to WASM for in-browser CPU grinding (faster
   than JS @noble, no server needed)
6. **NIP-90 (Data Vending Machine)**: Align with NIP-90 standard for
   Nostr-based job dispatch if it matures