//! Connection records (CRUD) + secret storage.
//!
//! Non-secret metadata is persisted via `tauri-plugin-store` in `connections.json`
//! (under the app config dir). Secrets (passwords) live in the OS credential
//! store via the `keyring` crate — never written to disk in plaintext.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "connections.json";
const STORE_KEY: &str = "items";
const KEYRING_SERVICE: &str = "SSHagement";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
    Key,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    /// "socks5" | "http"
    pub kind: String,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default)]
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subgroup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub startup_snippets: Vec<String>,
    /// Whether a password is stored in the OS keyring for this connection.
    #[serde(default)]
    pub has_password: bool,
    /// Whether a private-key passphrase is stored in the OS keyring.
    #[serde(default)]
    pub key_has_passphrase: bool,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

/// Editable payload coming from the UI. `id` absent => create, present => update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertConnection {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub subgroup: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub startup_snippets: Vec<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- persistence helpers -------------------------------------------------

fn load_items<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Connection>, String> {
    crate::store_util::load_list(app, STORE_FILE, STORE_KEY)
}

fn save_items<R: Runtime>(app: &AppHandle<R>, items: &[Connection]) -> Result<(), String> {
    // Move a corrupt file aside before we overwrite it, so recoverable data isn't lost.
    crate::store_util::backup_if_corrupt(app, STORE_FILE, STORE_KEY);
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let value = serde_json::to_value(items).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Fetch a single connection by id (used by the SSH layer).
pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<Connection>, String> {
    Ok(load_items(app)?.into_iter().find(|c| c.id == id))
}

/// Mark a connection as just used (updates `lastUsedAt`).
pub fn touch<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let mut items = load_items(app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.last_used_at = Some(now_ms());
        save_items(app, &items)?;
    }
    Ok(())
}

// ---- keyring helpers -----------------------------------------------------

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("conn:{id}")).map_err(|e| e.to_string())
}

fn proxy_keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("proxy:{id}")).map_err(|e| e.to_string())
}

fn key_pass_keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("keypass:{id}")).map_err(|e| e.to_string())
}

/// Read a stored password (used internally at connect time, Step 3). `None` if not set.
#[allow(dead_code)]
pub fn read_password(id: &str) -> Result<Option<String>, String> {
    match keyring_entry(id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Read a stored proxy password (used once proxying is wired in). `None` if not set.
#[allow(dead_code)]
pub fn read_proxy_password(id: &str) -> Result<Option<String>, String> {
    match proxy_keyring_entry(id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Read a stored private-key passphrase (used at connect time). `None` if not set.
pub fn read_key_passphrase(id: &str) -> Result<Option<String>, String> {
    match key_pass_keyring_entry(id)?.get_password() {
        Ok(p) if p.is_empty() => Ok(None),
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_password(id: &str) -> Result<(), String> {
    match keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_proxy_password(id: &str) -> Result<(), String> {
    match proxy_keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_key_passphrase(id: &str) -> Result<(), String> {
    match key_pass_keyring_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- commands ------------------------------------------------------------

#[tauri::command]
pub fn list_connections<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Connection>, String> {
    load_items(&app)
}

/// Create (no `id`) or update (`id` present) a connection. Returns the saved record.
#[tauri::command]
pub fn save_connection<R: Runtime>(
    app: AppHandle<R>,
    conn: UpsertConnection,
) -> Result<Connection, String> {
    let mut items = load_items(&app)?;

    let saved = if let Some(id) = conn.id.clone() {
        let existing = items
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("Connection '{id}' not found"))?;
        existing.name = conn.name;
        existing.host = conn.host;
        existing.port = conn.port;
        existing.username = conn.username;
        existing.auth_method = conn.auth_method;
        existing.key_path = conn.key_path;
        existing.tags = conn.tags;
        existing.group = conn.group;
        existing.subgroup = conn.subgroup;
        existing.proxy = conn.proxy;
        existing.startup_snippets = conn.startup_snippets;
        existing.clone()
    } else {
        let created = Connection {
            id: uuid::Uuid::new_v4().to_string(),
            name: conn.name,
            host: conn.host,
            port: conn.port,
            username: conn.username,
            auth_method: conn.auth_method,
            key_path: conn.key_path,
            tags: conn.tags,
            group: conn.group,
            subgroup: conn.subgroup,
            proxy: conn.proxy,
            startup_snippets: conn.startup_snippets,
            has_password: false,
            key_has_passphrase: false,
            created_at: now_ms(),
            last_used_at: None,
        };
        items.push(created.clone());
        created
    };

    save_items(&app, &items)?;
    Ok(saved)
}

/// Rename a group across every connection that belongs to it. An empty `new_name`
/// moves those connections to "Ungrouped" (clears their group). Returns affected count.
#[tauri::command]
pub fn rename_group<R: Runtime>(
    app: AppHandle<R>,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let old = old_name.trim();
    let new = new_name.trim();
    let new_group = if new.is_empty() {
        None
    } else {
        Some(new.to_string())
    };

    let mut items = load_items(&app)?;
    let mut count = 0;
    for c in items.iter_mut() {
        if c.group.as_deref().map(str::trim) == Some(old) {
            c.group = new_group.clone();
            // A subgroup can't exist without a group.
            if new_group.is_none() {
                c.subgroup = None;
            }
            count += 1;
        }
    }
    if count > 0 {
        save_items(&app, &items)?;
    }
    Ok(count)
}

/// Rename a subgroup within a given group across every matching connection. An
/// empty `new_name` clears the subgroup (moves those hosts directly under the
/// group). Returns the affected count.
#[tauri::command]
pub fn rename_subgroup<R: Runtime>(
    app: AppHandle<R>,
    group: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let grp = group.trim();
    let old = old_name.trim();
    let new = new_name.trim();
    let new_sub = if new.is_empty() {
        None
    } else {
        Some(new.to_string())
    };

    let mut items = load_items(&app)?;
    let mut count = 0;
    for c in items.iter_mut() {
        if c.group.as_deref().map(str::trim) == Some(grp)
            && c.subgroup.as_deref().map(str::trim) == Some(old)
        {
            c.subgroup = new_sub.clone();
            count += 1;
        }
    }
    if count > 0 {
        save_items(&app, &items)?;
    }
    Ok(count)
}

#[tauri::command]
pub fn delete_connection<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let mut items = load_items(&app)?;
    items.retain(|c| c.id != id);
    save_items(&app, &items)?;
    // Best-effort secret cleanup.
    let _ = delete_password(&id);
    let _ = delete_proxy_password(&id);
    let _ = delete_key_passphrase(&id);
    Ok(())
}

#[tauri::command]
pub fn set_connection_password<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    password: String,
) -> Result<(), String> {
    keyring_entry(&id)?
        .set_password(&password)
        .map_err(|e| e.to_string())?;
    // Reflect presence in the record.
    let mut items = load_items(&app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.has_password = true;
        save_items(&app, &items)?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_connection_password<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    delete_password(&id)?;
    let mut items = load_items(&app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.has_password = false;
        save_items(&app, &items)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_key_passphrase<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    passphrase: String,
) -> Result<(), String> {
    key_pass_keyring_entry(&id)?
        .set_password(&passphrase)
        .map_err(|e| e.to_string())?;
    let mut items = load_items(&app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.key_has_passphrase = true;
        save_items(&app, &items)?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_key_passphrase<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    delete_key_passphrase(&id)?;
    let mut items = load_items(&app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        c.key_has_passphrase = false;
        save_items(&app, &items)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_proxy_password<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    password: String,
) -> Result<(), String> {
    proxy_keyring_entry(&id)?
        .set_password(&password)
        .map_err(|e| e.to_string())?;
    let mut items = load_items(&app)?;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        if let Some(p) = c.proxy.as_mut() {
            p.has_password = true;
            save_items(&app, &items)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_proxy_password<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    delete_proxy_password(&id)?;
    let mut items = load_items(&app)?;
    let mut changed = false;
    if let Some(c) = items.iter_mut().find(|c| c.id == id) {
        if let Some(p) = c.proxy.as_mut() {
            if p.has_password {
                p.has_password = false;
                changed = true;
            }
        }
    }
    if changed {
        save_items(&app, &items)?;
    }
    Ok(())
}
