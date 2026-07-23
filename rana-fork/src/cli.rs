use clap::Parser;
use regex::Regex;

#[derive(Parser)]
#[command(
    name = "Rana",
    about = "A simple CLI to generate nostr vanity addresses",
    author,
    help_template = "\
{before-help}{name} 🐸

      o  o
     ( -- )
  /\\( ,   ,)/\\
^^   ^^  ^^   ^^

{about-with-newline}
{author-with-newline}
{usage-heading} {usage}

{all-args}{after-help}
",
    version
)]
pub struct CLIArgs {
    #[arg(
        short,
        long,
        default_value_t = 0,
        help = "Enter the number of starting bits that should be 0."
    )]
    pub difficulty: u8,
    #[arg(
        short,
        long = "vanity",
        required = false,
        default_value = "",
        help = "Enter the prefix your public key should have when expressed
as hexadecimal."
    )]
    pub vanity_prefix: String,
    #[arg(
        short = 'n',
        long = "vanity-n-prefix",
        required = false,
        default_value = "",
        help = "Enter the prefix your public key should have when expressed
in npub format (Bech32 encoding). Specify multiple vanity
targets as a comma-separated list."
    )]
    pub vanity_npub_prefixes_raw_input: String,
    #[arg(
        short = 's',
        long = "vanity-n-suffix",
        required = false,
        default_value = "",
        help = "Enter the suffix your public key should have when expressed
in npub format (Bech32 encoding). Specify multiple vanity
targets as a comma-separated list."
    )]
    pub vanity_npub_suffixes_raw_input: String,
    #[arg(
        short = 'c',
        long = "cores",
        default_value_t = num_cpus::get(),
        help = "Number of processor cores to use"
    )]
    pub num_cores: usize,

    #[arg(
        short = 'r',
        long = "restore",
        help = "Restore from mnemonic to public private key",
        default_value_t = String::from(""),
        required = false
    )]
    pub mnemonic: String,

    #[arg(
        short = 'g',
        long = "generate",
        help = "Generate mnemonic using wordcount. Should be 12,18 or 24",
        default_value_t = 0,
        required = false
    )]
    pub word_count: usize,

    #[arg(
        short = 'p',
        long = "passphrase",
        help = "Passphrase used for restoring mnemonic to keypair",
        default_value_t = String::from(""),
        required = false
    )]
    pub mnemonic_passphrase: String,

    #[arg(
        short,
        long = "qr",
        required = false,
        default_value_t = false,
        help = "Print QR code of the private key"
    )]
    pub qr: bool,

    #[arg(
        short = 'w',
        long = "verbose-output",
        required = false,
        default_value_t = false,
        help = "Print verbose ouput on non-matching public keys"
    )]
    pub verbose_output: bool,
    #[arg(
        long,
        default_value_t = false,
        help = "When true, disables difficulty scaling and keeps it fixed throughout."
    )]
    pub no_scaling: bool,

    #[arg(
        short = 'e',
        long = "entropy-threshold",
        required = false,
        help = "Mine for low-entropy npubs instead of a named vanity prefix. \
                Accepts the maximum Shannon entropy (bits/char) of the bech32 \
                data portion; lower values are more ordered/repetitive. Range \
                0.0-5.0. Mutually exclusive with difficulty/vanity options."
    )]
    pub entropy_threshold: Option<f64>,

    #[arg(
        long = "entropy-difficulty",
        required = false,
        help = "Mine for npubs with high entropy-edge difficulty (bits of \
                pattern: L×(5−H)). Rana auto-discovers the best prefix or \
                suffix edge of any length. Higher = longer and/or more \
                repetitive. Mutually exclusive with all other mining modes."
    )]
    pub entropy_difficulty: Option<f64>,

    /// ── Offset grinding mode (VNAAS) ──────────────────────────────────
    #[arg(
        long = "pubkey",
        required = false,
        help = "Grind offsets for an existing public key (npub1...). \
                Offset grinding mode — never generates private keys. \
                Computes P + d·G for incrementing d."
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
        help = "After finding vanity match, scan for entropy outlier (ADR-003/004). \
                Returns z-score, window size, and quality."
    )]
    pub scan_entropy: bool,

    #[arg(
        long = "min-z-score",
        required = false,
        default_value_t = 0.0,
        help = "Minimum z-score for entropy outlier acceptance. Only with --scan-entropy."
    )]
    pub min_z_score: f64,

    #[arg(
        long = "timeout",
        required = false,
        default_value_t = 0,
        help = "Timeout in seconds. 0 = no timeout."
    )]
    pub timeout_secs: u64,
}

pub fn check_args(
    difficulty: u8,
    vanity_prefix: &str,
    vanity_npub_prefixes: &Vec<String>,
    vanity_npub_suffixes: &Vec<String>,
    entropy_threshold: Option<f64>,
    entropy_difficulty: Option<f64>,
    num_cores: usize,
) {
    // Check the public key requirements
    let mut requirements_count: u8 = 0;
    if difficulty > 0 {
        requirements_count += 1;
    }
    if !vanity_prefix.is_empty() {
        requirements_count += 1;
    }
    if !vanity_npub_prefixes.is_empty() || !vanity_npub_suffixes.is_empty() {
        requirements_count += 1;
    }
    if entropy_threshold.is_some() {
        requirements_count += 1;
    }
    if entropy_difficulty.is_some() {
        requirements_count += 1;
    }

    if requirements_count > 1 {
        panic!("You can cannot specify more than one requirement. You should choose between difficulty, vanity formats, entropy threshold or entropy difficulty.");
    }

    if let Some(threshold) = entropy_threshold {
        // bech32 alphabet has 32 symbols → log2(32) == 5.0 is the theoretical max.
        if !(0.0..=5.0).contains(&threshold) {
            panic!(
                "The entropy threshold must be within [0.0, 5.0] (bech32 alphabet cap is log2(32) = 5.0), got {threshold}"
            );
        }
    }

    if let Some(target) = entropy_difficulty {
        if target <= 0.0 {
            panic!(
                "The entropy difficulty target must be positive (bits of pattern L×(5−H)), got {target}"
            );
        }
    }

    if vanity_prefix.len() > 64 {
        panic!("The vanity prefix cannot be longer than 64 characters.");
    }

    if !vanity_prefix.is_empty() {
        // check valid hexa characters
        let hex_re = Regex::new(r"^([0-9a-f]*)$").unwrap();
        if !hex_re.is_match(vanity_prefix) {
            panic!("The vanity prefix can only contain hexadecimal characters.");
        }
    }

    for vanity_npub_prefix in vanity_npub_prefixes {
        if !vanity_npub_prefix.is_empty() {
            let hex_re = Regex::new(r"^([02-9ac-hj-np-z]*)$").unwrap();
            if !hex_re.is_match(vanity_npub_prefix.as_str()) {
                panic!("The vanity npub prefix can only contain characters supported by Bech32: 023456789acdefghjklmnpqrstuvwxyz");
            }
        }
        if vanity_npub_prefix.len() > 59 {
            panic!("The vanity npub prefix cannot be longer than 59 characters.");
        }
    }

    for vanity_npub_suffix in vanity_npub_suffixes {
        if !vanity_npub_suffix.is_empty() {
            let hex_re = Regex::new(r"^([02-9ac-hj-np-z]*)$").unwrap();
            if !hex_re.is_match(vanity_npub_suffix.as_str()) {
                panic!("The vanity npub suffix can only contain characters supported by Bech32: 023456789acdefghjklmnpqrstuvwxyz");
            }
        }
        if vanity_npub_suffix.len() > 59 {
            panic!("The vanity npub suffix cannot be longer than 59 characters.");
        }
    }

    if num_cores == 0 {
        panic!("There can be no proof of work if one does not do work (-c, --cores must be greater than 0)");
    } else if num_cores > num_cpus::get() {
        panic!(
            "Your processor has {} cores; cannot set -c, --cores to {}",
            num_cpus::get(),
            num_cores
        );
    }
}
