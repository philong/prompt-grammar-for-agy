#!/usr/bin/env node

// scripts/statusline.ts
import { readFileSync as readFileSync3 } from "node:fs";

// src/config.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var DISPLAY_MODES = ["reply", "auto", "async", "system", "statusline", "user_markdown"];
var normalizeDisplay = (value) => {
  if (typeof value !== "string") {
    return;
  }
  const norm = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (norm === "statusline" || norm === "status_line") {
    return "statusline";
  }
  return DISPLAY_MODES.includes(norm) ? norm : undefined;
};
var AUTO = "auto";
var ENGLISH = "English";
var languageOf = (x) => {
  const w = typeof x === "string" ? x.trim().replace(/\s+/g, " ") : "";
  if (w === "" || w.length > 40) {
    return;
  }
  if (w.toLowerCase() === AUTO) {
    return AUTO;
  }
  return w.split(" ").map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
};
var languageSetting = (x) => {
  const names = (typeof x === "string" ? x.split(",") : []).map(languageOf).filter((n) => n !== undefined);
  if (names.includes(AUTO)) {
    return AUTO;
  }
  const unique = [...new Set(names)];
  return unique.length === 0 ? undefined : unique.join(", ");
};
var pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
var clamp = (value, min, max, fallback) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
var settingsFrom = (o = {}, env = process.env) => ({
  enabled: o.enabled !== false,
  natural: o.natural !== false,
  language: languageSetting(o.language) ?? ENGLISH,
  dialect: pick(o.dialect, ["any", "us", "uk"], "any"),
  minWords: clamp(o.min_words, 1, 50, 2),
  maxChars: clamp(o.max_chars, 200, 20000, 6000),
  showWhy: o.show_why !== false,
  history: o.history !== false,
  clean: o.clean !== false,
  askMemory: o.ask_memory !== false,
  display: normalizeDisplay(o.display) ?? "reply",
  timeoutMs: clamp(o.timeout_ms, 2000, 120000, 120000),
  endpoint: typeof o.endpoint === "string" ? o.endpoint.trim() : "",
  endpointModel: typeof o.endpoint_model === "string" ? o.endpoint_model.trim() : "",
  endpointKey: typeof o.endpoint_key === "string" && o.endpoint_key.trim() !== "" ? o.endpoint_key.trim() : (env.PROMPT_GRAMMAR_ENDPOINT_KEY ?? "").trim()
});
var EMPTY = { ignore: [], skip: [], history: true };
var CAP = 200;
var strings = (x) => Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];
var parseLists = (text) => {
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("not a JSON object");
  }
  const o = raw;
  return { ignore: strings(o.ignore), skip: strings(o.skip), history: o.history !== false };
};
var mergeLists = (...all) => ({
  ignore: [...new Set(all.flatMap((l) => l.ignore))].slice(0, CAP),
  skip: [...new Set(all.flatMap((l) => l.skip))].slice(0, CAP),
  history: all.every((l) => l.history)
});
var resolveDataDir = (home, configDir, env) => {
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim() !== "") {
    return env.PLUGIN_DATA.trim().replace(/[\\/]+$/, "");
  }
  if (env.PROMPT_GRAMMAR_DATA_DIR && env.PROMPT_GRAMMAR_DATA_DIR.trim() !== "") {
    return env.PROMPT_GRAMMAR_DATA_DIR.trim().replace(/[\\/]+$/, "");
  }
  if (!env.PROMPT_GRAMMAR_CONFIG_DIR || env.PROMPT_GRAMMAR_CONFIG_DIR.trim() === "") {
    const candidates = [
      join(home, ".gemini", "antigravity-cli", "plugin_data", "prompt-grammar"),
      join(home, ".gemini", "antigravity", "plugin_data", "prompt-grammar"),
      join(home, ".gemini", "antigravity-ide", "plugin_data", "prompt-grammar")
    ];
    const found = candidates.find((p) => existsSync(p));
    if (found !== undefined) {
      return found;
    }
  }
  return join(configDir, "grammar-data");
};
var resolvePaths = (cwd, env = process.env) => {
  const home = (env.HOME ?? env.USERPROFILE ?? homedir()).replace(/[\\/]+$/, "");
  const rawConfigDir = env.PROMPT_GRAMMAR_CONFIG_DIR?.trim();
  const configDir = (rawConfigDir ? rawConfigDir : join(home, ".gemini", "config")).replace(/[\\/]+$/, "");
  const dataDir = resolveDataDir(home, configDir, env);
  let projectConfig;
  if (cwd && cwd.trim() !== "") {
    const root = cwd.replace(/[\\/]+$/, "");
    const candidates = [join(root, ".agents", "grammar.json"), join(root, ".agent", "grammar.json")];
    projectConfig = candidates.find((p) => existsSync(p)) ?? candidates[0];
  }
  return {
    globalConfig: join(configDir, "grammar.json"),
    projectConfig,
    dataDir,
    historyFile: join(dataDir, "grammar-history.json")
  };
};
var readRawConfig = (path) => {
  if (!existsSync(path)) {
    return { raw: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { raw: {}, error: "not a JSON object" };
    }
    return { raw: parsed };
  } catch (err) {
    return { raw: {}, error: err instanceof Error ? err.message : String(err) };
  }
};
var loadConfigAndLists = (paths, env = process.env) => {
  const warnings = [];
  const g = readRawConfig(paths.globalConfig);
  if (g.error !== undefined) {
    warnings.push(`${paths.globalConfig} is ignored: ${g.error}`);
  }
  const globalLists = g.error === undefined ? parseLists(JSON.stringify(g.raw)) : EMPTY;
  let projectRaw = {};
  let projectLists = EMPTY;
  if (paths.projectConfig && paths.projectConfig !== paths.globalConfig && existsSync(paths.projectConfig)) {
    const p = readRawConfig(paths.projectConfig);
    if (p.error !== undefined) {
      warnings.push(`${paths.projectConfig} is ignored: ${p.error}`);
    } else {
      projectRaw = p.raw;
      projectLists = parseLists(JSON.stringify(p.raw));
    }
  }
  const mergedRaw = { ...g.raw, ...projectRaw };
  for (const key of ["endpoint", "endpoint_model", "endpoint_key"]) {
    if (g.raw[key] !== undefined) {
      mergedRaw[key] = g.raw[key];
    } else {
      delete mergedRaw[key];
    }
  }
  const settings = settingsFrom(mergedRaw, env);
  const lists = mergeLists(globalLists, projectLists);
  return { settings, lists, projectAllowsHistory: projectLists.history, warnings };
};

// src/format.ts
var sanitizeTerminalText = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();

// src/state.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, statSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var STALE_SESSION_MS = 7 * 86400000;
var safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
var statusLinePath = (dataDir, conversationId) => join2(dataDir, "statusline", `${safeId(conversationId)}.json`);
var readStatusLine = (dataDir, conversationId) => {
  const path = statusLinePath(dataDir, conversationId);
  if (!existsSync2(path)) {
    return;
  }
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
    if (raw === null || typeof raw !== "object" || typeof raw.ansi !== "string" || typeof raw.plain !== "string") {
      return;
    }
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      ansi: raw.ansi,
      plain: raw.plain,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
    };
  } catch {
    return;
  }
};

// src/statusline.ts
var renderStatusLine = (payload, opts) => {
  const env = opts?.env ?? process.env;
  const conversationId = (payload.conversation_id || payload.conversationId || payload.session_id || payload.sessionId || "").trim();
  if (conversationId === "") {
    return "";
  }
  const cwd = payload.cwd || payload.workspace?.current_dir || payload.workspace?.project_dir;
  const paths = resolvePaths(cwd, env);
  const { settings } = loadConfigAndLists(paths, env);
  if (!settings.enabled || settings.display !== "statusline" && settings.display !== "auto") {
    return "";
  }
  const entry = readStatusLine(paths.dataDir, conversationId);
  if (entry === undefined) {
    return "";
  }
  if (env.NO_COLOR) {
    return entry.plain.split(`
`).map(sanitizeTerminalText).filter(Boolean).join(`
`);
  }
  return entry.ansi;
};

// scripts/statusline.ts
var main = () => {
  try {
    const raw = readFileSync3(0, "utf8").trim();
    const payload = raw === "" ? {} : JSON.parse(raw);
    const out = renderStatusLine(payload);
    if (out !== "") {
      process.stdout.write(`${out}
`);
    }
  } catch {}
};
main();
