mod connections;
mod folders;
mod fsio;
mod known_hosts;
mod snippet_folders;
mod snippets;
mod ssh;
mod store_util;

use std::sync::atomic::{AtomicU32, Ordering};

/// Monotonic counter for unique secondary-window labels (`win-2`, `win-3`, …).
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

/// Disable WebView2 browser accelerator keys (F12, Ctrl+R, Ctrl+Shift+C/I/J,
/// Ctrl +/-, …) so those chords reach the terminal instead of the webview.
/// Clipboard keys (Ctrl+C/V) are unaffected. Applied to every window we open —
/// the main one at startup and each `new_window`.
#[cfg(windows)]
fn disable_browser_accelerators(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        unsafe {
            let controller = webview.controller();
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                        let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                }
            }
        }
    });
}

/// Enable/disable WebView2 general form autofill (the suggestion dropdowns that
/// appear under text fields). Applied per window; the frontend re-applies the
/// persisted preference on every window's mount.
#[cfg(windows)]
fn set_general_autofill(window: &tauri::WebviewWindow, enabled: bool) {
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
        use windows_core::Interface;
        unsafe {
            let controller = webview.controller();
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                        let _ = s4.SetIsGeneralAutofillEnabled(enabled);
                    }
                }
            }
        }
    });
}

/// Wipe the stored general-autofill history for a window's WebView2 profile.
#[cfg(windows)]
fn clear_general_autofill(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2ClearBrowsingDataCompletedHandler, ICoreWebView2Profile2,
            ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL,
        };
        use windows_core::Interface;
        unsafe {
            let controller = webview.controller();
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
                    if let Ok(profile) = core13.Profile() {
                        if let Ok(profile2) = profile.cast::<ICoreWebView2Profile2>() {
                            let _ = profile2.ClearBrowsingData(
                                COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL,
                                None::<&ICoreWebView2ClearBrowsingDataCompletedHandler>,
                            );
                        }
                    }
                }
            }
        }
    });
}

/// Toggle form autofill across all open windows (async so it runs off the main
/// thread — `with_webview` dispatches back to it).
#[tauri::command]
async fn set_form_autofill(_app: tauri::AppHandle, _enabled: bool) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        for (_, w) in _app.webview_windows() {
            set_general_autofill(&w, _enabled);
        }
    }
}

/// Clear stored form-autofill history across all open windows.
#[tauri::command]
async fn clear_form_autofill(_app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        for (_, w) in _app.webview_windows() {
            clear_general_autofill(&w);
        }
    }
}

/// Open a new, fully independent app window (Ctrl+Shift+N). Each window loads a
/// fresh copy of the SPA, so it gets its own tabs/panes/SSH sessions — ideal for
/// spreading servers across monitors. It mirrors the main window's chrome and,
/// crucially, re-applies the WebView2 accelerator-key fix so the terminal keeps
/// receiving chords like Ctrl+R.
#[tauri::command]
async fn new_window(
    app: tauri::AppHandle,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    use tauri::Manager;

    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("win-{n}");

    // Mirror whatever URL the main window actually loaded, so dev (Vite server
    // at "/") and prod (tauri://) both resolve — hardcoding "index.html" loads
    // a blank page under the SvelteKit dev server.
    let url = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(tauri::WebviewUrl::External)
        .unwrap_or_else(|| tauri::WebviewUrl::App("index.html".into()));

    let window = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title("SSHagement")
            .inner_size(1200.0, 760.0)
            .min_inner_size(880.0, 560.0)
            .decorations(false)
            .theme(Some(tauri::Theme::Dark))
            .background_color(tauri::webview::Color(11, 13, 16, 255))
            .disable_drag_drop_handler()
            .build()
            .map_err(|e| e.to_string())?;

    // Tear-off drop point (physical px): place the window so its tab strip lands
    // roughly under the cursor rather than covering it. Undo any maximized state
    // the window-state plugin may have restored for this label first, or the
    // reposition would be a no-op.
    if let (Some(x), Some(y)) = (x, y) {
        let _ = window.unmaximize();
        let px = (x - 160.0).max(0.0) as i32;
        let py = (y - 12.0).max(0.0) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(px, py));
    }

    #[cfg(windows)]
    disable_browser_accelerators(&window);
    let _ = &window;

    Ok(label)
}

/// Which app window (if any) currently sits under the mouse cursor, plus the
/// cursor's physical-pixel position. Used to resolve a tab drag-and-drop: hit
/// another window → move there; hit none → tear off into a new window.
#[derive(serde::Serialize)]
struct CursorHit {
    label: Option<String>,
    x: f64,
    y: f64,
}

#[tauri::command]
fn window_at_cursor(app: tauri::AppHandle) -> Result<CursorHit, String> {
    use tauri::Manager;
    let p = app.cursor_position().map_err(|e| e.to_string())?;
    let (cx, cy) = (p.x as i32, p.y as i32);

    let mut hit = None;
    for (label, w) in app.webview_windows() {
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let inside = cx >= pos.x
                && cx < pos.x + size.width as i32
                && cy >= pos.y
                && cy < pos.y + size.height as i32;
            if inside {
                hit = Some(label);
                break;
            }
        }
    }

    Ok(CursorHit { label: hit, x: p.x, y: p.y })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Persist size/position/maximized per window label across restarts. Only
        // "main" is recreated on startup, so it's the one that visibly restores;
        // secondary windows' entries are harmless leftovers.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshState::default())
        .setup(|_app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(w) = _app.get_webview_window("main") {
                    disable_browser_accelerators(&w);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connections::list_connections,
            connections::save_connection,
            connections::rename_group,
            connections::rename_subgroup,
            connections::delete_connection,
            folders::list_folders,
            folders::folder_create_group,
            folders::folder_create_subgroup,
            folders::folder_rename_group,
            folders::folder_rename_subgroup,
            folders::folder_delete_group,
            folders::folder_delete_subgroup,
            connections::set_connection_password,
            connections::clear_connection_password,
            connections::set_key_passphrase,
            connections::clear_key_passphrase,
            connections::set_proxy_password,
            connections::clear_proxy_password,
            snippets::list_snippets,
            snippets::save_snippet,
            snippets::delete_snippet,
            snippets::snippet_rename_group,
            snippets::snippet_rename_subgroup,
            snippet_folders::list_snippet_folders,
            snippet_folders::snippet_folder_create_group,
            snippet_folders::snippet_folder_create_subgroup,
            snippet_folders::snippet_folder_rename_group,
            snippet_folders::snippet_folder_rename_subgroup,
            snippet_folders::snippet_folder_delete_group,
            snippet_folders::snippet_folder_delete_subgroup,
            known_hosts::list_known_hosts,
            known_hosts::known_host_save,
            known_hosts::known_host_delete,
            fsio::write_text_file,
            fsio::read_text_file,
            fsio::read_ssh_config,
            new_window,
            window_at_cursor,
            set_form_autofill,
            clear_form_autofill,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::ssh_detach,
            ssh::ssh_reattach,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
