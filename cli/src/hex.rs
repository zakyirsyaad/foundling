//! Hex helpers.

pub const SALT_BYTES: usize = 32;

pub fn encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) || !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|start| u8::from_str_radix(&text[start..start + 2], 16).ok())
        .collect()
}
