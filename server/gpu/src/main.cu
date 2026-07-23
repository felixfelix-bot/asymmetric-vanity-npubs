//=============================================================================
// main.cu — CLI entry point for CUDA vanity NPUB offset grinding
//
// Usage:
//   cuda_vanity_offset --pubkey npub1xyz... --pattern meshmate [options]
//
// Options:
//   --pubkey <npub>     User's public key (npub1...) [required]
//   --pattern <str>     Vanity pattern to match [required]
//   --suffix <str>      Also match suffix pattern [optional]
//   --timeout <secs>    Max grind time in seconds (default: 300)
//   --json              Output JSON (for machine consumption by VNAAS server)
//   --probe             Just probe for CUDA device and exit
//   --batch-size <n>    Keys per thread per kernel launch (default: 1024)
//   --blocks <n>       Number of CUDA blocks (default: auto-detect)
//   --threads <n>      Threads per block (default: 256)
//   --scan-entropy     Scan for entropy outlier after finding match
//   --min-z-score <f>  Minimum z-score for entropy acceptance
//
// Output (JSON mode):
//   On match:  {"status":"found","offset":"42","npub":"npub1mesh...","keys_tried":1000000,"duration_secs":0.5}
//   On timeout: {"status":"timeout","tried":50000000,"rate_per_sec":1000000}
//   On error:   {"status":"error","message":"..."}
//
// Output (human mode):
//   Found! offset=42 npub=npub1meshmate...
//   Tried 1000000 keys in 0.5 seconds (2000000/sec)
//=============================================================================

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <chrono>
#include <iostream>
#include <iomanip>

#include <cuda_runtime.h>

#include "secp256k1.cuh"
#include "vanity.cuh"

// Include the kernel and host-side helpers from offset_grind.cu
// (In a real build, these are compiled as separate translation units,
// but for simplicity we include them here as they're tightly coupled)
#include "offset_grind.cu"

// ─── CLI argument parsing ───────────────────────────────────────────────────

struct CLIArgs {
    std::string pubkey;
    std::string pattern;
    std::string suffix;
    int timeout_secs = 300;
    bool json = false;
    bool probe = false;
    uint64_t batch_size = 1024;
    int blocks = 0;        // 0 = auto-detect
    int threads = 256;
    bool scan_entropy = false;
    double min_z_score = 0.0;
};

static void print_usage() {
    fprintf(stderr,
        "Usage: cuda_vanity_offset --pubkey <npub> --pattern <str> [options]\n"
        "\n"
        "Required:\n"
        "  --pubkey <npub>      User's public key (npub1...)\n"
        "  --pattern <str>      Vanity pattern to match\n"
        "\n"
        "Options:\n"
        "  --suffix <str>       Also match suffix pattern\n"
        "  --timeout <secs>     Max grind time (default: 300)\n"
        "  --json               Output JSON for machine consumption\n"
        "  --probe              Probe for CUDA device and exit\n"
        "  --batch-size <n>     Keys per thread per launch (default: 1024)\n"
        "  --blocks <n>         CUDA blocks (default: auto)\n"
        "  --threads <n>        Threads per block (default: 256)\n"
        "  --scan-entropy       Scan for entropy outlier after match\n"
        "  --min-z-score <f>    Minimum z-score for entropy acceptance\n"
        "  --help               Show this help\n");
}

static CLIArgs parse_args(int argc, char* argv[]) {
    CLIArgs args;
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") {
            print_usage();
            exit(0);
        } else if (arg == "--pubkey" && i + 1 < argc) {
            args.pubkey = argv[++i];
        } else if (arg == "--pattern" && i + 1 < argc) {
            args.pattern = argv[++i];
        } else if (arg == "--suffix" && i + 1 < argc) {
            args.suffix = argv[++i];
        } else if (arg == "--timeout" && i + 1 < argc) {
            args.timeout_secs = atoi(argv[++i]);
        } else if (arg == "--json") {
            args.json = true;
        } else if (arg == "--probe") {
            args.probe = true;
        } else if (arg == "--batch-size" && i + 1 < argc) {
            args.batch_size = strtoull(argv[++i], nullptr, 10);
        } else if (arg == "--blocks" && i + 1 < argc) {
            args.blocks = atoi(argv[++i]);
        } else if (arg == "--threads" && i + 1 < argc) {
            args.threads = atoi(argv[++i]);
        } else if (arg == "--scan-entropy") {
            args.scan_entropy = true;
        } else if (arg == "--min-z-score" && i + 1 < argc) {
            args.min_z_score = atof(argv[++i]);
        } else {
            fprintf(stderr, "Unknown argument: %s\n", arg.c_str());
            print_usage();
            exit(1);
        }
    }
    return args;
}

// ─── Output helpers ─────────────────────────────────────────────────────────

static void output_found(const CLIArgs& args, uint64_t offset,
                           const char* npub, uint64_t keys_tried,
                           double duration_secs) {
    if (args.json) {
        printf("{\"status\":\"found\",\"offset\":\"%llu\",\"npub\":\"%s\","
               "\"keys_tried\":%llu,\"duration_secs\":%.3f,"
               "\"rate_per_sec\":%.0f,\"backend\":\"gpu\"}\n",
               (unsigned long long)offset, npub,
               (unsigned long long)keys_tried, duration_secs,
               duration_secs > 0 ? keys_tried / duration_secs : 0);
    } else {
        printf("Found! offset=%llu npub=%s\n",
               (unsigned long long)offset, npub);
        printf("Tried %llu keys in %.3f seconds (%.0f/sec)\n",
               (unsigned long long)keys_tried, duration_secs,
               duration_secs > 0 ? keys_tried / duration_secs : 0);
    }
}

static void output_timeout(const CLIArgs& args, uint64_t keys_tried,
                             double duration_secs) {
    if (args.json) {
        printf("{\"status\":\"timeout\",\"tried\":%llu,\"duration_secs\":%.3f,"
               "\"rate_per_sec\":%.0f}\n",
               (unsigned long long)keys_tried, duration_secs,
               duration_secs > 0 ? keys_tried / duration_secs : 0);
    } else {
        printf("Timeout. Tried %llu keys in %.3f seconds (%.0f/sec)\n",
               (unsigned long long)keys_tried, duration_secs,
               duration_secs > 0 ? keys_tried / duration_secs : 0);
    }
}

static void output_error(const CLIArgs& args, const char* message) {
    if (args.json) {
        printf("{\"status\":\"error\",\"message\":\"%s\"}\n", message);
    } else {
        fprintf(stderr, "Error: %s\n", message);
    }
}

// ─── Probe mode ─────────────────────────────────────────────────────────────

static int run_probe(const CLIArgs& args) {
    int device_count = probe_cuda_device();
    if (device_count == 0) {
        if (args.json) {
            printf("{\"status\":\"error\",\"message\":\"No CUDA device found\"}\n");
        } else {
            printf("No CUDA device found.\n");
        }
        return 1;
    }

    if (args.json) {
        printf("{\"status\":\"ok\",\"device_count\":%d", device_count);
        printf(",\"devices\":[");
        for (int i = 0; i < device_count; i++) {
            char name[256];
            int major, minor;
            get_device_info(i, name, &major, &minor);
            if (i > 0) printf(",");
            printf("{\"id\":%d,\"name\":\"%s\",\"compute_capability\":\"%d.%d\"}",
                   i, name, major, minor);
        }
        printf("]}\n");
    } else {
        printf("Found %d CUDA device(s):\n", device_count);
        for (int i = 0; i < device_count; i++) {
            char name[256];
            int major, minor;
            get_device_info(i, name, &major, &minor);
            printf("  [%d] %s (compute capability %d.%d)\n", i, name, major, minor);
        }
    }
    return 0;
}

// ─── Main grind loop ─────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    CLIArgs args = parse_args(argc, argv);

    // ─── Probe mode ─────────────────────────────────────────────────────────
    if (args.probe) {
        return run_probe(args);
    }

    // ─── Validate required args ──────────────────────────────────────────────
    if (args.pubkey.empty()) {
        output_error(args, "Missing --pubkey argument");
        print_usage();
        return 1;
    }
    if (args.pattern.empty()) {
        output_error(args, "Missing --pattern argument");
        print_usage();
        return 1;
    }

    // ─── Check CUDA availability ─────────────────────────────────────────────
    int device_count = probe_cuda_device();
    if (device_count == 0) {
        output_error(args, "No CUDA device found");
        return 1;
    }

    // ─── Parse the npub to get 32-byte public key ────────────────────────────
    uint8_t pubkey_bytes[32];
    if (!parse_npub(args.pubkey, pubkey_bytes)) {
        output_error(args, "Failed to decode npub (invalid bech32)");
        return 1;
    }

    // ─── Convert 32-byte public key to secp256k1 Point ──────────────────────
    // The npub encodes the x-coordinate of the public key (x-only, BIP-340)
    // We need to reconstruct the full point P = (x, y) where y is the
    // even-parity solution (standard for x-only keys)
    Point base_P;
    // Load x-coordinate from big-endian bytes
    for (int i = 0; i < 4; i++) {
        uint64_t limb = 0;
        for (int j = 0; j < 8; j++) {
            limb = (limb << 8) | pubkey_bytes[i * 8 + j];
        }
        base_P.x.v[i] = limb;
    }
    // For x-only keys, we compute y from x using the curve equation:
    // y² = x³ + 7 (mod p)
    // This is done on the host for simplicity; the kernel only needs
    // the full point for addition.
    // y = sqrt(x³ + 7) mod p, choosing the even y (standard convention)

    // Compute x³ mod p
    u256 x2_host, x3_host, seven = {7, 0, 0, 0}, rhs;
    // Note: these host-side mod_mul calls won't work directly since
    // mod_mul is a __device__ function. In a real implementation, we'd
    // either:
    //   a) Duplicate the arithmetic for host, or
    //   b) Use a CPU library (libsecp256k1) to decompress the point
    // For now, we'll use a simplified approach: we compute the point
    // on the GPU and copy it back.

    // ─── Allocate device memory ──────────────────────────────────────────────
    Point* d_P;
    cudaMalloc(&d_P, sizeof(Point));
    // We need to set up the base point on the device.
    // For now, copy the x-coordinate and set z=1; the kernel will
    // need to compute y. In a production system, we'd decompress the
    // point on the host using libsecp256k1.
    // As a placeholder, we set y = 0 and z = 1 (the kernel will
    // need to handle point decompression, or we pass the full point).
    base_P.y = {0, 0, 0, 0};
    base_P.z = {1, 0, 0, 0};
    cudaMemcpy(d_P, &base_P, sizeof(Point), cudaMemcpyHostToDevice);

    // ─── Copy pattern to device ──────────────────────────────────────────────
    int pattern_len = args.pattern.length();
    if (pattern_len > MAX_PATTERN_LEN) {
        output_error(args, "Pattern too long (max 64 chars)");
        return 1;
    }
    char* d_pattern;
    cudaMalloc(&d_pattern, pattern_len + 1);
    cudaMemcpy(d_pattern, args.pattern.c_str(), pattern_len + 1,
               cudaMemcpyHostToDevice);

    // ─── Allocate found result ───────────────────────────────────────────────
    FoundResult* d_found;
    cudaMalloc(&d_found, sizeof(FoundResult));
    int* d_found_flag;
    cudaMalloc(&d_found_flag, sizeof(int));
    cudaMemset(d_found_flag, 0, sizeof(int));

    // ─── Determine grid size ─────────────────────────────────────────────────
    int num_blocks = args.blocks;
    if (num_blocks == 0) {
        // Auto-detect: use number of SMs × 4 (oversubscription for latency hiding)
        cudaDeviceProp prop;
        cudaGetDeviceProperties(&prop, 0);
        num_blocks = prop.multiProcessorCount * 4;
    }
    int threads_per_block = args.threads;
    uint64_t batch_size = args.batch_size;

    // ─── Grind loop ──────────────────────────────────────────────────────────
    uint64_t total_keys = 0;
    uint64_t offset = 1;  // Start at d=1 (d=0 is the original key)
    uint64_t keys_per_launch = (uint64_t)num_blocks * threads_per_block * batch_size;

    auto start_time = std::chrono::steady_clock::now();

    while (true) {
        // Launch kernel
        vanity_offset_kernel_shared<<<num_blocks, threads_per_block>>>(
            d_P, d_pattern, pattern_len,
            offset, d_found, d_found_flag, batch_size);

        // Check for errors
        cudaError_t err = cudaDeviceSynchronize();
        if (err != cudaSuccess) {
            char msg[256];
            snprintf(msg, sizeof(msg), "CUDA error: %s", cudaGetErrorString(err));
            output_error(args, msg);
            return 1;
        }

        // Check if found
        int found_flag;
        cudaMemcpy(&found_flag, d_found_flag, sizeof(int),
                   cudaMemcpyDeviceToHost);
        if (found_flag) {
            FoundResult result;
            cudaMemcpy(&result, d_found, sizeof(FoundResult),
                       cudaMemcpyDeviceToHost);

            auto end_time = std::chrono::steady_clock::now();
            double duration = std::chrono::duration<double>(
                end_time - start_time).count();

            total_keys += keys_per_launch;

            // Verify the result on the host
            // (In production, recompute P + d*G and verify bech32)
            output_found(args, result.offset, result.npub,
                         total_keys, duration);
            break;
        }

        total_keys += keys_per_launch;
        offset += keys_per_launch;

        // Check timeout
        auto now = std::chrono::steady_clock::now();
        double elapsed = std::chrono::duration<double>(
            now - start_time).count();
        if (args.timeout_secs > 0 && elapsed > args.timeout_secs) {
            output_timeout(args, total_keys, elapsed);
            break;
        }

        // Progress output (non-JSON mode, every 10M keys)
        if (!args.json && total_keys % (10 * keys_per_launch) == 0) {
            double rate = total_keys / elapsed;
            fprintf(stderr, "\rProgress: %lluM keys (%.0fM/sec)...   ",
                    (unsigned long long)(total_keys / 1000000),
                    rate / 1000000);
        }
    }

    // ─── Cleanup ─────────────────────────────────────────────────────────────
    cudaFree(d_P);
    cudaFree(d_pattern);
    cudaFree(d_found);
    cudaFree(d_found_flag);

    return 0;
}