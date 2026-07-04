/**
 * Config backup (Step 6): export/import settings, keybindings, connections and
 * snippets to a single JSON file. Secrets are NEVER included — passwords live in
 * the OS keyring and stay there; imported password-auth hosts simply need their
 * password re-entered once.
 */
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import type { Connection, Snippet } from "$lib/types";
import type { Chord, BindableAction } from "$lib/stores/keybindings.svelte";
import { keybindingStore } from "$lib/stores/keybindings.svelte";
import { uiStore } from "$lib/stores/ui.svelte";
import { connectionStore } from "$lib/stores/connections.svelte";
import { snippetStore } from "$lib/stores/snippets.svelte";
import { connectionsApi, type UpsertConnection } from "$lib/api/connections";
import { snippetsApi, type UpsertSnippet } from "$lib/api/snippets";

const FORMAT = "sshagement.config";
const VERSION = 1;

export interface BackupFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  prefs: ReturnType<typeof uiStore.exportPrefs>;
  keybindings: Partial<Record<BindableAction, Chord>>;
  connections: UpsertConnection[];
  snippets: UpsertSnippet[];
}

/** Strip server-managed + secret fields, keeping the editable shape. */
function toUpsertConnection(c: Connection): UpsertConnection {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    authMethod: c.authMethod,
    keyPath: c.keyPath,
    tags: c.tags,
    group: c.group,
    subgroup: c.subgroup,
    proxy: c.proxy,
    startupSnippets: c.startupSnippets,
  };
}

function toUpsertSnippet(s: Snippet): UpsertSnippet {
  return { id: s.id, name: s.name, command: s.command, group: s.group, subgroup: s.subgroup };
}

/** Gather the current config into a serializable object. */
export function buildBackup(): BackupFile {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    prefs: uiStore.exportPrefs(),
    keybindings: keybindingStore.exportOverrides(),
    connections: connectionStore.connections.map(toUpsertConnection),
    snippets: snippetStore.items.map(toUpsertSnippet),
  };
}

/**
 * Ask the user where to save, then write the current config as JSON.
 * Returns the chosen path, or null if the dialog was cancelled.
 */
export async function exportConfig(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10);
  const path = await save({
    title: "Export SSHagement config",
    defaultPath: `sshagement-config-${stamp}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return null;
  const data = buildBackup();
  await invoke("write_text_file", { path, contents: JSON.stringify(data, null, 2) });
  return path;
}

export interface ImportResult {
  connections: number;
  snippets: number;
}

// --- Import from ~/.ssh/config -------------------------------------------------

interface SshConfigData {
  home: string;
  content: string;
}

interface ParsedHost {
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath?: string;
}

/** Minimal OpenSSH client-config parser: collects non-wildcard `Host` blocks and
 *  their HostName/User/Port/IdentityFile (first value wins, ssh semantics). */
export function parseSshConfig(text: string): ParsedHost[] {
  const hosts: ParsedHost[] = [];
  let aliases: string[] | null = null;
  let opts: Record<string, string> = {};

  const flush = () => {
    if (aliases) {
      const alias = aliases.find((a) => !a.includes("*") && !a.includes("?"));
      if (alias) {
        const port = parseInt(opts.port ?? "", 10);
        hosts.push({
          name: alias,
          host: opts.hostname || alias,
          port: Number.isFinite(port) && port > 0 ? port : 22,
          username: opts.user || "",
          keyPath: opts.identityfile,
        });
      }
    }
    aliases = null;
    opts = {};
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

    if (key === "host") {
      flush();
      aliases = val.split(/\s+/).filter(Boolean);
    } else if (key === "match") {
      // Match blocks aren't tied to a single host — ignore their options.
      flush();
    } else if (aliases && !(key in opts)) {
      opts[key] = val;
    }
  }
  flush();
  return hosts;
}

/** Expand a leading `~` in an IdentityFile path to the resolved home dir. */
function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + p.slice(1);
  return p;
}

export interface SshImportResult {
  imported: number;
  skipped: number;
}

/**
 * Read `~/.ssh/config` and import its hosts as connections (grouped "Imported").
 * Hosts already present (same user@host:port) are skipped. Key-auth hosts get
 * `authMethod: "key"` with the (home-expanded) IdentityFile; the rest default to
 * agent auth. Secrets are never touched — passphrases are entered on connect.
 */
export async function importSshConfig(): Promise<SshImportResult> {
  const data = await invoke<SshConfigData>("read_ssh_config");
  const parsed = parseSshConfig(data.content);

  const existing = new Set(
    connectionStore.connections.map((c) => `${c.username}@${c.host}:${c.port}`),
  );

  let imported = 0;
  let skipped = 0;
  for (const h of parsed) {
    const dedupe = `${h.username}@${h.host}:${h.port}`;
    if (existing.has(dedupe)) {
      skipped++;
      continue;
    }
    const keyPath = h.keyPath ? expandHome(h.keyPath, data.home) : undefined;
    const payload: UpsertConnection = {
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      authMethod: keyPath ? "key" : "agent",
      keyPath,
      tags: [],
      group: "Imported",
    };
    await connectionsApi.save(payload);
    existing.add(dedupe);
    imported++;
  }

  await connectionStore.load();
  return { imported, skipped };
}

/** Validate + apply a parsed backup. Connections/snippets are upserted by id. */
export async function applyBackup(raw: unknown): Promise<ImportResult> {
  if (!raw || typeof raw !== "object") throw new Error("Not a config file");
  const data = raw as Partial<BackupFile>;
  if (data.format !== FORMAT) throw new Error("Unrecognized config format");

  uiStore.applyPrefs(data.prefs);
  keybindingStore.importOverrides(data.keybindings);

  let connections = 0;
  for (const c of data.connections ?? []) {
    await connectionsApi.save(c);
    connections++;
  }
  let snippets = 0;
  for (const s of data.snippets ?? []) {
    await snippetsApi.save(s);
    snippets++;
  }

  // Refresh stores from the backend so the UI reflects the import.
  await connectionStore.load();
  await snippetStore.load();

  return { connections, snippets };
}

/**
 * Ask the user to pick a config file, then validate + apply it.
 * Returns the import result, or null if the dialog was cancelled.
 */
export async function importConfig(): Promise<ImportResult | null> {
  const path = await open({
    title: "Import SSHagement config",
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path || typeof path !== "string") return null;
  const text = await invoke<string>("read_text_file", { path });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON");
  }
  return applyBackup(parsed);
}
