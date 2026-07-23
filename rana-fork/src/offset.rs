//! Offset grinding: compute P + d·G for incrementing d.
//!
//! This module implements the VNAAS offset grinding mode. Given a base
//! public key P (parsed from an npub), it iterates d = 1, 2, 3, … and
//! computes the derived public key P + d·G using secp256k1 EC point
//! addition. The resulting public key is bech32-encoded and checked
//! against the user's vanity patterns.
//!
//! **No private keys are ever generated or handled.** The server only
//! sees the public key and returns the offset `d` to the client, who
//! applies it locally: `new_nsec = (old_nsec + d) mod n`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use nostr::prelude::*;
use serde::Serialize;

use crate::entropy;
use crate::BECH32_PREFIX;

/// JSON-serialisable result of an offset grind.
#[derive(Serialize)]
pub struct OffsetResult {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<FingerprintJson>,
    pub keys_tried: u64,
    pub duration_secs: f64,
    pub rate_per_sec: f64,
}

#[derive(Serialize, Clone)]
pub struct FingerprintJson {
    pub side: String,
    pub length: usize,
    pub entropy: f64,
    pub difficulty: f64,
}

/// Check whether a bech32 npub matches any of the given prefix or suffix patterns.
/// Returns the matched pattern string if found, or None.
fn check_vanity(
    bech_key: &str,
    prefixes: &[String],
    suffixes: &[String],
) -> Option<(String, bool /* is_prefix */)> {
    let data = bech_key.strip_prefix(BECH32_PREFIX).unwrap_or(bech_key);

    for p in prefixes {
        if data.starts_with(p.as_str()) {
            return Some((p.clone(), true));
        }
    }
    for s in suffixes {
        if data.ends_with(s.as_str()) {
            return Some((s.clone(), false));
        }
    }
    None
}

/// Compute a simple z-score for the entropy of the npub data portion.
///
/// Under the null hypothesis (random bech32), each of the 32 symbols is
/// uniformly distributed, giving Shannon entropy → log2(32) = 5.0 bits/char.
/// The standard deviation for a sample of length L can be approximated;
/// for the bech32 alphabet, the per-character entropy variance is small.
///
/// We use a simplified model: z = (5.0 - H) / sigma, where sigma is
/// estimated from the alphabet size. For 32 symbols, the entropy of a
/// multinomial sample has std dev ≈ sqrt((K-1)/(2*L*K)) * log2(K) where
/// K=32 symbols. This gives sigma ≈ log2(32) * sqrt(31/(2*L*32)).
fn compute_z_score(npub_bech32: &str) -> f64 {
    let h = entropy::npub_entropy(npub_bech32);
    let data = npub_bech32
        .strip_prefix(BECH32_PREFIX)
        .unwrap_or(npub_bech32);
    let l = data.len() as f64;
    if l == 0.0 {
        return 0.0;
    }

    // K = 32 (bech32 alphabet size)
    let k = 32.0_f64;
    // Approximate std dev of Shannon entropy for multinomial with K equally-likely symbols
    // sigma ≈ sqrt((K-1) / (2 * L * K)) * log2(K)
    let sigma = ((k - 1.0) / (2.0 * l * k)).sqrt() * k.log2();
    if sigma < 1e-10 {
        return 0.0;
    }

    // z-score: how far below max entropy (5.0) this sample is
    (5.0 - h) / sigma
}

/// Run the offset grinding loop.
///
/// Parses the npub, then spawns `num_cores` threads, each grabbing chunks
/// of the counter space and computing P + d·G for each d.
///
/// On match: prints JSON (if `json_mode`) or human-readable output, then exits.
/// On timeout: prints timeout JSON and exits with code 1.
pub fn grind_offset(
    npub_input: &str,
    prefixes: &[String],
    suffixes: &[String],
    num_cores: usize,
    json_mode: bool,
    scan_entropy: bool,
    min_z_score: f64,
    timeout_secs: u64,
) -> ! {
    // Parse the npub to get the base XOnlyPublicKey P
    let base_pubkey = XOnlyPublicKey::from_bech32(npub_input).unwrap_or_else(|e| {
        eprintln!("Error: failed to parse npub '{}': {}", npub_input, e);
        std::process::exit(1);
    });

    if !json_mode {
        println!("Offset grinding mode (VNAAS)");
        println!("Base public key: {}", npub_input);
        if !prefixes.is_empty() {
            println!("Vanity prefixes: {:?}", prefixes);
        }
        if !suffixes.is_empty() {
            println!("Vanity suffixes: {:?}", suffixes);
        }
        println!("Cores: {}", num_cores);
        if scan_entropy {
            println!("Entropy scanning enabled (min z-score: {})", min_z_score);
        }
        if timeout_secs > 0 {
            println!("Timeout: {}s", timeout_secs);
        }
        println!("---");
    }

    let nonce = Arc::new(AtomicU64::new(1)); // start at d=1
    let chunk_size: u64 = 100_000;
    let found = Arc::new(AtomicBool::new(false));
    let iterations = Arc::new(AtomicU64::new(0));
    let start = Instant::now();

    // Shared result
    let result: Arc<Mutex<Option<(u64, String, String, Option<f64>, Option<FingerprintJson>)>>> =
        Arc::new(Mutex::new(None));

    for _ in 0..num_cores {
        let base_pubkey = base_pubkey;
        let prefixes = Arc::new(prefixes.to_vec());
        let suffixes = Arc::new(suffixes.to_vec());
        let nonce = Arc::clone(&nonce);
        let found = Arc::clone(&found);
        let iterations = Arc::clone(&iterations);
        let result = Arc::clone(&result);
        let scan_entropy = scan_entropy;
        let min_z_score = min_z_score;

        thread::spawn(move || {
            loop {
                if found.load(Ordering::Relaxed) {
                    return;
                }

                let chunk_start = nonce.fetch_add(chunk_size, Ordering::Relaxed);
                let chunk_end = chunk_start + chunk_size;

                // Compute P + chunk_start * G as a starting point.
                // We use SecretKey::from_slice to create a scalar from the
                // counter value, then use XOnlyPublicKey::add_tweak.
                let mut current_pub: XOnlyPublicKey = base_pubkey;

                // Tweak by chunk_start to get P + chunk_start * G
                let start_scalar = scalar_from_u64(chunk_start);
                match current_pub.add_tweak(&SECP256K1, &start_scalar) {
                    Ok((pk, _parity)) => current_pub = pk,
                    Err(_) => continue, // extremely unlikely (scalar >= curve order)
                }

                for d in chunk_start..chunk_end {
                    if found.load(Ordering::Relaxed) {
                        return;
                    }

                    iterations.fetch_add(1, Ordering::Relaxed);

                    // Encode current public key as npub
                    let bech_key = match current_pub.to_bech32() {
                        Ok(s) => s,
                        Err(_) => {
                            // Advance to next
                            let one = Scalar::ONE;
                            if let Ok((pk, _)) = current_pub.add_tweak(&SECP256K1, &one) {
                                current_pub = pk;
                            }
                            continue;
                        }
                    };

                    // Check vanity patterns
                    if let Some((pattern, _is_prefix)) =
                        check_vanity(&bech_key, &prefixes, &suffixes)
                    {
                        // Optionally scan for entropy outlier
                        let mut z_score: Option<f64> = None;
                        let mut fingerprint: Option<FingerprintJson> = None;

                        if scan_entropy {
                            let z = compute_z_score(&bech_key);
                            z_score = Some(z);

                            // Also compute best edge fingerprint
                            let edge = entropy::best_edge(&bech_key);
                            fingerprint = Some(FingerprintJson {
                                side: match edge.side {
                                    entropy::EdgeSide::Prefix => "prefix".to_string(),
                                    entropy::EdgeSide::Suffix => "suffix".to_string(),
                                },
                                length: edge.length,
                                entropy: edge.entropy,
                                difficulty: edge.difficulty,
                            });

                            // If min_z_score is set and we don't meet it, keep grinding
                            if min_z_score > 0.0 && z < min_z_score {
                                // Not good enough — advance and continue
                                let one = Scalar::ONE;
                                if let Ok((pk, _)) = current_pub.add_tweak(&SECP256K1, &one) {
                                    current_pub = pk;
                                }
                                continue;
                            }
                        }

                        // Found a match!
                        found.store(true, Ordering::SeqCst);
                        let mut guard = result.lock().unwrap();
                        *guard = Some((d, bech_key.clone(), pattern, z_score, fingerprint));
                        return;
                    }

                    // Advance: current = current + G (i.e., P + (d+1)*G)
                    let one = Scalar::ONE;
                    if let Ok((pk, _)) = current_pub.add_tweak(&SECP256K1, &one) {
                        current_pub = pk;
                    } else {
                        // Overflow of curve order — extremely unlikely
                        break;
                    }
                }
            }
        });
    }

    // Main thread: wait for found or timeout
    if timeout_secs > 0 {
        loop {
            if found.load(Ordering::SeqCst) {
                break;
            }
            if start.elapsed().as_secs() >= timeout_secs {
                // Timeout
                let total_iters = iterations.load(Ordering::Relaxed);
                let elapsed = start.elapsed().as_secs_f64();
                let rate = if elapsed > 0.0 {
                    total_iters as f64 / elapsed
                } else {
                    0.0
                };

                if json_mode {
                    let result_json = OffsetResult {
                        found: false,
                        offset: None,
                        npub: None,
                        pattern: None,
                        z_score: None,
                        fingerprint: None,
                        keys_tried: total_iters,
                        duration_secs: elapsed,
                        rate_per_sec: rate,
                    };
                    println!("{}", serde_json::to_string(&result_json).unwrap());
                } else {
                    println!("Timeout after {}s. Tried {} keys ({:.0} keys/sec)", 
                             timeout_secs, total_iters, rate);
                }
                std::process::exit(1);
            }
            thread::sleep(Duration::from_millis(100));
        }
    } else {
        // No timeout — just spin
        loop {
            if found.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    // Output result
    let guard = result.lock().unwrap();
    if let Some((d, npub, pattern, z_score, fingerprint)) = guard.as_ref() {
        let total_iters = iterations.load(Ordering::Relaxed);
        let elapsed = start.elapsed().as_secs_f64();
        let rate = if elapsed > 0.0 {
            total_iters as f64 / elapsed
        } else {
            0.0
        };

        if json_mode {
            let result_json = OffsetResult {
                found: true,
                offset: Some(d.to_string()),
                npub: Some(npub.clone()),
                pattern: Some(pattern.clone()),
                z_score: *z_score,
                fingerprint: fingerprint.clone(),
                keys_tried: total_iters,
                duration_secs: elapsed,
                rate_per_sec: rate,
            };
            println!("{}", serde_json::to_string(&result_json).unwrap());
        } else {
            println!("=== Offset Grinding Result ===");
            println!("Offset: {}", d);
            println!("Vanity NPUB: {}", npub);
            println!("Matched pattern: {}", pattern);
            if let Some(z) = z_score {
                println!("Z-score: {:.4}", z);
            }
            if let Some(fp) = fingerprint {
                println!(
                    "Fingerprint: {} edge, {} chars, entropy {:.3} bits/char, difficulty {:.1}",
                    fp.side, fp.length, fp.entropy, fp.difficulty
                );
            }
            println!(
                "Keys tried: {} in {:.2}s ({:.0} keys/sec)",
                total_iters, elapsed, rate
            );
            println!();
            println!("To apply: new_nsec = (your_nsec + {}) mod n", d);
            println!("Verify:   new_npub == bech32((your_secret_key + {}) * G)", d);
        }
    }

    std::process::exit(0);
}

/// Create a Scalar from a u64 value (big-endian 32-byte representation).
fn scalar_from_u64(val: u64) -> Scalar {
    let mut bytes = [0u8; 32];
    // Big-endian: most significant byte first
    let val_bytes = val.to_be_bytes();
    bytes[24..32].copy_from_slice(&val_bytes);
    // This will never fail for values < curve order (which all u64 values are)
    Scalar::from_be_bytes(bytes).unwrap_or(Scalar::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scalar_from_u64() {
        let s = scalar_from_u64(1);
        assert_eq!(s, Scalar::ONE);

        let s0 = scalar_from_u64(0);
        assert_eq!(s0, Scalar::ZERO);

        let s42 = scalar_from_u64(42);
        let bytes = s42.to_be_bytes();
        // Last 8 bytes should be 42 in big-endian
        assert_eq!(&bytes[24..32], &42u64.to_be_bytes());
    }

    #[test]
    fn test_check_vanity_prefix() {
        let npub = "npub1meshmateabc123";
        let prefixes = vec!["meshmate".to_string()];
        let suffixes: Vec<String> = vec![];
        let result = check_vanity(npub, &prefixes, &suffixes);
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "meshmate");
    }

    #[test]
    fn test_check_vanity_suffix() {
        let npub = "npub1abc123meshmate";
        let prefixes: Vec<String> = vec![];
        let suffixes = vec!["meshmate".to_string()];
        let result = check_vanity(npub, &prefixes, &suffixes);
        assert!(result.is_some());
        assert_eq!(result.unwrap().0, "meshmate");
    }

    #[test]
    fn test_check_vanity_no_match() {
        let npub = "npub1xyz123abc";
        let prefixes = vec!["meshmate".to_string()];
        let suffixes = vec!["vanity".to_string()];
        let result = check_vanity(npub, &prefixes, &suffixes);
        assert!(result.is_none());
    }

    #[test]
    fn test_compute_z_score() {
        // Random-ish npub should have z-score near 0
        let npub = "npub1x7m2kp9qfl5d3wrt8hnqzy0vce4plm3k9j5w7f2g6h8d4s1n";
        let z = compute_z_score(npub);
        // Should be small for a diverse string
        assert!(z.abs() < 10.0, "z-score {} should be reasonable", z);
    }

    #[test]
    fn test_compute_z_score_repetitive() {
        // Highly repetitive npub should have high z-score
        let npub = "npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let z = compute_z_score(npub);
        assert!(z > 0.0, "repetitive npub should have positive z-score, got {}", z);
    }
}