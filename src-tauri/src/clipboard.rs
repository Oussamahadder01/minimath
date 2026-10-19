// Native multi-format clipboard, the way MathType publishes equations:
// several representations of the same equation at once, and the receiving
// application picks the richest one it understands.
//
//   flavor   Windows                                   macOS (NSPasteboard)
//   text     CF_UNICODETEXT                            public.utf8-plain-text
//   mathml   "MathML", "MathML Presentation",          "MathML", "MathML Presentation",
//            "application/mathml+xml" (UTF-8)          "public.mathml"
//   html     "HTML Format" (CF_HTML envelope)          public.html
//   png      "PNG"                                     public.png

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Formats {
    text: Option<String>,
    mathml: Option<String>,
    html: Option<String>,
    png_base64: Option<String>,
}

/// The decoded, validated payload, independent of the platform.
struct Payload {
    text: Option<String>,
    mathml: Option<String>,
    html: Option<String>,
    png: Option<Vec<u8>>,
}

const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MATHML_TYPES: [&str; 2] = ["MathML", "MathML Presentation"];

impl Payload {
    fn from_formats(formats: Formats) -> Result<Self, String> {
        let png = match formats.png_base64 {
            Some(data) => Some(STANDARD.decode(data).map_err(|e| format!("Invalid PNG data: {e}"))?),
            None => None,
        };
        let payload = Payload { text: formats.text, mathml: formats.mathml, html: formats.html, png };
        let total = payload.text.as_ref().map_or(0, String::len)
            + payload.mathml.as_ref().map_or(0, String::len)
            + payload.html.as_ref().map_or(0, String::len)
            + payload.png.as_ref().map_or(0, Vec::len);
        if total == 0 {
            return Err("Nothing to copy".into());
        }
        if total > MAX_PAYLOAD_BYTES {
            return Err("Clipboard payload is too large".into());
        }
        Ok(payload)
    }
}

/// Wrap an HTML fragment in the Windows CF_HTML envelope with byte offsets.
#[cfg_attr(not(windows), allow(dead_code))]
fn cf_html(fragment: &str) -> Vec<u8> {
    const HEADER: &str = "Version:0.9\r\nStartHTML:{SH}\r\nEndHTML:{EH}\r\nStartFragment:{SF}\r\nEndFragment:{EF}\r\n";
    let prefix = "<html><body>\r\n<!--StartFragment-->";
    let suffix = "<!--EndFragment-->\r\n</body>\r\n</html>";
    let header_len = HEADER.replace("{SH}", "0000000000").replace("{EH}", "0000000000").replace("{SF}", "0000000000").replace("{EF}", "0000000000").len();
    let start_html = header_len;
    let start_fragment = start_html + prefix.len();
    let end_fragment = start_fragment + fragment.len();
    let end_html = end_fragment + suffix.len();
    let header = HEADER
        .replace("{SH}", &format!("{start_html:010}"))
        .replace("{EH}", &format!("{end_html:010}"))
        .replace("{SF}", &format!("{start_fragment:010}"))
        .replace("{EF}", &format!("{end_fragment:010}"));
    format!("{header}{prefix}{fragment}{suffix}").into_bytes()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn nul_terminated_utf8(text: &str) -> Vec<u8> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    bytes
}

#[cfg_attr(not(windows), allow(dead_code))]
fn utf16_nul_terminated(text: &str) -> Vec<u8> {
    text.encode_utf16().chain(std::iter::once(0)).flat_map(|unit| unit.to_le_bytes()).collect()
}

#[cfg(windows)]
mod platform {
    use super::{cf_html, nul_terminated_utf8, utf16_nul_terminated, Payload, MATHML_TYPES};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_UNICODETEXT: u32 = 13;

    struct Clipboard;

    impl Clipboard {
        fn open() -> Result<Self, String> {
            // Another application may hold the clipboard briefly; retry.
            for _ in 0..20 {
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    if unsafe { EmptyClipboard() } == 0 {
                        unsafe { CloseClipboard() };
                        return Err("Could not empty the clipboard".into());
                    }
                    return Ok(Clipboard);
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err("The clipboard is in use by another application".into())
        }

        fn put(&self, format: u32, bytes: &[u8]) -> Result<(), String> {
            unsafe {
                let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
                if handle.is_null() {
                    return Err("Out of memory for clipboard data".into());
                }
                let target = GlobalLock(handle) as *mut u8;
                if target.is_null() {
                    GlobalFree(handle);
                    return Err("Could not lock clipboard memory".into());
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
                GlobalUnlock(handle);
                // On success the clipboard owns the memory.
                if SetClipboardData(format, handle as *mut c_void).is_null() {
                    GlobalFree(handle);
                    return Err(format!("SetClipboardData failed for format {format}"));
                }
            }
            Ok(())
        }
    }

    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    fn register(name: &str) -> Result<u32, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        match unsafe { RegisterClipboardFormatW(wide.as_ptr()) } {
            0 => Err(format!("Could not register clipboard format {name}")),
            id => Ok(id),
        }
    }

    pub fn write(payload: &Payload) -> Result<(), String> {
        let clipboard = Clipboard::open()?;
        if let Some(mathml) = &payload.mathml {
            let bytes = nul_terminated_utf8(mathml);
            for name in MATHML_TYPES.into_iter().chain(["application/mathml+xml"]) {
                clipboard.put(register(name)?, &bytes)?;
            }
        }
        if let Some(html) = &payload.html {
            clipboard.put(register("HTML Format")?, &cf_html(html))?;
        }
        if let Some(png) = &payload.png {
            clipboard.put(register("PNG")?, png)?;
        }
        if let Some(text) = &payload.text {
            clipboard.put(CF_UNICODETEXT, &utf16_nul_terminated(text))?;
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Payload, MATHML_TYPES};
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSData, NSString};

    #[allow(unused_unsafe)]
    pub fn write(payload: &Payload) -> Result<(), String> {
        let board = unsafe { NSPasteboard::generalPasteboard() };
        unsafe { board.clearContents() };
        let put_string = |kind: &str, value: &str| -> Result<(), String> {
            let stored = unsafe { board.setString_forType(&NSString::from_str(value), &NSString::from_str(kind)) };
            if stored { Ok(()) } else { Err(format!("Could not put {kind} on the pasteboard")) }
        };
        if let Some(mathml) = &payload.mathml {
            for kind in MATHML_TYPES.into_iter().chain(["public.mathml"]) {
                put_string(kind, mathml)?;
            }
        }
        if let Some(html) = &payload.html {
            put_string("public.html", html)?;
        }
        if let Some(png) = &payload.png {
            let data = NSData::with_bytes(png);
            let stored = unsafe { board.setData_forType(Some(&data), &NSString::from_str("public.png")) };
            if !stored {
                return Err("Could not put the image on the pasteboard".into());
            }
        }
        if let Some(text) = &payload.text {
            put_string("public.utf8-plain-text", text)?;
        }
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::Payload;

    pub fn write(_payload: &Payload) -> Result<(), String> {
        Err("Native clipboard formats are implemented for Windows and macOS only".into())
    }
}

#[tauri::command]
pub fn copy_equation(formats: Formats) -> Result<(), String> {
    platform::write(&Payload::from_formats(formats)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cf_html_offsets_point_at_the_fragment() {
        let bytes = cf_html("<b>x</b>");
        let text = String::from_utf8(bytes.clone()).unwrap();
        let field = |name: &str| -> usize {
            let start = text.find(name).unwrap() + name.len();
            text[start..start + 10].parse().unwrap()
        };
        assert_eq!(&text[field("StartFragment:")..field("EndFragment:")], "<b>x</b>");
        assert_eq!(field("EndHTML:"), bytes.len());
        assert!(text[field("StartHTML:")..].starts_with("<html>"));
    }

    #[test]
    fn utf16_text_is_nul_terminated() {
        assert_eq!(utf16_nul_terminated("a"), vec![b'a', 0, 0, 0]);
    }

    #[test]
    fn payload_validation_rejects_empty_and_bad_png() {
        let empty = Formats { text: None, mathml: None, html: None, png_base64: None };
        assert_eq!(Payload::from_formats(empty).err().unwrap(), "Nothing to copy");
        let bad = Formats { text: None, mathml: None, html: None, png_base64: Some("***".into()) };
        assert!(Payload::from_formats(bad).err().unwrap().starts_with("Invalid PNG data"));
    }
}
