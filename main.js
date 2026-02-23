/* eslint-disable no-console */
const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const SQLITE3_PATH = "/usr/bin/sqlite3";
const OPEN_PATH = "/usr/bin/open";

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function stripTrailingSlashes(inputPath) {
  if (!inputPath) return inputPath;
  let result = inputPath;
  while (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function safeRealpath(inputPath) {
  try {
    return fs.realpathSync.native(inputPath);
  } catch (_e) {
    try {
      return fs.realpathSync(inputPath);
    } catch (_e2) {
      return inputPath;
    }
  }
}

function normalizePathForComparison(inputPath) {
  if (!inputPath) return "";
  const resolved = safeRealpath(stripTrailingSlashes(inputPath));
  const standardized = stripTrailingSlashes(resolved);
  if (process.platform === "darwin") {
    return standardized.toLowerCase();
  }
  return standardized;
}

function sqlQuote(raw) {
  return `'${String(raw).replace(/'/g, "''")}'`;
}

async function sqliteQuery(dbPath, sql) {
  const args = [
    "-readonly",
    "-noheader",
    "-batch",
    "-cmd",
    ".timeout 2000",
    "-separator",
    "\t",
    dbPath,
    sql
  ];
  return await execFilePromise(SQLITE3_PATH, args);
}

function parseTabSeparatedRows(stdout, expectedColumnCount) {
  const lines = String(stdout)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    const cols = line.split("\t");
    if (typeof expectedColumnCount === "number" && cols.length < expectedColumnCount) {
      while (cols.length < expectedColumnCount) cols.push("");
    }
    return cols;
  });
}

function findClarityDatabasePaths() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library/Containers/ch.reckoner.Clarity/Data/Library/Application Support/Clarity/sources.db"),
    path.join(home, "Library/Application Support/Clarity/sources.db")
  ];
  const existing = [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) existing.push(candidate);
    } catch (_e) {}
  }
  return existing;
}

function isClarityInstalledMac() {
  if (process.platform !== "darwin") return false;
  try {
    const appNames = ["ONA.UNO", "Clarity"];
    for (const name of appNames) {
      const result = require("child_process").spawnSync(OPEN_PATH, ["-Ra", name], { encoding: "utf8" });
      if (result.status === 0) return true;
    }
  } catch (_e) {}

  try {
    const home = os.homedir();
    const appBundles = [
      "/Applications/ONA.UNO.app",
      "/Applications/Clarity.app",
      path.join(home, "Applications/ONA.UNO.app"),
      path.join(home, "Applications/Clarity.app")
    ];
    for (const bundlePath of appBundles) {
      if (fs.existsSync(bundlePath)) return true;
    }
  } catch (_e) {}
  return false;
}

function openExternal(url) {
  try {
    const { shell } = require("electron");
    shell.openExternal(url);
    return true;
  } catch (_e) {}

  if (process.platform === "darwin") {
    try {
      spawn(OPEN_PATH, [url], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch (_e) {}
  }
  return false;
}

function sourceTypeLabel(type) {
  if (type === "obsidian") return "Obsidian vault";
  if (type === "folder") return "folder source";
  return type || "source";
}

async function listVaultSources(dbPath) {
  const sql = "SELECT id, namespace, is_active, type FROM sources WHERE type IN ('obsidian', 'folder');";
  const stdout = await sqliteQuery(dbPath, sql);
  const rows = parseTabSeparatedRows(stdout, 4);
  return rows.map(([idStr, namespace, activeStr, type]) => ({
    id: Number(idStr),
    namespace: namespace || "",
    isActive: Number(activeStr) === 1,
    type: type || ""
  }));
}

async function resolveVaultSource(dbPath, vaultBasePath) {
  const sources = await listVaultSources(dbPath);
  const normalizedVault = normalizePathForComparison(vaultBasePath);
  const matches = sources.filter((source) => normalizePathForComparison(source.namespace) === normalizedVault);
  if (matches.length === 0) return null;
  return matches.find((source) => source.type === "obsidian") || matches[0];
}

async function resolveVaultSourceAcrossDatabases(vaultBasePath) {
  const dbPaths = findClarityDatabasePaths();
  if (dbPaths.length === 0) return null;

  for (const dbPath of dbPaths) {
    try {
      const source = await resolveVaultSource(dbPath, vaultBasePath);
      if (source) return { dbPath, source };
    } catch (_e) {}
  }
  return null;
}

async function stableUuidForFile(dbPath, sourceId, filePathCandidates) {
  const normalized = Array.from(
    new Set(filePathCandidates.filter(Boolean).map((p) => stripTrailingSlashes(String(p))))
  );
  if (normalized.length === 0) return null;

  const conditions = normalized
    .map((candidate) => {
      const q = sqlQuote(candidate);
      return `(display_name = ${q} OR json_extract(metadata_json, '$.filepath') = ${q})`;
    })
    .join(" OR ");

  const sql = `
    SELECT stable_uuid
    FROM items
    WHERE source_id = ${Number(sourceId)}
      AND (${conditions})
      AND (deleted IS NULL OR deleted = 0)
    LIMIT 1;
  `.trim();

  const stdout = await sqliteQuery(dbPath, sql);
  const uuid = String(stdout).trim();
  return uuid.length > 0 ? uuid : null;
}

function makeItemDeepLink({ stableUuid, tab, newChat }) {
  const query = [];
  if (tab) query.push(`tab=${encodeURIComponent(tab)}`);
  if (newChat) query.push("newChat=1");
  const suffix = query.length ? `?${query.join("&")}` : "";
  return `ona-uno://item/${encodeURIComponent(stableUuid)}${suffix}`;
}

function makeObsidianOpenDeepLink({ vaultPath, filePath, tab, newChat }) {
  const query = [
    `vault=${encodeURIComponent(vaultPath)}`,
    `filepath=${encodeURIComponent(filePath)}`
  ];
  if (tab) query.push(`tab=${encodeURIComponent(tab)}`);
  if (newChat) query.push("newChat=1");
  return `ona-uno://obsidian/open?${query.join("&")}`;
}

function vaultBasePath(app) {
  const adapter = app.vault?.adapter;
  if (!adapter) return null;
  if (typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }
  if (typeof adapter.basePath === "string") {
    return adapter.basePath;
  }
  return null;
}

class ClaritySettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "ONA.UNO Companion" });

    const row = containerEl.createDiv({ cls: "clarity-status-row" });
    const bubble = row.createDiv({ cls: "clarity-status-bubble" });
    const label = row.createDiv({ text: "Checking readiness…" });
    const detail = containerEl.createDiv({ cls: "clarity-status-detail" });

    new Setting(containerEl)
      .setName("Refresh readiness")
      .setDesc("Re-check ONA.UNO install + vault/source status.")
      .addButton((btn) => {
        btn.setButtonText("Refresh").onClick(() => {
          this.plugin.refreshReadiness({ bubble, label, detail }).catch((err) => {
            console.error(err);
            new Notice("ONA.UNO: readiness check failed (see console).");
          });
        });
      });

    this.plugin.refreshReadiness({ bubble, label, detail }).catch((err) => {
      console.error(err);
      new Notice("ONA.UNO: readiness check failed (see console).");
    });
  }
}

module.exports = class ClarityCompanionPlugin extends Plugin {
  async onload() {
    this.addSettingTab(new ClaritySettingsTab(this.app, this));

    this.addCommand({
      id: "clarity-open-in-clarity",
      name: "Open in ONA.UNO App",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.openFileInClarity(file, { tab: "summary", newChat: false }).catch((err) => {
          console.error(err);
          new Notice("ONA.UNO: failed to open note (see console).");
        });
        return true;
      }
    });

    this.addCommand({
      id: "clarity-chat-in-clarity",
      name: "Chat in ONA.UNO App",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.openFileInClarity(file, { tab: "chat", newChat: true }).catch((err) => {
          console.error(err);
          new Notice("ONA.UNO: failed to start chat (see console).");
        });
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!file || file.extension !== "md") return;
        menu.addItem((item) => {
          item.setTitle("Open in ONA.UNO App").onClick(() => {
            this.openFileInClarity(file, { tab: "summary", newChat: false }).catch((err) => {
              console.error(err);
              new Notice("ONA.UNO: failed to open note (see console).");
            });
          });
        });
        menu.addItem((item) => {
          item.setTitle("Chat in ONA.UNO App").onClick(() => {
            this.openFileInClarity(file, { tab: "chat", newChat: true }).catch((err) => {
              console.error(err);
              new Notice("ONA.UNO: failed to start chat (see console).");
            });
          });
        });
      })
    );
  }

  async refreshReadiness({ bubble, label, detail }) {
    const readiness = await this.computeReadiness();
    bubble.removeClass("is-pink", "is-red", "is-orange", "is-green");
    bubble.addClass(readiness.bubbleClass);
    label.setText(readiness.message);
    detail.setText(readiness.detail || "");
  }

  async computeReadiness() {
    if (process.platform !== "darwin") {
      return {
        bubbleClass: "is-pink",
        message: "Please install ONA.UNO.",
        detail: "ONA.UNO Companion currently supports macOS only."
      };
    }

    if (!isClarityInstalledMac()) {
      return {
        bubbleClass: "is-pink",
        message: "Please install ONA.UNO.",
        detail: "ONA.UNO was not found via LaunchServices."
      };
    }

    const vaultPath = vaultBasePath(this.app);
    if (!vaultPath) {
      return {
        bubbleClass: "is-red",
        message: "Current vault path unavailable.",
        detail: "Obsidian did not expose a filesystem path for this vault."
      };
    }

    const dbPaths = findClarityDatabasePaths();
    if (dbPaths.length === 0) {
      return {
        bubbleClass: "is-red",
        message: "Current vault is not a source in ONA.UNO.",
        detail: "ONA.UNO database not found yet. Open ONA.UNO App once, add this vault as a source, then activate it."
      };
    }

    let match = null;
    try {
      match = await resolveVaultSourceAcrossDatabases(vaultPath);
    } catch (err) {
      return {
        bubbleClass: "is-red",
        message: "Current vault is not a source in ONA.UNO.",
        detail: `Failed to read ONA.UNO database:\n${String(err)}`
      };
    }

    if (!match) {
      return {
        bubbleClass: "is-red",
        message: "Current vault is not a source in ONA.UNO.",
        detail: `Vault: ${vaultPath}\nDBs checked:\n${dbPaths.join("\n")}`
      };
    }

    if (!match.source.isActive) {
      const label = sourceTypeLabel(match.source.type);
      return {
        bubbleClass: "is-orange",
        message: `Please activate the ${label} in ONA.UNO.`,
        detail: `Vault: ${vaultPath}\nDB: ${match.dbPath}\nMatched: ${sourceTypeLabel(match.source.type)}\nSource path: ${match.source.namespace}`
      };
    }

    const label = sourceTypeLabel(match.source.type);
    return {
      bubbleClass: "is-green",
      message: `Current vault is in ONA.UNO as an active ${label}.`,
      detail: `Vault: ${vaultPath}\nDB: ${match.dbPath}\nMatched: ${sourceTypeLabel(match.source.type)}\nSource path: ${match.source.namespace}`
    };
  }

  async openFileInClarity(file, { tab, newChat }) {
    if (process.platform !== "darwin") {
      new Notice("ONA.UNO is macOS-only.");
      return;
    }
    if (!isClarityInstalledMac()) {
      new Notice("ONA.UNO is not installed. Please install ONA.UNO.");
      return;
    }

    const vaultPath = vaultBasePath(this.app);
    if (!vaultPath) {
      new Notice("Could not resolve vault path on disk.");
      return;
    }

    const fileAbs = path.join(vaultPath, file.path);
    const fileAbsReal = safeRealpath(fileAbs);
    const fileCandidates = [fileAbs, fileAbsReal];

    const dbPaths = findClarityDatabasePaths();
    for (const dbPath of dbPaths) {
      try {
        const source = await resolveVaultSource(dbPath, vaultPath);
        if (!source || !source.isActive) continue;
        const stableUuid = await stableUuidForFile(dbPath, source.id, fileCandidates);
        if (!stableUuid) continue;
        const url = makeItemDeepLink({ stableUuid, tab, newChat });
        openExternal(url);
        return;
      } catch (err) {
        console.warn(`ONA.UNO: DB lookup failed for ${dbPath}; continuing.`, err);
      }
    }

    const url = makeObsidianOpenDeepLink({
      vaultPath,
      filePath: fileAbsReal || fileAbs,
      tab,
      newChat
    });
    openExternal(url);
  }
};
