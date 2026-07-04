//! Known Hosts store — TOFU host-key pinning (replaces the old accept-all).
//!
//! Each entry pins a host:port to the SHA256 fingerprint of the server key we
//! trusted. On connect, `ssh.rs` looks the entry up and compares; an unknown or
//! changed key is surfaced to the UI (via a structured error) so the user can
//! accept/update it. Fingerprints are not secret, so this lives in a plain
//! `tauri-plugin-store` JSON file (no keyring needed).

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "known_hosts.json";
const STORE_KEY: &str = "items";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    /// Key algorithm, e.g. "ssh-ed25519".
    pub key_type: String,
    /// SHA256 fingerprint string, e.g. "SHA256:abc…".
    pub fingerprint: String,
    pub added_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_items<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<KnownHost>, String> {
    crate::store_util::load_list(app, STORE_FILE, STORE_KEY)
}

fn save_items<R: Runtime>(app: &AppHandle<R>, items: &[KnownHost]) -> Result<(), String> {
    crate::store_util::backup_if_corrupt(app, STORE_FILE, STORE_KEY);
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(items).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Look up the pinned entry for a host:port (used by the SSH layer at connect).
pub fn find<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    port: u16,
) -> Result<Option<KnownHost>, String> {
    Ok(load_items(app)?
        .into_iter()
        .find(|k| k.host == host && k.port == port))
}

// ---- commands ------------------------------------------------------------

#[tauri::command]
pub fn list_known_hosts<R: Runtime>(app: AppHandle<R>) -> Result<Vec<KnownHost>, String> {
    let mut items = load_items(&app)?;
    items.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
    Ok(items)
}

/// Pin (or re-pin) a host:port to a fingerprint. Replaces any existing entry for
/// the same host:port — used both for first-trust and for "update" after a change.
#[tauri::command]
pub fn known_host_save<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
) -> Result<KnownHost, String> {
    let entry = KnownHost {
        host: host.trim().to_string(),
        port,
        key_type,
        fingerprint,
        added_at: now_ms(),
    };
    let mut items = load_items(&app)?;
    items.retain(|k| !(k.host == entry.host && k.port == entry.port));
    items.push(entry.clone());
    save_items(&app, &items)?;
    Ok(entry)
}

#[tauri::command]
pub fn known_host_delete<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    port: u16,
) -> Result<(), String> {
    let mut items = load_items(&app)?;
    items.retain(|k| !(k.host == host.trim() && k.port == port));
    save_items(&app, &items)
}
