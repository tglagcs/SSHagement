//! Explicit folder structure (groups + subgroups) so empty folders can exist
//! before any connection is placed in them — Obsidian/Explorer style.
//!
//! Connections still carry their own `group`/`subgroup` names; the sidebar tree
//! is the union of these explicit folders and the folders implied by
//! connections. Renames/deletes here are mirrored on connections by the
//! frontend (via the existing `rename_group`/`rename_subgroup` commands).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "folders.json";
const STORE_KEY: &str = "items";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub name: String,
    #[serde(default)]
    pub subgroups: Vec<String>,
}

/// Merge same-named folders and de-duplicate subgroups (keeps order).
fn normalize(items: Vec<Folder>) -> Vec<Folder> {
    let mut out: Vec<Folder> = Vec::new();
    for f in items {
        if f.name.trim().is_empty() {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|x| x.name == f.name) {
            for s in f.subgroups {
                if !s.trim().is_empty() && !existing.subgroups.contains(&s) {
                    existing.subgroups.push(s);
                }
            }
        } else {
            let mut subs: Vec<String> = Vec::new();
            for s in f.subgroups {
                if !s.trim().is_empty() && !subs.contains(&s) {
                    subs.push(s);
                }
            }
            out.push(Folder { name: f.name, subgroups: subs });
        }
    }
    out
}

fn load_items<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Folder>, String> {
    crate::store_util::load_list(app, STORE_FILE, STORE_KEY)
}

fn save_items<R: Runtime>(app: &AppHandle<R>, items: Vec<Folder>) -> Result<Vec<Folder>, String> {
    let items = normalize(items);
    crate::store_util::backup_if_corrupt(app, STORE_FILE, STORE_KEY);
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(STORE_KEY, serde_json::to_value(&items).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(items)
}

#[tauri::command]
pub fn list_folders<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Folder>, String> {
    load_items(&app)
}

#[tauri::command]
pub fn folder_create_group<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<Vec<Folder>, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Group name is required".into());
    }
    let mut items = load_items(&app)?;
    if !items.iter().any(|f| f.name == n) {
        items.push(Folder { name: n.to_string(), subgroups: Vec::new() });
    }
    save_items(&app, items)
}

#[tauri::command]
pub fn folder_create_subgroup<R: Runtime>(
    app: AppHandle<R>,
    group: String,
    name: String,
) -> Result<Vec<Folder>, String> {
    let g = group.trim();
    let n = name.trim();
    if g.is_empty() || n.is_empty() {
        return Err("Group and subgroup name are required".into());
    }
    let mut items = load_items(&app)?;
    match items.iter_mut().find(|f| f.name == g) {
        Some(f) => {
            if !f.subgroups.iter().any(|s| s == n) {
                f.subgroups.push(n.to_string());
            }
        }
        None => items.push(Folder { name: g.to_string(), subgroups: vec![n.to_string()] }),
    }
    save_items(&app, items)
}

#[tauri::command]
pub fn folder_rename_group<R: Runtime>(
    app: AppHandle<R>,
    old_name: String,
    new_name: String,
) -> Result<Vec<Folder>, String> {
    let old = old_name.trim();
    let new = new_name.trim();
    let mut items = load_items(&app)?;
    if !new.is_empty() {
        if let Some(f) = items.iter_mut().find(|f| f.name == old) {
            f.name = new.to_string();
        }
    }
    save_items(&app, items) // normalize() merges if `new` already existed
}

#[tauri::command]
pub fn folder_rename_subgroup<R: Runtime>(
    app: AppHandle<R>,
    group: String,
    old_name: String,
    new_name: String,
) -> Result<Vec<Folder>, String> {
    let g = group.trim();
    let old = old_name.trim();
    let new = new_name.trim();
    let mut items = load_items(&app)?;
    if !new.is_empty() {
        if let Some(f) = items.iter_mut().find(|f| f.name == g) {
            for s in f.subgroups.iter_mut() {
                if s == old {
                    *s = new.to_string();
                }
            }
        }
    }
    save_items(&app, items)
}

#[tauri::command]
pub fn folder_delete_group<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<Vec<Folder>, String> {
    let n = name.trim();
    let mut items = load_items(&app)?;
    items.retain(|f| f.name != n);
    save_items(&app, items)
}

#[tauri::command]
pub fn folder_delete_subgroup<R: Runtime>(
    app: AppHandle<R>,
    group: String,
    name: String,
) -> Result<Vec<Folder>, String> {
    let g = group.trim();
    let n = name.trim();
    let mut items = load_items(&app)?;
    if let Some(f) = items.iter_mut().find(|f| f.name == g) {
        f.subgroups.retain(|s| s != n);
    }
    save_items(&app, items)
}
