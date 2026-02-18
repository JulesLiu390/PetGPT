// Shared BMP writer — platform-independent, used by macos.rs and linux.rs.
// BMP natively stores BGRA, so this is a pure memcpy with a 54-byte header.

use std::path::Path;
use std::io::Write;

/// Write BGRA pixel data as a BMP file (zero encoding overhead).
pub fn write_bmp_file(path: &Path, bgra: &[u8], width: u32, height: u32) -> Result<(), String> {
    let row_size = (width * 4) as usize;
    let pixel_data_size = row_size * height as usize;
    let file_size = 54 + pixel_data_size as u32;

    let mut file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create BMP file: {}", e))?;

    // BMP File Header (14 bytes)
    file.write_all(b"BM").map_err(|e| e.to_string())?;
    file.write_all(&file_size.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&[0u8; 4]).map_err(|e| e.to_string())?;
    file.write_all(&54u32.to_le_bytes()).map_err(|e| e.to_string())?;

    // DIB Header - BITMAPINFOHEADER (40 bytes)
    file.write_all(&40u32.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&width.to_le_bytes()).map_err(|e| e.to_string())?;
    // Negative height = top-down row order (avoids flipping pixels)
    file.write_all(&(-(height as i32)).to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&32u16.to_le_bytes()).map_err(|e| e.to_string())?;
    file.write_all(&[0u8; 24]).map_err(|e| e.to_string())?;

    // Pixel data — BGRA direct write
    file.write_all(&bgra[..pixel_data_size]).map_err(|e| e.to_string())?;

    Ok(())
}
