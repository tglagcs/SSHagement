//! Minimal file read/write for config backup. The path is chosen by the user
//! via the native dialog (frontend), so we just honor it here instead of
//! pulling in the broad `tauri-plugin-fs` capability surface.

use std::fs;

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Raw contents of `~/.ssh/config` plus the resolved home dir (so the frontend
/// can expand `~` in `IdentityFile` paths). Errs if there's no config file.
#[derive(serde::Serialize)]
pub struct SshConfigData {
    pub home: String,
    pub content: String,
}

#[tauri::command]
pub fn read_ssh_config() -> Result<SshConfigData, String> {
    let home = home_dir().ok_or("Could not determine your home directory")?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Err(format!("No SSH config found at {}", path.display()));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(SshConfigData {
        home: home.to_string_lossy().to_string(),
        content,
    })
}
