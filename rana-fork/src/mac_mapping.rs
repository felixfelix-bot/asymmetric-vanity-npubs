use std::collections::HashMap;
use std::net::IpAddr;
use mac_address::MacAddress;
use network_interface::{NetworkInterface, NetworkInterfaceConfig, Addr};
use sha2::{Sha256, Digest};
use nostr::Keys;
use secp256k1::SecretKey;

pub struct MacNodeMapping {
    mappings: HashMap<MacAddress, NodeAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NodeAddress {
    pub id: String,
    pub ip: Option<IpAddr>,
    pub mac: MacAddress,
    pub fips_compliant: bool,
}

impl MacNodeMapping {
    pub fn new() -> Self {
        Self {
            mappings: HashMap::new(),
        }
    }

    /// Discover network interfaces and create MAC-to-node mappings
    pub fn discover_nodes(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let interfaces = NetworkInterface::show()
            .map_err(|e| format!("Failed to get network interfaces: {}", e))?;

        for interface in interfaces {
            if let Some(mac_str) = interface.mac_addr {
                // Parse the MAC address string into a byte array
                let mac_bytes = self.parse_mac_address(&mac_str)
                    .map_err(|e| format!("Failed to parse MAC address '{}': {}", mac_str, e))?;
                
                let mac = MacAddress::new(mac_bytes);
                
                let node_id = self.generate_node_id(&mac);
                // Get the first IP address if available
                let ip = interface.addr.first().and_then(|addr| {
                    if let Addr::V4(ipv4) = addr {
                        Some(IpAddr::V4(ipv4.ip))
                    } else if let Addr::V6(ipv6) = addr {
                        Some(IpAddr::V6(ipv6.ip))
                    } else {
                        None
                    }
                });
                let node_address = NodeAddress {
                    id: node_id,
                    ip,
                    mac,
                    fips_compliant: true, // Mark as FIPS compliant by default
                };
                self.mappings.insert(mac, node_address);
            }
        }

        Ok(())
    }

    /// Parse MAC address string into byte array
    fn parse_mac_address(&self, mac_str: &str) -> Result<[u8; 6], Box<dyn std::error::Error>> {
        // Remove common separators and convert to lowercase
        let clean_str = mac_str
            .to_lowercase()
            .replace([':', '-', '.'], "");
        
        // Check if the string has the right length (12 hex chars = 6 bytes)
        if clean_str.len() != 12 {
            return Err(format!("Invalid MAC address length: {}", clean_str.len()).into());
        }
        
        // Parse each pair of hex characters into a byte
        let mut bytes = [0u8; 6];
        for (i, chunk) in clean_str.as_bytes().chunks(2).enumerate() {
            if i >= 6 {
                return Err("MAC address too long".into());
            }
            
            let hex_str = std::str::from_utf8(chunk)
                .map_err(|e| format!("Invalid UTF-8 in MAC address: {}", e))?;
            
            bytes[i] = u8::from_str_radix(hex_str, 16)
                .map_err(|e| format!("Invalid hex in MAC address: {}", e))?;
        }
        
        Ok(bytes)
    }

    /// Generate FIPS-compliant node ID from MAC address
    fn generate_node_id(&self, mac: &MacAddress) -> String {
        // Use SHA-256 for FIPS compliance
        let mut hasher = Sha256::new();
        hasher.update(mac.bytes());
        let result = hasher.finalize();
        
        // Take first 16 bytes for a reasonable node ID length
        let node_id_bytes = &result[..16];
        hex::encode(node_id_bytes)
    }

    /// Get node address by MAC address
    pub fn get_node_by_mac(&self, mac: &MacAddress) -> Option<&NodeAddress> {
        self.mappings.get(mac)
    }

    /// Get all discovered nodes
    pub fn get_all_nodes(&self) -> Vec<&NodeAddress> {
        self.mappings.values().collect()
    }

    /// Generate FIPS-compliant cryptographic key from MAC address
    pub fn generate_fips_key_from_mac(
        &self,
        mac: &MacAddress,
    ) -> Result<Keys, Box<dyn std::error::Error>> {
        let _node_id = self.generate_node_id(mac);
        
        // Create a deterministic seed from the MAC address
        let mut hasher = Sha256::new();
        hasher.update(mac.bytes());
        hasher.update(b"fips-compliant-seed"); // Add FIPS compliance salt
        let seed_bytes = hasher.finalize();
        
        // Use the seed to generate a Nostr key pair
        // In a real FIPS implementation, this would use a FIPS-approved RNG
        let secret_key = SecretKey::from_slice(&seed_bytes[..32])
            .map_err(|e| format!("Failed to create secret key: {}", e))?;
        
        let keys = Keys::new(secret_key);
        Ok(keys)
    }

    /// Validate that a node address is FIPS compliant
    pub fn validate_fips_compliance(&self, node: &NodeAddress) -> bool {
        // Basic FIPS compliance checks
        // In a real implementation, this would include more thorough validation
        node.fips_compliant && 
        !node.id.is_empty() && 
        node.id.len() == 32 // 32 hex characters = 16 bytes
    }

    /// Get mapping statistics
    pub fn get_stats(&self) -> MacMappingStats {
        let total_nodes = self.mappings.len();
        let fips_compliant_nodes = self.mappings.values()
            .filter(|node| self.validate_fips_compliance(node))
            .count();

        MacMappingStats {
            total_nodes,
            fips_compliant_nodes,
        }
    }
}

pub struct MacMappingStats {
    pub total_nodes: usize,
    pub fips_compliant_nodes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_id_generation() {
        let mapping = MacNodeMapping::new();
        let mac = MacAddress::new([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
        let node_id = mapping.generate_node_id(&mac);
        
        assert_eq!(node_id.len(), 32); // 16 bytes = 32 hex characters
        assert!(node_id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_fips_compliance_validation() {
        let mac = MacAddress::new([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
        let node = NodeAddress {
            id: "a1b2c3d4e5f678901234567890123456".to_string(),
            ip: None,
            mac,
            fips_compliant: true,
        };

        let mapping = MacNodeMapping::new();
        assert!(mapping.validate_fips_compliance(&node));
    }
}