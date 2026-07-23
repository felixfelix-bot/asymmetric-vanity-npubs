pub mod cli;
pub mod entropy;
pub mod mnemonic;
pub mod offset;
pub mod tests;
pub mod utils;

/// Bech32 human-readable part for Nostr public keys. Centralised here so both
/// the library (`entropy::npub_entropy`) and the binary (`main.rs`) agree on it.
pub const BECH32_PREFIX: &str = "npub1";
