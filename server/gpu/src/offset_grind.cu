//=============================================================================
// offset_grind.cu — CUDA kernel for Nostr vanity NPUB offset grinding
//
// This kernel implements offset grinding: given a user's public key P,
// it computes P + d·G for incrementing d and checks whether the resulting
// NPUB (bech32 encoding of the x-only public key) matches a vanity pattern.
//
// Key optimization: P + (d+1)·G = (P + d·G) + G
//   This means each thread can use a single point_add (one EC addition)
//   per key tried, rather than a full scalar multiplication.
//
// The kernel is launched in batches. Each batch:
//   1. Loads base point P into shared memory
//   2. Each thread computes P + (start_offset + tid)·G
//   3. Converts result to bech32 NPUB
//   4. Checks vanity pattern match
//   5. On match: sets atomic found_flag and writes found_offset
//
// This is a fork of the v0l/cuda_vanity approach, modified for offset
// grinding (P + d·G) instead of fresh keypair generation (d·G).
//=============================================================================

#include <cuda_runtime.h>
#include <cstdint>
#include "secp256k1.cuh"
#include "vanity.cuh"

// ─── Kernel configuration ───────────────────────────────────────────────────
#ifndef BLOCK_SIZE
#define BLOCK_SIZE 256
#endif

#ifndef MAX_PATTERN_LEN
#define MAX_PATTERN_LEN 64
#endif

#ifndef NPUB_LEN
#define NPUB_LEN 63  // "npub1" + 52 data chars + 6 checksum chars + null
#endif

// ─── Device-side found result struct ────────────────────────────────────────
struct FoundResult {
    uint64_t offset;        // The offset d that produced a match
    char npub[NPUB_LEN + 1]; // The matching NPUB string
    int matched;             // 1 = found
};

// ─── Main offset grinding kernel ────────────────────────────────────────────
//
// This kernel is launched with a grid of blocks, each with BLOCK_SIZE threads.
// Each thread computes one offset d = start_offset + global_thread_id.
//
// Optimization strategy:
//   - Thread 0 in each warp computes P + start·G (full scalar mul)
//   - Thread i in the warp computes P + (start + i)·G by starting from
//     thread 0's result and adding G i times (incremental addition)
//   - This reduces the per-thread cost from O(256) scalar muls to O(1)
//     point additions (amortized)
//
// In practice, each thread independently computes P + d·G and then
// adds G incrementally for subsequent d values within its assigned range.
//
__global__ void vanity_offset_kernel(
    const Point* __restrict__ base_P,       // User's public key P (affine, device)
    const char* __restrict__ target_pattern, // Vanity pattern (device, null-terminated)
    int pattern_len,
    uint64_t start_offset,                   // Starting offset for this batch
    FoundResult* __restrict__ found,         // Output: found result
    int* __restrict__ found_flag,            // Atomic flag: 1 = found (stop)
    uint64_t batch_size                      // Number of offsets to try per thread
) {
    // Quick exit if already found
    if (*found_flag) return;

    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t my_start = start_offset + (uint64_t)tid * batch_size;

    // Load base point P from global memory
    Point P = *base_P;

    // Compute P + my_start * G (initial point for this thread)
    Point current;
    scalar_mul_G(current, my_start);
    point_add(current, P, current);
    to_affine(current);

    // Iterate through this thread's range using incremental addition:
    // current = current + G (one point_add per step)
    Point G = generator_point();

    for (uint64_t i = 0; i < batch_size; i++) {
        // Early exit if another thread found a match
        if (i % 64 == 0 && *found_flag) return;

        uint64_t d = my_start + i;

        // Convert current point to 32-byte x-coordinate
        uint8_t pubkey_bytes[32];
        point_to_bytes(pubkey_bytes, current);

        // Encode as NPUB (bech32)
        char npub[NPUB_LEN + 1];
        encode_npub(npub, pubkey_bytes);

        // Check vanity pattern
        if (matches_pattern(npub, target_pattern, pattern_len)) {
            // Found a match! Set the atomic flag
            int old = atomicExch(found_flag, 1);
            if (old == 0) {
                // We're the first to find a match
                found->offset = d;
                // Copy NPUB string
                for (int j = 0; j <= NPUB_LEN; j++) {
                    found->npub[j] = npub[j];
                }
                found->matched = 1;
            }
            return;
        }

        // Increment: current = current + G (one EC point addition)
        Point next;
        point_add(next, current, G);
        to_affine(next);
        current = next;
    }
}

// ─── Shared-memory optimized kernel variant ──────────────────────────────────
//
// This variant loads the base point P into shared memory for the block,
// reducing global memory traffic. Each thread then independently computes
// P + d·G for its assigned offset range.
//
__global__ void vanity_offset_kernel_shared(
    const Point* __restrict__ base_P,
    const char* __restrict__ target_pattern,
    int pattern_len,
    uint64_t start_offset,
    FoundResult* __restrict__ found,
    int* __restrict__ found_flag,
    uint64_t batch_size
) {
    // Shared memory for base point
    __shared__ Point s_P;
    __shared__ char s_pattern[MAX_PATTERN_LEN + 1];
    __shared__ int s_pattern_len;

    // Thread 0 loads base point and pattern into shared memory
    if (threadIdx.x == 0) {
        s_P = *base_P;
        s_pattern_len = pattern_len;
        for (int i = 0; i <= pattern_len && i < MAX_PATTERN_LEN; i++) {
            s_pattern[i] = target_pattern[i];
        }
    }
    __syncthreads();

    // Quick exit if already found
    if (*found_flag) return;

    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    uint64_t my_start = start_offset + (uint64_t)tid * batch_size;

    // Compute P + my_start * G
    Point current;
    scalar_mul_G(current, my_start);
    point_add(current, s_P, current);
    to_affine(current);

    Point G = generator_point();

    for (uint64_t i = 0; i < batch_size; i++) {
        if (i % 64 == 0 && *found_flag) return;

        uint64_t d = my_start + i;

        uint8_t pubkey_bytes[32];
        point_to_bytes(pubkey_bytes, current);

        char npub[NPUB_LEN + 1];
        encode_npub(npub, pubkey_bytes);

        if (matches_pattern(npub, s_pattern, s_pattern_len)) {
            int old = atomicExch(found_flag, 1);
            if (old == 0) {
                found->offset = d;
                for (int j = 0; j <= NPUB_LEN; j++) {
                    found->npub[j] = npub[j];
                }
                found->matched = 1;
            }
            return;
        }

        // Incremental addition: current += G
        Point next;
        point_add(next, current, G);
        to_affine(next);
        current = next;
    }
}

// ─── Device probe function ───────────────────────────────────────────────────
// Called from host to check if a CUDA device is available
// Returns the number of CUDA-capable devices
int probe_cuda_device() {
    int device_count = 0;
    cudaError_t err = cudaGetDeviceCount(&device_count);
    if (err != cudaSuccess) {
        return 0;
    }
    return device_count;
}

// ─── Get device info string ──────────────────────────────────────────────────
void get_device_info(int device_id, char* name, int* major, int* minor) {
    cudaDeviceProp prop;
    cudaError_t err = cudaGetDeviceProperties(&prop, device_id);
    if (err != cudaSuccess) {
        strncpy(name, "Unknown", 256);
        *major = 0;
        *minor = 0;
        return;
    }
    strncpy(name, prop.name, 256);
    *major = prop.major;
    *minor = prop.minor;
}

// ─── Host-side bech32 (for verification) ─────────────────────────────────────
// We need a host-side bech32 encoder to:
//   1. Decode the input npub to 32 bytes
//   2. Verify the result npub matches the expected offset

#include <cstring>
#include <vector>
#include <string>

// Bech32 charset
static const char BECH32_CHARSET_HOST[] = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// Bech32 generator
static uint32_t bech32_polymod_host(const std::vector<uint8_t>& values) {
    uint32_t chk = 1;
    const uint32_t GEN[5] = {0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3};
    for (uint8_t v : values) {
        uint32_t b = chk >> 25;
        chk = ((chk & 0x1FFFFFF) << 5) ^ v;
        for (int j = 0; j < 5; j++) {
            if ((b >> j) & 1) chk ^= GEN[j];
        }
    }
    return chk;
}

static std::vector<uint8_t> bech32_hrp_expand_host(const std::string& hrp) {
    std::vector<uint8_t> ret;
    for (char c : hrp) ret.push_back(c >> 5);
    ret.push_back(0);
    for (char c : hrp) ret.push_back(c & 31);
    return ret;
}

static void convert_bits_8to5_host(std::vector<uint8_t>& out,
                                    const uint8_t* in, int in_len) {
    int acc = 0;
    int acc_bits = 0;
    for (int i = 0; i < in_len; i++) {
        acc = (acc << 8) | in[i];
        acc_bits += 8;
        while (acc_bits >= 5) {
            acc_bits -= 5;
            out.push_back((acc >> acc_bits) & 0x1F);
        }
    }
    if (acc_bits > 0) {
        out.push_back((acc << (5 - acc_bits)) & 0x1F);
    }
}

static std::string bech32_encode_host(const std::string& hrp,
                                        const uint8_t* data, int data_len) {
    std::vector<uint8_t> values = bech32_hrp_expand_host(hrp);
    std::vector<uint8_t> data5;
    convert_bits_8to5_host(data5, data, data_len);

    // Build full values for checksum
    std::vector<uint8_t> all = values;
    for (auto d : data5) all.push_back(d);
    for (int i = 0; i < 6; i++) all.push_back(0);

    uint32_t mod = bech32_polymod_host(all) ^ 1;

    // Build output string
    std::string result = hrp + "1";
    for (auto d : data5) result += BECH32_CHARSET_HOST[d];
    for (int i = 0; i < 6; i++) {
        result += BECH32_CHARSET_HOST[(mod >> (5 * (5 - i))) & 0x1F];
    }
    return result;
}

// Decode bech32 to data bytes
static bool bech32_decode_host(const std::string& str,
                                 std::string& hrp,
                                 std::vector<uint8_t>& data) {
    // Find separator
    size_t pos = str.rfind('1');
    if (pos == std::string::npos || pos < 1 || pos + 7 > str.size()) return false;

    hrp = str.substr(0, pos);
    std::string data_part = str.substr(pos + 1);

    // Convert characters to 5-bit values
    for (char c : data_part) {
        const char* p = strchr(BECH32_CHARSET_HOST, c);
        if (!p) return false;
        data.push_back(p - BECH32_CHARSET_HOST);
    }

    // Verify checksum
    std::vector<uint8_t> values = bech32_hrp_expand_host(hrp);
    for (auto d : data) values.push_back(d);
    if (bech32_polymod_host(values) != 1) return false;

    // Remove checksum (last 6 values)
    data.resize(data.size() - 6);

    return true;
}

// Convert 5-bit groups back to 8-bit bytes
static std::vector<uint8_t> convert_bits_5to8_host(const std::vector<uint8_t>& in5) {
    std::vector<uint8_t> out;
    int acc = 0;
    int acc_bits = 0;
    for (uint8_t v : in5) {
        acc = (acc << 5) | v;
        acc_bits += 5;
        while (acc_bits >= 8) {
            acc_bits -= 8;
            out.push_back((acc >> acc_bits) & 0xFF);
        }
    }
    return out;
}

// ─── Parse npub1... to 32-byte public key ────────────────────────────────────
bool parse_npub(const std::string& npub_str, uint8_t out[32]) {
    std::string hrp;
    std::vector<uint8_t> data5;
    if (!bech32_decode_host(npub_str, hrp, data5)) return false;
    if (hrp != "npub") return false;

    std::vector<uint8_t> bytes = convert_bits_5to8_host(data5);
    if (bytes.size() != 32) return false;

    memcpy(out, bytes.data(), 32);
    return true;
}

// ─── Encode 32-byte public key to npub1... ───────────────────────────────────
std::string encode_npub_host(const uint8_t pubkey[32]) {
    return bech32_encode_host("npub", pubkey, 32);
}