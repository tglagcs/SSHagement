//! SSH session bridge: russh (PTY over a channel) <-> Tauri <-> xterm.
//!
//! Each session is driven by a single async task that owns the SSH channel and
//! multiplexes (via `tokio::select!`) between server output (forwarded to the
//! frontend through a Tauri `Channel`) and outgoing commands (write / resize /
//! close) received over an `mpsc` queue. The session id keys a registry so the
//! frontend can address an existing session.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_socks::tcp::Socks5Stream;

use crate::connections::{self, AuthMethod};
use crate::known_hosts::{self, KnownHost};

/// Outgoing commands sent to a session's driver task.
enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    /// Stop streaming to the current frontend channel and buffer output — used
    /// while a tab is being handed off to another window (moves live sessions
    /// without dropping them or losing PTY output).
    Detach,
    /// Resume streaming on a new channel, flushing anything buffered while detached.
    Reattach(Channel<SshEvent>),
    Close,
}

/// Events streamed to the frontend over the per-session Tauri channel.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SshEvent {
    /// PTY output, base64-encoded (the stream is raw bytes, not always UTF-8).
    Data { chunk: String },
    /// The session ended; `code` is the remote exit status if reported.
    Closed { code: Option<u32> },
}

#[derive(Default)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<SessionCmd>>>>,
}

/// Outcome of comparing the server's key against the Known Hosts store.
#[derive(Clone)]
enum HostKeyVerdict {
    /// Key matches the pinned fingerprint — connection allowed.
    Trusted,
    /// No entry for this host yet (first contact).
    Unknown { key_type: String, fingerprint: String },
    /// Entry exists but the fingerprint differs — possible MITM.
    Changed {
        key_type: String,
        fingerprint: String,
        old_fingerprint: String,
    },
}

/// Client handler enforcing Known Hosts (TOFU). It records its verdict in a
/// shared cell (the handler is consumed by `connect`, so the caller reads the
/// outcome back from here) and rejects unknown/changed keys — the caller turns
/// that into a structured error the UI can prompt on.
struct ClientHandler {
    expected: Option<KnownHost>,
    verdict: Arc<std::sync::Mutex<Option<HostKeyVerdict>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let key_type = server_public_key.algorithm().as_str().to_string();

        let verdict = match &self.expected {
            Some(known) if known.fingerprint == fingerprint => HostKeyVerdict::Trusted,
            Some(known) => HostKeyVerdict::Changed {
                key_type,
                fingerprint,
                old_fingerprint: known.fingerprint.clone(),
            },
            None => HostKeyVerdict::Unknown { key_type, fingerprint },
        };

        let trusted = matches!(verdict, HostKeyVerdict::Trusted);
        *self.verdict.lock().unwrap() = Some(verdict);
        Ok(trusted)
    }
}

/// Build the structured error string the frontend recognizes (prefix `HOSTKEY:`)
/// to drive the accept/update host-key dialog.
fn host_key_error(host: &str, port: u16, verdict: &HostKeyVerdict) -> String {
    let payload = match verdict {
        HostKeyVerdict::Unknown { key_type, fingerprint } => serde_json::json!({
            "kind": "unknown",
            "host": host,
            "port": port,
            "keyType": key_type,
            "fingerprint": fingerprint,
        }),
        HostKeyVerdict::Changed { key_type, fingerprint, old_fingerprint } => serde_json::json!({
            "kind": "changed",
            "host": host,
            "port": port,
            "keyType": key_type,
            "fingerprint": fingerprint,
            "oldFingerprint": old_fingerprint,
        }),
        HostKeyVerdict::Trusted => serde_json::json!({ "kind": "trusted" }),
    };
    format!("HOSTKEY:{payload}")
}

/// Structured error (prefix `KEYPASS:`) telling the UI to prompt for a private-key
/// passphrase. `wrong` is true when a passphrase was tried but didn't decrypt.
fn key_pass_error(key_path: &str, wrong: bool) -> String {
    let payload = serde_json::json!({
        "kind": "keyPassphrase",
        "keyPath": key_path,
        "wrong": wrong,
    });
    format!("KEYPASS:{payload}")
}

/// Open the raw TCP stream to the server, tunnelling through the configured
/// proxy (SOCKS5 / HTTP CONNECT) when present. Either way the result is a plain
/// `TcpStream`: after the proxy handshake the socket is a transparent tunnel to
/// the target, so russh can run the SSH handshake over it directly.
async fn open_proxied_stream(
    conn: &connections::Connection,
    conn_id: &str,
) -> Result<TcpStream, String> {
    let Some(p) = &conn.proxy else {
        return TcpStream::connect((conn.host.as_str(), conn.port))
            .await
            .map_err(|e| e.to_string());
    };

    let proxy_user = p.username.as_deref().filter(|u| !u.is_empty());
    let proxy_pass = if proxy_user.is_some() {
        connections::read_proxy_password(conn_id)?.unwrap_or_default()
    } else {
        String::new()
    };

    match p.kind.as_str() {
        "socks5" => {
            let proxy_addr = format!("{}:{}", p.host, p.port);
            let target = (conn.host.as_str(), conn.port);
            let stream = match proxy_user {
                Some(user) => Socks5Stream::connect_with_password(
                    proxy_addr.as_str(),
                    target,
                    user,
                    &proxy_pass,
                )
                .await
                .map_err(|e| format!("SOCKS5 proxy error: {e}"))?,
                None => Socks5Stream::connect(proxy_addr.as_str(), target)
                    .await
                    .map_err(|e| format!("SOCKS5 proxy error: {e}"))?,
            };
            // After negotiation the inner socket is a tunnel to the target.
            Ok(stream.into_inner())
        }
        "http" => {
            let mut tcp = TcpStream::connect((p.host.as_str(), p.port))
                .await
                .map_err(|e| format!("HTTP proxy unreachable: {e}"))?;

            let target = format!("{}:{}", conn.host, conn.port);
            let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
            if let Some(user) = proxy_user {
                let cred = base64::engine::general_purpose::STANDARD
                    .encode(format!("{user}:{proxy_pass}"));
                req.push_str(&format!("Proxy-Authorization: Basic {cred}\r\n"));
            }
            req.push_str("Proxy-Connection: keep-alive\r\n\r\n");
            tcp.write_all(req.as_bytes())
                .await
                .map_err(|e| e.to_string())?;

            // Read response headers up to the blank line.
            let mut buf: Vec<u8> = Vec::with_capacity(256);
            let mut byte = [0u8; 1];
            loop {
                let n = tcp.read(&mut byte).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("HTTP proxy closed the connection during CONNECT".into());
                }
                buf.push(byte[0]);
                if buf.ends_with(b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 8192 {
                    return Err("HTTP proxy sent an oversized response".into());
                }
            }

            let head = String::from_utf8_lossy(&buf);
            let status_line = head.lines().next().unwrap_or("");
            // Expect "HTTP/1.x 200 ...".
            let ok = status_line
                .split_whitespace()
                .nth(1)
                .map(|code| code == "200")
                .unwrap_or(false);
            if !ok {
                return Err(format!(
                    "HTTP proxy CONNECT rejected: {}",
                    status_line.trim()
                ));
            }
            Ok(tcp)
        }
        other => Err(format!("Unknown proxy kind '{other}'")),
    }
}

/// Try to authenticate via an SSH agent: offer each identity the agent holds and
/// let it sign the challenge. Returns Ok(true) on the first accepted key.
async fn try_agent_auth<R>(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    agent: &mut AgentClient<R>,
) -> Result<bool, String>
where
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent.request_identities().await.map_err(|e| e.to_string())?;
    if identities.is_empty() {
        return Ok(false);
    }
    for key in identities {
        match handle.authenticate_publickey_with(user, key, None, agent).await {
            Ok(res) if res.success() => return Ok(true),
            _ => continue, // key rejected or signing failed — try the next one
        }
    }
    Ok(false)
}

type SessionRegistry = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<SessionCmd>>>>;

/// Open an SSH session for a saved connection and start streaming its PTY.
#[tauri::command]
pub async fn ssh_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SshState>,
    connection_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
    key_passphrase: Option<String>,
) -> Result<String, String> {
    let conn = connections::get(&app, &connection_id)?.ok_or("Connection not found")?;

    let config = Arc::new(client::Config::default());
    let expected = known_hosts::find(&app, &conn.host, conn.port)?;
    let verdict_cell = Arc::new(std::sync::Mutex::new(None::<HostKeyVerdict>));
    let handler = ClientHandler {
        expected,
        verdict: verdict_cell.clone(),
    };

    // Open the transport (direct or via SOCKS5 / HTTP proxy), then run SSH over it.
    let stream = open_proxied_stream(&conn, &connection_id)
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;
    let _ = stream.set_nodelay(true);

    let mut handle = match client::connect_stream(config, stream, handler).await {
        Ok(h) => h,
        Err(e) => {
            // If the failure was our host-key check, surface a structured error
            // so the UI can prompt the user to accept (first contact) or update
            // (changed key) instead of showing a raw connection error.
            let verdict = verdict_cell.lock().unwrap().clone();
            return Err(match verdict {
                Some(v @ (HostKeyVerdict::Unknown { .. } | HostKeyVerdict::Changed { .. })) => {
                    host_key_error(&conn.host, conn.port, &v)
                }
                _ => format!("Connection failed: {e}"),
            });
        }
    };

    match conn.auth_method {
        AuthMethod::Password => {
            let pw = connections::read_password(&connection_id)?
                .ok_or("No password saved for this connection")?;
            let res = handle
                .authenticate_password(&conn.username, pw)
                .await
                .map_err(|e| e.to_string())?;
            if !res.success() {
                return Err("Authentication failed (wrong password?)".into());
            }
        }
        AuthMethod::Key => {
            let path = conn.key_path.clone().ok_or("No private key path configured")?;
            // Passphrase priority: the one just entered in the prompt, else the
            // one saved in the keyring (if any).
            let pass = match &key_passphrase {
                Some(p) if !p.is_empty() => Some(p.clone()),
                _ => connections::read_key_passphrase(&connection_id)?,
            };
            let key = match load_secret_key(&path, pass.as_deref()) {
                Ok(k) => k,
                Err(e) => {
                    let needs_pass = matches!(e, russh::keys::Error::KeyIsEncrypted);
                    // Encrypted (need a passphrase) or one was tried and failed →
                    // ask the UI to prompt instead of failing outright.
                    if needs_pass || pass.is_some() {
                        return Err(key_pass_error(&path, pass.is_some()));
                    }
                    return Err(format!("Failed to load key '{path}': {e}"));
                }
            };
            let res = handle
                .authenticate_publickey(
                    &conn.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| e.to_string())?;
            if !res.success() {
                return Err("Authentication failed (key rejected)".into());
            }
        }
        AuthMethod::Agent => {
            let user = conn.username.clone();
            let mut authed = false;
            let mut last_err = String::new();

            // 1) Windows OpenSSH agent over its named pipe.
            match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
                Ok(mut agent) => match try_agent_auth(&mut handle, &user, &mut agent).await {
                    Ok(true) => authed = true,
                    Ok(false) => last_err = "no identity offered by the OpenSSH agent was accepted (is your key added with `ssh-add`?)".into(),
                    Err(e) => last_err = e,
                },
                Err(e) => last_err = format!("OpenSSH agent unavailable: {e}"),
            }

            // 2) Fall back to Pageant (PuTTY) if the OpenSSH agent didn't work.
            if !authed {
                let mut agent = AgentClient::connect_pageant().await;
                if let Ok(true) = try_agent_auth(&mut handle, &user, &mut agent).await {
                    authed = true;
                }
            }

            if !authed {
                return Err(if last_err.is_empty() {
                    "SSH agent authentication failed (no running agent or no usable keys)".into()
                } else {
                    format!("SSH agent authentication failed: {last_err}")
                });
            }
        }
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::unbounded_channel::<SessionCmd>();
    state.sessions.lock().await.insert(session_id.clone(), tx);

    let _ = connections::touch(&app, &connection_id);

    let registry = state.sessions.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        run_session(handle, channel, rx, on_event, registry, sid).await;
    });

    Ok(session_id)
}

async fn run_session(
    _handle: Handle<ClientHandler>,
    mut channel: russh::Channel<client::Msg>,
    mut rx: mpsc::UnboundedReceiver<SessionCmd>,
    on_event: Channel<SshEvent>,
    registry: SessionRegistry,
    session_id: String,
) {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut exit_code: Option<u32> = None;

    // The frontend sink is swapped when a tab moves to another window. While
    // detached (no sink), PTY output is buffered and flushed on reattach so the
    // handoff loses nothing.
    let mut on_event: Option<Channel<SshEvent>> = Some(on_event);
    let mut backlog: Vec<u8> = Vec::new();

    let emit = |sink: &Option<Channel<SshEvent>>, backlog: &mut Vec<u8>, data: &[u8]| {
        match sink {
            Some(ch) => {
                let _ = ch.send(SshEvent::Data { chunk: b64.encode(data) });
            }
            None => backlog.extend_from_slice(data),
        }
    };

    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => emit(&on_event, &mut backlog, &data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => emit(&on_event, &mut backlog, &data),
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                match cmd {
                    Some(SessionCmd::Write(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() { break; }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                    }
                    Some(SessionCmd::Detach) => {
                        on_event = None;
                    }
                    Some(SessionCmd::Reattach(ch)) => {
                        if !backlog.is_empty() {
                            let _ = ch.send(SshEvent::Data { chunk: b64.encode(&backlog) });
                            backlog.clear();
                        }
                        on_event = Some(ch);
                    }
                    Some(SessionCmd::Close) | None => break,
                }
            }
        }
    }

    let _ = channel.close().await;
    registry.lock().await.remove(&session_id);
    if let Some(ch) = &on_event {
        let _ = ch.send(SshEvent::Closed { code: exit_code });
    }
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let tx = state.sessions.lock().await.get(&session_id).cloned();
    tx.ok_or("No such session")?
        .send(SessionCmd::Write(data.into_bytes()))
        .map_err(|_| "Session is closed".to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().await.get(&session_id) {
        let _ = tx.send(SessionCmd::Resize { cols, rows });
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().await.remove(&session_id) {
        let _ = tx.send(SessionCmd::Close);
    }
    Ok(())
}

/// Detach a session from its current frontend channel (start buffering output).
/// Called on the source window right before a tab is handed off to another one.
#[tauri::command]
pub async fn ssh_detach(state: State<'_, SshState>, session_id: String) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().await.get(&session_id) {
        let _ = tx.send(SessionCmd::Detach);
    }
    Ok(())
}

/// Reattach a live session to a new frontend channel (in the destination window)
/// and resize it to that terminal. Buffered output is flushed first, so nothing
/// printed during the move is lost.
#[tauri::command]
pub async fn ssh_reattach(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<SshEvent>,
) -> Result<(), String> {
    let tx = state
        .sessions
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or("No such session")?;
    tx.send(SessionCmd::Reattach(on_event))
        .map_err(|_| "Session is closed".to_string())?;
    let _ = tx.send(SessionCmd::Resize { cols, rows });
    Ok(())
}
