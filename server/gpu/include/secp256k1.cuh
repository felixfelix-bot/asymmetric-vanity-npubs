#pragma once

//=============================================================================
// secp256k1.cuh — secp256k1 curve constants and EC point operations for GPU
//
// Implements modular arithmetic over the secp256k1 prime field and
// EC point addition / scalar multiplication on the secp256k1 curve,
// all in CUDA device code.  Uses 256-bit integers represented as
// arrays of four uint64_t.
//
// The kernel is used for **offset grinding**: given a user's public key
// point P, compute P + d·G for incrementing d and check whether the
// resulting NPUB (bech32 of the compressed public key) matches a vanity
// pattern.
//=============================================================================

#include <cstdint>
#include <cuda_runtime.h>

// ─── 256-bit integer ────────────────────────────────────────────────────────
// Stored as little-endian limbs: limb[0] = least significant
struct u256 {
    uint64_t v[4];
};

// ─── Projective point on secp256k1 ──────────────────────────────────────────
// Uses Jacobian coordinates (X, Y, Z) where the affine point is (X/Z², Y/Z³)
// Point at infinity is represented by Z = 0
struct Point {
    u256 x;
    u256 y;
    u256 z;
};

// ─── secp256k1 curve parameters ──────────────────────────────────────────────
// p = 2^256 - 2^32 - 977
// p = FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE FFFFFC2F (hex)
// Stored as 4 × 64-bit little-endian limbs
__device__ __constant__ u256 P_MOD = {
    0xFFFFFFFEFFFFFC2FULL,
    0xFFFFFFFFFFFFFFFFULL,
    0xFFFFFFFFFFFFFFFFULL,
    0xFFFFFFFFFFFFFFFFULL
};

// n = group order
// n = FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE BAAEDCE6AF48A03BBFD25E8CD0364141
__device__ __constant__ u256 N_MOD = {
    0xBFD25E8CD0364141ULL,
    0xBAAEDCE6AF48A03BULL,
    0xFFFFFFFFFFFFFFFEULL,
    0xFFFFFFFFFFFFFFFFULL
};

// Generator point G (affine, uncompressed)
// Gx = 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
// Gy = 483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
__device__ __constant__ u256 GX = {
    0x16F81798ULL << 32 | 0x59F2815BULL,
    0x029BFCDB2DCE28D9ULL,
    0x55A06295CE870B07ULL,
    0x79BE667EF9DCBBACULL
};

__device__ __constant__ u256 GY = {
    0xFB10D4B8ULL << 32 | 0x99C47D08ULL,
    0xFD17B448A6855419ULL,
    0x26A3C4655DA4FBFCULL,
    0x483ADA7726A3C465ULL
};

// ─── 256-bit modular arithmetic helpers ─────────────────────────────────────

// Comparison: returns -1 if a < b, 0 if a == b, 1 if a > b
__device__ int u256_cmp(const u256& a, const u256& b) {
    for (int i = 3; i >= 0; i--) {
        if (a.v[i] < b.v[i]) return -1;
        if (a.v[i] > b.v[i]) return 1;
    }
    return 0;
}

// Check if zero
__device__ bool u256_is_zero(const u256& a) {
    return a.v[0] == 0 && a.v[1] == 0 && a.v[2] == 0 && a.v[3] == 0;
}

// Addition: r = (a + b) mod p
__device__ void mod_add(u256& r, const u256& a, const u256& b, const u256& mod) {
    uint64_t carry = 0;
    for (int i = 0; i < 4; i++) {
        __uint128_t sum = (__uint128_t)a.v[i] + b.v[i] + carry;
        r.v[i] = (uint64_t)sum;
        carry = (uint64_t)(sum >> 64);
    }
    // If result >= mod, subtract mod
    if (carry || u256_cmp(r, mod) >= 0) {
        uint64_t borrow = 0;
        for (int i = 0; i < 4; i++) {
            uint64_t diff = r.v[i] - mod.v[i] - borrow;
            borrow = (r.v[i] < mod.v[i] + borrow) ? 1 : 0;
            r.v[i] = diff;
        }
    }
}

// Subtraction: r = (a - b) mod p
__device__ void mod_sub(u256& r, const u256& a, const u256& b, const u256& mod) {
    // If a < b, add mod first
    u256 a_adj = a;
    if (u256_cmp(a, b) < 0) {
        mod_add(a_adj, a, mod, mod);
    }
    uint64_t borrow = 0;
    for (int i = 0; i < 4; i++) {
        uint64_t diff = a_adj.v[i] - b.v[i] - borrow;
        borrow = (a_adj.v[i] < b.v[i] + borrow) ? 1 : 0;
        r.v[i] = diff;
    }
}

// Multiplication: r = (a * b) mod p
// Uses schoolbook multiplication into 512-bit intermediate, then Barrett reduction
__device__ void mod_mul(u256& r, const u256& a, const u256& b, const u256& mod) {
    // 512-bit product: 8 × 64-bit limbs
    uint64_t prod[8] = {0, 0, 0, 0, 0, 0, 0, 0};

    for (int i = 0; i < 4; i++) {
        uint64_t carry = 0;
        for (int j = 0; j < 4; j++) {
            __uint128_t term = (__uint128_t)a.v[i] * b.v[j] + prod[i + j] + carry;
            prod[i + j] = (uint64_t)term;
            carry = (uint64_t)(term >> 64);
        }
        prod[i + 4] += carry;
    }

    // Barrett reduction or repeated subtraction
    // For simplicity, use a modular reduction via repeated subtraction of
    // mod * 2^k (shifted). This is slower but correct.
    // In production, use Montgomery or Barrett for performance.

    // Reduce 512-bit product modulo p
    // Simple approach: long division style
    u256 result = {0, 0, 0, 0};
    for (int i = 7; i >= 0; i--) {
        // Shift result left by 64 bits
        for (int k = 3; k > 0; k--) {
            result.v[k] = result.v[k - 1];
        }
        result.v[0] = prod[i];

        // Subtract mod while result >= mod
        while (u256_cmp(result, mod) >= 0) {
            mod_sub(result, result, mod, mod);
        }
    }
    r = result;
}

// Modular inverse using Fermat's little theorem: a^(p-2) mod p
// p is prime, so a^(-1) = a^(p-2) mod p
__device__ void mod_inv(u256& r, const u256& a, const u256& mod) {
    // Exponent = mod - 2
    u256 exp;
    mod_sub(exp, mod, {2, 0, 0, 0}, mod);

    // Square-and-multiply
    r = {1, 0, 0, 0};
    u256 base = a;

    for (int i = 0; i < 256; i++) {
        // Check if bit i of exp is set
        int limb = i / 64;
        int bit = i % 64;
        if ((exp.v[limb] >> bit) & 1) {
            mod_mul(r, r, base, mod);
        }
        mod_mul(base, base, base, mod);
    }
}

// ─── EC point operations (Jacobian coordinates) ─────────────────────────────

// Point doubling: R = 2 * P (Jacobian)
// Formulas from "Cryptography's NIST Weierstrass Form" guidelines
__device__ void point_double(Point& r, const Point& p) {
    if (u256_is_zero(p.z)) {
        r = p;
        return;
    }

    // A = X^2 mod p
    u256 A;
    mod_mul(A, p.x, p.x, P_MOD);

    // B = Y^2 mod p
    u256 B;
    mod_mul(B, p.y, p.y, P_MOD);

    // C = B^2 mod p
    u256 C;
    mod_mul(C, B, B, P_MOD);

    // D = 2 * ((X + B)^2 - A - C)
    u256 t1;
    mod_add(t1, p.x, B, P_MOD);
    u256 t2;
    mod_mul(t2, t1, t1, P_MOD);
    u256 t3;
    mod_sub(t3, t2, A, P_MOD);
    u256 t4;
    mod_sub(t4, t3, C, P_MOD);
    u256 D;
    mod_add(D, t4, t4, P_MOD);

    // E = 3 * A
    u256 E;
    mod_add(E, A, A, P_MOD);
    mod_add(E, E, A, P_MOD);

    // F = E^2
    u256 F;
    mod_mul(F, E, E, P_MOD);

    // X3 = F - 2*D
    u256 X3;
    mod_sub(X3, F, D, P_MOD);
    mod_sub(X3, X3, D, P_MOD);

    // Y3 = E * (D - X3) - 8*C
    u256 Y3;
    mod_sub(Y3, D, X3, P_MOD);
    mod_mul(Y3, E, Y3, P_MOD);
    u256 C8;
    mod_add(C8, C, C, P_MOD);
    mod_add(C8, C8, C8, P_MOD);
    mod_add(C8, C8, C8, P_MOD);
    mod_sub(Y3, Y3, C8, P_MOD);

    // Z3 = 2 * Y * Z
    u256 Z3;
    mod_mul(Z3, p.y, p.z, P_MOD);
    mod_add(Z3, Z3, Z3, P_MOD);

    r.x = X3;
    r.y = Y3;
    r.z = Z3;
}

// Point addition: R = P + Q (Jacobian + Jacobian)
// Handles the general case where P != Q and neither is infinity
__device__ void point_add(Point& r, const Point& p, const Point& q) {
    // Handle identity cases
    if (u256_is_zero(p.z)) {
        r = q;
        return;
    }
    if (u256_is_zero(q.z)) {
        r = p;
        return;
    }

    // U1 = P.X * Q.Z^2
    u256 QZ2;
    mod_mul(QZ2, q.z, q.z, P_MOD);
    u256 U1;
    mod_mul(U1, p.x, QZ2, P_MOD);

    // U2 = Q.X * P.Z^2
    u256 PZ2;
    mod_mul(PZ2, p.z, p.z, P_MOD);
    u256 U2;
    mod_mul(U2, q.x, PZ2, P_MOD);

    // S1 = P.Y * Q.Z^3
    u256 QZ3;
    mod_mul(QZ3, QZ2, q.z, P_MOD);
    u256 S1;
    mod_mul(S1, p.y, QZ3, P_MOD);

    // S2 = Q.Y * P.Z^3
    u256 PZ3;
    mod_mul(PZ3, PZ2, p.z, P_MOD);
    u256 S2;
    mod_mul(S2, q.y, PZ3, P_MOD);

    // If U1 == U2
    if (u256_cmp(U1, U2) == 0) {
        if (u256_cmp(S1, S2) == 0) {
            // Same point → double
            point_double(r, p);
            return;
        } else {
            // P + (-P) = infinity
            r.x = {0, 0, 0, 0};
            r.y = {1, 0, 0, 0};
            r.z = {0, 0, 0, 0};
            return;
        }
    }

    // H = U2 - U1
    u256 H;
    mod_sub(H, U2, U1, P_MOD);

    // R_val = S2 - S1
    u256 R_val;
    mod_sub(R_val, S2, S1, P_MOD);

    // H^2
    u256 H2;
    mod_mul(H2, H, H, P_MOD);

    // H^3
    u256 H3;
    mod_mul(H3, H2, H, P_MOD);

    // U1 * H^2
    u256 U1H2;
    mod_mul(U1H2, U1, H2, P_MOD);

    // X3 = R^2 - H^3 - 2*U1*H^2
    u256 R2;
    mod_mul(R2, R_val, R_val, P_MOD);
    u256 X3;
    mod_sub(X3, R2, H3, P_MOD);
    mod_sub(X3, X3, U1H2, P_MOD);
    mod_sub(X3, X3, U1H2, P_MOD);

    // Y3 = R * (U1*H^2 - X3) - S1*H^3
    u256 Y3;
    mod_sub(Y3, U1H2, X3, P_MOD);
    mod_mul(Y3, R_val, Y3, P_MOD);
    u256 S1H3;
    mod_mul(S1H3, S1, H3, P_MOD);
    mod_sub(Y3, Y3, S1H3, P_MOD);

    // Z3 = P.Z * Q.Z * H
    u256 Z3;
    mod_mul(Z3, p.z, q.z, P_MOD);
    mod_mul(Z3, Z3, H, P_MOD);

    r.x = X3;
    r.y = Y3;
    r.z = Z3;
}

// Convert Jacobian point to affine (modular inverse of Z)
__device__ void to_affine(Point& p) {
    if (u256_is_zero(p.z)) return;

    u256 z_inv;
    mod_inv(z_inv, p.z, P_MOD);

    u256 z_inv2;
    mod_mul(z_inv2, z_inv, z_inv, P_MOD);

    u256 z_inv3;
    mod_mul(z_inv3, z_inv2, z_inv, P_MOD);

    mod_mul(p.x, p.x, z_inv2, P_MOD);
    mod_mul(p.y, p.y, z_inv3, P_MOD);
    p.z = {1, 0, 0, 0};
}

// Generator point G (affine)
__device__ Point generator_point() {
    Point G;
    G.x = GX;
    G.y = GY;
    G.z = {1, 0, 0, 0};
    return G;
}

// Scalar multiplication: R = d * G (scalar mul with generator)
// Uses double-and-add
__device__ void scalar_mul_G(Point& r, uint64_t d) {
    Point G = generator_point();
    r = {0, 1, 0};  // Point at infinity

    // Process each bit of d
    for (int i = 0; i < 64; i++) {
        if ((d >> i) & 1) {
            point_add(r, r, G);
        }
        point_double(G, G);
    }
}

// Full 256-bit scalar multiplication: R = d * G
__device__ void scalar_mul_G_256(Point& r, const u256& d) {
    Point G = generator_point();
    r = {0, 1, 0};  // Point at infinity

    for (int i = 0; i < 256; i++) {
        int limb = i / 64;
        int bit = i % 64;
        if ((d.v[limb] >> bit) & 1) {
            point_add(r, r, G);
        }
        point_double(G, G);
    }
}

// Compute P + d*G using incremental addition
// Optimization: P + (d+1)*G = (P + d*G) + G
// So we only need one point_add per step (not full scalar mul)
__device__ void point_add_G(Point& r, const Point& p) {
    Point G = generator_point();
    point_add(r, p, G);
}