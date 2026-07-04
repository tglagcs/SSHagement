//! Corruption-tolerant persistence shared by the `tauri-plugin-store` JSON files.
//!
//! The plugin swallows parse errors on load (it returns an empty store), which
//! makes a corrupt file look like "no data" and lets a later save silently
//! clobber recoverable data. These helpers read the raw file so we can:
//!   1. surface a real load error to the UI instead of showing an empty list,
//!   2. skip individual bad records rather than losing the whole list,
//!   3. move a corrupt file aside before overwriting it.

use serde::de::DeserializeOwned;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::resolve_store_path;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Load a store file's item list, tolerant of individual bad records.
///
/// - Missing/empty file, or the key absent → empty list (normal for a new user).
/// - Unparseable JSON or wrong shape → `Err` (surfaced to the UI; the file stays
///   on disk and is backed up on the next save via [`backup_if_corrupt`]).
/// - Valid array with some bad elements → the good ones (bad records skipped).
pub fn load_list<R, T>(app: &AppHandle<R>, file: &str, key: &str) -> Result<Vec<T>, String>
where
    R: Runtime,
    T: DeserializeOwned,
{
    let path = resolve_store_path(app, file).map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {file}: {e}"))?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Vec::new());
    }
    let root: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
        format!("{file} is corrupt and couldn't be read ({e}). It will be backed up before any changes.")
    })?;
    match root.get(key) {
        None => Ok(Vec::new()),
        Some(serde_json::Value::Array(arr)) => {
            // Tolerant: keep every record that still matches the schema, drop the
            // rest — one bad row shouldn't wipe the whole list.
            let mut items = Vec::with_capacity(arr.len());
            for v in arr {
                if let Ok(item) = serde_json::from_value::<T>(v.clone()) {
                    items.push(item);
                }
            }
            Ok(items)
        }
        Some(_) => Err(format!(
            "{file} is corrupt (unexpected format). It will be backed up before any changes."
        )),
    }
}

/// The on-disk path if the store file exists but can't be cleanly parsed
/// (invalid JSON, or the key isn't an array); `None` when it's fine or absent.
fn corrupt_path<R: Runtime>(app: &AppHandle<R>, file: &str, key: &str) -> Option<PathBuf> {
    let path = resolve_store_path(app, file).ok()?;
    if !path.exists() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    let ok = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .map(|v| matches!(v.get(key), Some(serde_json::Value::Array(_)) | None))
        .unwrap_or(false);
    if ok {
        None
    } else {
        Some(path)
    }
}

/// Before overwriting a store file, move a corrupt one aside (→
/// `<name>.corrupt-<unixtime>.json`) so recoverable data isn't silently lost.
/// No-op when the file is fine or absent. Call this at the top of every save.
pub fn backup_if_corrupt<R: Runtime>(app: &AppHandle<R>, file: &str, key: &str) {
    if let Some(path) = corrupt_path(app, file, key) {
        let backup = path.with_extension(format!("corrupt-{}.json", now_secs()));
        let _ = std::fs::rename(&path, &backup);
    }
}
