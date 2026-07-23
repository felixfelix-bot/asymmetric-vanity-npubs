#pragma once

//=============================================================================
// vanity.cuh — Vanity pattern matching and bech32 encoding for GPU
//
// Provides device functions for:
//   1. Converting a secp256k1 public key point to a bech32 NPUB string
//   2. Checking whether the NPUB matches a vanity pattern (prefix, contains, suffix)
//
// The bech32 encoding is done on-device to avoid copying back to host
// for every key. Only matched results are copied back.
//=============================================================================

#include <cstdint>
#include <cuda_runtime.h>
#include "secp256k1.cuh"

// ─── Bech32 constants ───────────────────────────────────────────────────────
// Bech32 character set (BIP-173)
__device__ __constant__ const char BECH32_CHARSET[] = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// Bech32 generator constants
__device__ __constant__ const uint32_t BECH32_CONST = 1;
__device__ __constant__ const uint32_t BECH32_CONST_M1 = 2;
__device__ __constant__ const uint32_t BECH32_CONST_M2 = 4;
__device__ __constant__ const uint32_t BECH32_CONST_M3 = 8;
__device__ __constant__ const uint32_t BECH32_CONST_M4 = 16;

// ─── Bech32 polymod (device) ────────────────────────────────────────────────
__device__ uint32_t bech32_polymod(const uint8_t* values, int len) {
    uint32_t chk = 1;
    // Generator constants
    const uint32_t GEN[5] = {0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3};
    for (int i = 0; i < len; i++) {
        uint32_t b = chk >> 25;
        chk = ((chk & 0x1FFFFFF) << 5) ^ values[i];
        for (int j = 0; j < 5; j++) {
            if ((b >> j) & 1) {
                chk ^= GEN[j];
            }
        }
    }
    return chk;
}

// ─── Bech32 HRP expand ──────────────────────────────────────────────────────
__device__ void bech32_hrp_expand(uint8_t* output, int* out_len,
                                    const char* hrp, int hrp_len) {
    for (int i = 0; i < hrp_len; i++) {
        output[i] = hrp[i] >> 5;
    }
    output[hrp_len] = 0;
    for (int i = 0; i < hrp_len; i++) {
        output[hrp_len + 1 + i] = hrp[i] & 31;
    }
    *out_len = hrp_len * 2 + 1;
}

// ─── Convert bits (8-to-5) ──────────────────────────────────────────────────
// Converts 32 bytes (256 bits) to 52 five-bit groups (with padding)
__device__ void convert_bits_8to5(uint8_t* out5, const uint8_t* in8, int in_len) {
    int out_idx = 0;
    int acc = 0;
    int acc_bits = 0;
    for (int i = 0; i < in_len; i++) {
        acc = (acc << 8) | in8[i];
        acc_bits += 8;
        while (acc_bits >= 5) {
            acc_bits -= 5;
            out5[out_idx++] = (acc >> acc_bits) & 0x1F;
        }
    }
    if (acc_bits > 0) {
        out5[out_idx++] = (acc << (5 - acc_bits)) & 0x1F;
    }
}

// ─── Create checksum ────────────────────────────────────────────────────────
__device__ void bech32_create_checksum(uint8_t* checksum,
                                         const char* hrp, int hrp_len,
                                         const uint8_t* data, int data_len) {
    // Build values array: hrp_expand + data + [0,0,0,0,0,0]
    uint8_t values[256];
    int hrp_expanded[128];
    uint8_t hrp_exp[128];
    int hrp_exp_len;
    bech32_hrp_expand(hrp_exp, &hrp_exp_len, hrp, hrp_len);

    int total_len = hrp_exp_len + data_len + 6;
    uint8_t all_values[256];
    for (int i = 0; i < hrp_exp_len; i++) all_values[i] = hrp_exp[i];
    for (int i = 0; i < data_len; i++) all_values[hrp_exp_len + i] = data[i];
    for (int i = 0; i < 6; i++) all_values[hrp_exp_len + data_len + i] = 0;

    uint32_t mod = bech32_polymod(all_values, total_len) ^ 1;

    for (int i = 0; i < 6; i++) {
        checksum[i] = (mod >> (5 * (5 - i))) & 0x1F;
    }
}

// ─── Encode NPUB from 32-byte public key ────────────────────────────────────
// Produces "npub1..." string (up to 63 chars + null)
// HRP = "npub", data = 5-bit groups from 32 bytes, checksum = 6 groups
__device__ void encode_npub(char* out, const uint8_t pubkey[32]) {
    const char* hrp = "npub";
    int hrp_len = 4;

    // Convert 32 bytes to 5-bit groups (52 groups)
    uint8_t data5[52];
    convert_bits_8to5(data5, pubkey, 32);

    // Create checksum
    uint8_t checksum[6];
    bech32_create_checksum(checksum, hrp, hrp_len, data5, 52);

    // Build output string: "npub1" + data chars + checksum chars
    int pos = 0;
    // HRP
    out[pos++] = 'n';
    out[pos++] = 'p';
    out[pos++] = 'u';
    out[pos++] = 'b';
    // Separator
    out[pos++] = '1';
    // Data
    for (int i = 0; i < 52; i++) {
        out[pos++] = BECH32_CHARSET[data5[i]];
    }
    // Checksum
    for (int i = 0; i < 6; i++) {
        out[pos++] = BECH32_CHARSET[checksum[i]];
    }
    out[pos] = '\0';
}

// ─── Extract x-coordinate from affine point to 32 bytes ─────────────────────
// For NPUB encoding we use the x-coordinate (x-only public key, BIP-340 style)
__device__ void point_to_bytes(uint8_t out[32], const Point& p) {
    // Assume p is already in affine form (z = 1)
    // Copy x.v (4 × 64-bit) to 32 bytes (little-endian to big-endian)
    for (int i = 0; i < 4; i++) {
        uint64_t limb = p.x.v[3 - i];
        for (int j = 0; j < 8; j++) {
            out[i * 8 + j] = (uint8_t)(limb >> (56 - j * 8));
        }
    }
}

// ─── Pattern matching ───────────────────────────────────────────────────────
// Check if the NPUB string contains the pattern (case-insensitive)
// Returns 1 on match, 0 on no match
__device__ int matches_pattern(const char* npub, const char* pattern, int pattern_len) {
    // The bech32 charset is lowercase, so we compare directly
    // Check if pattern appears anywhere in the data part (after "npub1")
    // We check prefix match: npub1<pattern...>
    int npub_len = 0;
    while (npub[npub_len] != '\0') npub_len++;

    // The data part starts at index 5 (after "npub1")
    if (npub_len < 5 + pattern_len) return 0;

    // Check prefix match (right after "npub1")
    int match = 1;
    for (int i = 0; i < pattern_len; i++) {
        if (npub[5 + i] != pattern[i]) {
            match = 0;
            break;
        }
    }
    if (match) return 1;

    // Check "contains" match anywhere in the data part
    int data_len = npub_len - 5 - 6; // exclude hrp separator and checksum
    for (int start = 0; start <= data_len - pattern_len; start++) {
        match = 1;
        for (int i = 0; i < pattern_len; i++) {
            if (npub[5 + start + i] != pattern[i]) {
                match = 0;
                break;
            }
        }
        if (match) return 1;
    }

    return 0;
}

// ─── Full vanity check: compute P + d*G, encode NPUB, check pattern ──────────
// This is the hot-path function called per thread
// Returns 1 on match, fills out_npub
__device__ int check_vanity_offset(
    char* out_npub,
    const Point& base_P,      // User's public key P (affine)
    uint64_t d,                // Offset to try
    const char* pattern,
    int pattern_len
) {
    // Compute P + d*G
    // Optimization: if the caller maintains a running point, they can
    // use point_add_G incrementally. For standalone calls, we do full
    // scalar mul.
    Point dG;
    scalar_mul_G(dG, d);

    Point result;
    point_add(result, base_P, dG);
    to_affine(result);

    // Extract x-coordinate to 32 bytes
    uint8_t pubkey_bytes[32];
    point_to_bytes(pubkey_bytes, result);

    // Encode as NPUB
    encode_npub(out_npub, pubkey_bytes);

    // Check vanity pattern
    return matches_pattern(out_npub, pattern, pattern_len);
}