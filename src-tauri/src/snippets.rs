//! Snippets — saved commands/scripts (global). Non-secret, persisted via
//! `tauri-plugin-store` in `snippets.json`.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "snippets.json";
const STORE_KEY: &str = "items";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    /// Group / folder this snippet belongs to (Obsidian-style, like connections).
    #[serde(default)]
    pub group: Option<String>,
    /// Optional nested folder inside `group` (ignored when `group` is empty).
    #[serde(default)]
    pub subgroup: Option<String>,
    pub created_at: i64,
}

/// Editable payload from the UI. `id` absent => create, present => update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSnippet {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub subgroup: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_items<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Snippet>, String> {
    crate::store_util::load_list(app, STORE_FILE, STORE_KEY)
}

fn save_items<R: Runtime>(app: &AppHandle<R>, items: &[Snippet]) -> Result<(), String> {
    crate::store_util::backup_if_corrupt(app, STORE_FILE, STORE_KEY);
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(items).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_snippets<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Snippet>, String> {
    load_items(&app)
}

#[tauri::command]
pub fn save_snippet<R: Runtime>(
    app: AppHandle<R>,
    snippet: UpsertSnippet,
) -> Result<Snippet, String> {
    let mut items = load_items(&app)?;

    let saved = if let Some(id) = snippet.id.clone() {
        let existing = items
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("Snippet '{id}' not found"))?;
        existing.name = snippet.name;
        existing.command = snippet.command;
        existing.group = snippet.group;
        existing.subgroup = snippet.subgroup;
        existing.clone()
    } else {
        let created = Snippet {
            id: uuid::Uuid::new_v4().to_string(),
            name: snippet.name,
            command: snippet.command,
            group: snippet.group,
            subgroup: snippet.subgroup,
            created_at: now_ms(),
        };
        items.push(created.clone());
        created
    };

    save_items(&app, &items)?;
    Ok(saved)
}

#[tauri::command]
pub fn delete_snippet<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let mut items = load_items(&app)?;
    items.retain(|s| s.id != id);
    save_items(&app, &items)?;
    Ok(())
}

/// Rename a group across every matching snippet. Empty `new_name` clears the
/// group (moves those snippets to Ungrouped). Returns the affected count.
#[tauri::command]
pub fn snippet_rename_group<R: Runtime>(
    app: AppHandle<R>,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let old = old_name.trim();
    let new = new_name.trim();
    let new_group = if new.is_empty() { None } else { Some(new.to_string()) };

    let mut items = load_items(&app)?;
    let mut count = 0;
    for s in items.iter_mut() {
        if s.group.as_deref().map(str::trim) == Some(old) {
            s.group = new_group.clone();
            // A subgroup can't exist without a group.
            if new_group.is_none() {
                s.subgroup = None;
            }
            count += 1;
        }
    }
    if count > 0 {
        save_items(&app, &items)?;
    }
    Ok(count)
}

/// Rename a subgroup within a given group across every matching snippet. An
/// empty `new_name` clears the subgroup. Returns the affected count.
#[tauri::command]
pub fn snippet_rename_subgroup<R: Runtime>(
    app: AppHandle<R>,
    group: String,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let grp = group.trim();
    let old = old_name.trim();
    let new = new_name.trim();
    let new_sub = if new.is_empty() { None } else { Some(new.to_string()) };

    let mut items = load_items(&app)?;
    let mut count = 0;
    for s in items.iter_mut() {
        if s.group.as_deref().map(str::trim) == Some(grp)
            && s.subgroup.as_deref().map(str::trim) == Some(old)
        {
            s.subgroup = new_sub.clone();
            count += 1;
        }
    }
    if count > 0 {
        save_items(&app, &items)?;
    }
    Ok(count)
}
