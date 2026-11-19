#!/usr/bin/env node

// src/commands.ts
import { existsSync as existsSync4 } from "node:fs";

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
var languagesOf = (setting) => setting === AUTO ? [] : setting.split(", ");
var joinNames = (names, and = "or") => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
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
  timeoutMs: clamp(o.timeout_ms, 2000, 120000, 30000),
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
var SLASHED = /^\/(.+)\/([a-z]*)$/;
var regexOf = (entry, defaultFlags = "") => {
  const m = SLASHED.exec(entry);
  if (m === null) {
    return null;
  }
  const [, source = "", flags = ""] = m;
  try {
    return new RegExp(source, (flags || defaultFlags).replace(/[gy]/g, ""));
  } catch {
    return;
  }
};
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var wordRegex = (word) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(word)}($|[^\\p{L}\\p{N}_])`, "iu");
var compileIgnore = (entries) => {
  const words = [];
  const matchers = [];
  for (const entry of entries) {
    const re = regexOf(entry, "i");
    if (re === null) {
      words.push(entry);
      matchers.push(wordRegex(entry));
    } else if (re !== undefined) {
      matchers.push(re);
    }
  }
  return { words, matchers };
};
var isIgnored = (ignore, s) => ignore.matchers.some((re) => re.test(s));
var cut = (text, max) => {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const space = head.search(/\s\S*$/);
  return space > max / 2 ? head.slice(0, space) : head;
};
var entriesFrom = (args) => (args.includes(",") ? args.split(",") : args.split(/\s+/)).map((s) => s.trim()).filter((s) => s !== "");
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
var writeGlobalField = (globalConfigPath, key, value) => {
  const existing = readRawConfig(globalConfigPath);
  if (existing.error !== undefined) {
    return { ok: false, error: `${globalConfigPath} does not parse (${existing.error}), so it was left as it is. Fix it by hand.` };
  }
  const next = { ...existing.raw, [key]: value };
  if (value === undefined) {
    delete next[key];
  }
  mkdirSync(dirname(globalConfigPath), { recursive: true });
  const tmp = `${globalConfigPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, { encoding: "utf8", mode: 384 });
  try {
    chmodSync(tmp, 384);
  } catch {}
  renameSync(tmp, globalConfigPath);
  return { ok: true };
};
var CONFIG_KEYS = [
  "enabled",
  "natural",
  "language",
  "dialect",
  "min_words",
  "max_chars",
  "show_why",
  "history",
  "clean",
  "ask_memory",
  "display",
  "timeout_ms",
  "endpoint",
  "endpoint_model",
  "endpoint_key"
];

// src/format.ts
var formatAdviceMarkdown = (text) => text.split(`
`).map((line) => {
  const m = /^\s*(.+?)\s+→\s+(.*?)\s*$/.exec(line);
  if (m !== null) {
    const from = m[1] ?? "";
    const to = m[2] ?? "";
    return `  - ~~${from}~~ **${to === "" ? "(drop it)" : to}**`;
  }
  return line;
}).join(`
`);
var formatReviewMarkdown = (m, advice, model, followUp) => {
  const pct = (n, of) => `${Math.round(100 * n / Math.max(1, of))}%`;
  const BAR = 15;
  const most = Math.max(1, ...m.kinds.map((k) => k.n));
  const width = Math.max(0, ...m.kinds.slice(0, 3).map((k) => k.kind.length));
  const cardLines = [
    `Grammar review · ${m.language === undefined ? "" : `${m.language} · `}${m.label} (${m.range})`,
    `${m.checked} prompts · ${pct(m.withFixes, m.checked)} with a fix · ${m.fixes} fixes`
  ];
  if (m.trend !== undefined) {
    const arrow = m.trend.fewer === true ? "↓" : m.trend.fewer === false ? "↑" : "=";
    cardLines.push(`${arrow} ${m.trend.text}`);
  }
  if (m.kinds.length > 0) {
    cardLines.push("");
    for (const k of m.kinds.slice(0, 3)) {
      const n = Math.max(1, Math.round(BAR * k.n / most));
      cardLines.push(`${k.kind.padEnd(width)}  ${"█".repeat(n)}${"░".repeat(BAR - n)}  ${Math.round(k.share * 100)}%`);
    }
  }
  if (m.top !== undefined) {
    cardLines.push("", `most repeated: ${m.top.from} → ${m.top.to === "" ? "(drop it)" : m.top.to}  ×${m.top.count}`);
  }
  const hint = followUp ? " · `/grammar ask <question>` follows up" : "";
  return [
    "```text",
    ...cardLines,
    "```",
    "",
    formatAdviceMarkdown(advice),
    "",
    `*${model}, from ${m.fixes} fixes${hint}*`
  ].join(`
`);
};

// src/history.ts
var KINDS = [
  "spelling",
  "tense",
  "agreement",
  "article",
  "preposition",
  "word order",
  "wrong word",
  "missing word",
  "extra word",
  "other"
];
var kindOf = (x) => {
  const k = typeof x === "string" ? x.trim().toLowerCase().replace(/[-_]+/g, " ") : "";
  return KINDS.includes(k) ? k : "other";
};
var EMPTY_HISTORY = { version: 1, fixes: [], days: [] };
var MAX_ENTRIES = 2000;
var KEEP_DAYS = 90;
var REVIEW_FROM = 20;
var DAY_MS = 86400000;
var dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
var langOf = (x) => x.lang ?? ENGLISH;
var langField = (lang) => {
  const l = languageOf(lang);
  return l === undefined || l === ENGLISH ? {} : { lang: l };
};
var isRecord = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
var entryOf = (e) => isRecord(e) && typeof e.from === "string" && typeof e.to === "string" && Number.isFinite(e.at) ? [
  {
    from: e.from,
    to: e.to,
    why: typeof e.why === "string" ? e.why : "",
    kind: kindOf(e.kind),
    at: e.at,
    ...langField(e.lang)
  }
] : [];
var dayEntryOf = (d) => isRecord(d) && typeof d.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isFinite(d.checked) && Number.isFinite(d.withFixes) ? [{ day: d.day, checked: d.checked, withFixes: d.withFixes, ...langField(d.lang) }] : [];
var salvage = (text) => {
  const fixes = [];
  const days = [];
  for (const line of text.split(`
`)) {
    const m = /^\s*(\{.*\})\s*,?\s*$/.exec(line);
    if (m === null) {
      continue;
    }
    try {
      const x = JSON.parse(m[1] ?? "");
      fixes.push(...entryOf(x));
      days.push(...dayEntryOf(x));
    } catch {}
  }
  return { version: 1, fixes, days };
};
var parseHistory = (text) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const saved = salvage(text);
    if (saved.fixes.length + saved.days.length === 0) {
      throw err;
    }
    return saved;
  }
  if (!isRecord(raw)) {
    throw new Error("not a JSON object");
  }
  return {
    version: 1,
    fixes: (Array.isArray(raw.fixes) ? raw.fixes : []).flatMap(entryOf),
    days: (Array.isArray(raw.days) ? raw.days : []).flatMap(dayEntryOf)
  };
};
var historyText = (h) => {
  const rows = (xs) => xs.length === 0 ? "[]" : `[
${xs.map((x) => `  ${JSON.stringify(x)}`).join(`,
`)}
]`;
  return `{
"version": 1,
"days": ${rows(h.days)},
"fixes": ${rows(h.fixes)}
}
`;
};
var norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
var changesWords = (f) => norm(f.from) !== norm(f.to);
var oldestDay = (now) => dayOf(now - (KEEP_DAYS - 1) * DAY_MS);
var languagesIn = (h) => {
  const by = new Map;
  const at = (lang) => by.get(lang) ?? { lang, checked: 0, fixes: 0 };
  for (const d of h.days) {
    const l = at(langOf(d));
    by.set(l.lang, { ...l, checked: l.checked + d.checked });
  }
  for (const f of h.fixes) {
    const l = at(langOf(f));
    by.set(l.lang, { ...l, fixes: l.fixes + 1 });
  }
  return [...by.values()].sort((a, b) => b.checked - a.checked || b.fixes - a.fixes || a.lang.localeCompare(b.lang));
};
var inLanguage = (h, lang) => ({
  version: 1,
  fixes: h.fixes.filter((f) => langOf(f) === lang),
  days: h.days.filter((d) => langOf(d) === lang)
});
var splitLanguage = (words, known) => {
  const w = words.trim().replace(/\s+/g, " ");
  const lower = w.toLowerCase();
  for (const lang of [...known].sort((a, b) => b.length - a.length)) {
    const l = lang.toLowerCase();
    if (lower === l) {
      return { lang, rest: "" };
    }
    if (lower.startsWith(`${l} `)) {
      return { lang, rest: w.slice(l.length + 1) };
    }
    if (lower.endsWith(` ${l}`)) {
      return { lang, rest: w.slice(0, w.length - l.length - 1) };
    }
  }
  return { rest: w };
};
var pickLanguage = (h, named, setting) => {
  const all = languagesIn(h);
  const set = languagesOf(setting);
  const lang = named ?? all.find((l) => set.includes(l.lang))?.lang ?? all[0]?.lang ?? ENGLISH;
  return { lang, others: all.filter((l) => l.lang !== lang), show: all.length > 1 || lang !== ENGLISH };
};
var visible = (h, ignore) => h.fixes.filter((f) => changesWords(f) && !isIgnored(ignore, f.from));
var pairsOf = (fixes) => {
  const by = new Map;
  for (const f of fixes) {
    const key = `${norm(f.from)}\x00${norm(f.to)}`;
    const p = by.get(key) ?? { from: norm(f.from), to: norm(f.to), kind: f.kind, why: "", count: 0, kinds: new Map };
    p.count += 1;
    p.why ||= f.why;
    p.kinds.set(f.kind, (p.kinds.get(f.kind) ?? 0) + 1);
    by.set(key, p);
  }
  return [...by.values()].map(({ kinds, ...p }) => ({ ...p, kind: [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? p.kind })).sort((a, b) => b.count - a.count);
};
var arrow = (p) => `${p.from} → ${p.to === "" ? "(drop it)" : p.to}`;
var pct = (n, of) => `${Math.round(100 * n / Math.max(1, of))}%`;
var trendOf = (days, now) => {
  const cut1 = dayOf(now - 30 * DAY_MS);
  const cut2 = dayOf(now - 60 * DAY_MS);
  const sum = (ds) => ds.reduce((a, d) => ({ checked: a.checked + d.checked, withFixes: a.withFixes + d.withFixes }), { checked: 0, withFixes: 0 });
  const recent = sum(days.filter((d) => d.day > cut1));
  const before = sum(days.filter((d) => d.day > cut2 && d.day <= cut1));
  return recent.checked < 10 || before.checked < 10 ? undefined : { recent: recent.withFixes / recent.checked, before: before.withFixes / before.checked };
};
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var shortDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ""} ${Number(day.slice(8, 10))}`;
var addDays = (day, n) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
var daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
var PERIOD_HELP = "A period is 7d, 30d or since 2026-10-01 (UTC days, today included); with none, everything kept.";
var parsePeriod = (words, now) => {
  const today = dayOf(now);
  const oldest = oldestDay(now);
  const w = words.trim().toLowerCase();
  const withBefore = (fromDay, label, beforeLabel) => {
    const n = daysBetween(fromDay, today) + 1;
    const toDay = addDays(fromDay, -1);
    const start = addDays(fromDay, -n);
    if (toDay < oldest) {
      return { fromDay, toDay: today, label };
    }
    if (start >= oldest) {
      return { fromDay, toDay: today, label, before: { fromDay: start, toDay, label: beforeLabel } };
    }
    const kept = daysBetween(oldest, toDay) + 1;
    return {
      fromDay,
      toDay: today,
      label,
      before: { fromDay: oldest, toDay, label: `the ${kept} kept day${kept === 1 ? "" : "s"} before` }
    };
  };
  if (w === "" || w === "all") {
    return { fromDay: oldest, toDay: today, label: "everything kept" };
  }
  const d = /^(\d+)\s*d(ays?)?$/.exec(w);
  if (d !== null) {
    const n = Number(d[1]);
    if (n < 1 || n > KEEP_DAYS) {
      return `The history keeps ${KEEP_DAYS} days: pick 1d to ${KEEP_DAYS}d.`;
    }
    const days = `${n} day${n === 1 ? "" : "s"}`;
    return withBefore(addDays(today, -(n - 1)), n === 1 ? "today" : `last ${days}`, n === 1 ? "yesterday" : `the ${days} before`);
  }
  const since = /^since\s+(\d{4}-\d{2}-\d{2})$/.exec(w);
  if (since !== null) {
    const day = since[1] ?? "";
    const at = Date.parse(`${day}T00:00:00Z`);
    if (Number.isNaN(at) || dayOf(at) !== day || day > today) {
      return `${day} is not a day up to today. ${PERIOD_HELP}`;
    }
    const from = day < oldest ? oldest : day;
    return withBefore(from, `since ${shortDay(from)}`, "the same stretch before");
  }
  return PERIOD_HELP;
};
var within = (h, span) => ({
  version: 1,
  fixes: h.fixes.filter((f) => dayOf(f.at) >= span.fromDay && dayOf(f.at) <= span.toDay),
  days: h.days.filter((d) => d.day >= span.fromDay && d.day <= span.toDay)
});
var counts = (days) => days.reduce((a, d) => ({ checked: a.checked + d.checked, withFixes: a.withFixes + d.withFixes }), { checked: 0, withFixes: 0 });
var compare = (h, period, now) => {
  const verdict = (recent, before) => {
    const [a, b] = [Math.round(recent * 100), Math.round(before * 100)];
    return { a, b, fewer: a < b ? true : a > b ? false : null, word: a < b ? "Fewer" : a > b ? "More" : "Same" };
  };
  if (period.before === undefined) {
    const t = trendOf(h.days, now);
    if (t === undefined) {
      return;
    }
    const v = verdict(t.recent, t.before);
    return {
      ...t,
      fewer: v.fewer,
      text: `${v.word === "Same" ? "Same as" : `${v.word} than`} before: ${v.a}% of prompts had a fix in the last 30 days, ${v.b}% in the 30 before.`
    };
  }
  const now1 = counts(within(h, period).days);
  const then = counts(within(h, period.before).days);
  if (now1.checked < 10 || then.checked < 10) {
    return;
  }
  const [recent, before] = [now1.withFixes / now1.checked, then.withFixes / then.checked];
  const v = verdict(recent, before);
  return { recent, before, fewer: v.fewer, text: `${v.word === "Same" ? "Same as" : `${v.word} than`} ${period.before.label} (${v.b}%)` };
};
var summaryOf = (h, ignore, period, now, language) => {
  const part = within(h, period);
  const fixes = visible(part, ignore);
  const { checked, withFixes } = counts(part.days);
  const first = [part.days[0]?.day, fixes[0] === undefined ? undefined : dayOf(fixes[0].at)].filter((d) => d !== undefined).sort()[0];
  const from = period.before === undefined && first !== undefined ? first : period.fromDay;
  const kinds = KINDS.map((kind) => ({ kind, n: fixes.filter((f) => f.kind === kind).length })).filter((k) => k.n > 0).sort((a, b) => b.n - a.n).map((k) => ({ ...k, share: k.n / fixes.length }));
  const top = pairsOf(fixes)[0];
  return {
    ...language === undefined ? {} : { language },
    label: period.label,
    range: from === period.toDay ? shortDay(from) : `${shortDay(from)} – ${shortDay(period.toDay)}`,
    checked,
    withFixes,
    fixes: fixes.length,
    trend: compare(h, period, now),
    kinds,
    top: top !== undefined && top.count > 1 ? top : undefined
  };
};
var othersLine = (others, command) => others.length === 0 ? [] : [
  `Also kept: ${others.map((o) => `${o.lang} (${o.fixes} fixes)`).join(", ")}. /grammar ${command} ${others[0]?.lang.toLowerCase()} shows ${others.length === 1 ? "it" : "one"}.`
];
var statsText = (h, ignore, now, path, on, period, words = "", reviewer = "the default model", language, others = []) => {
  const p = period ?? parsePeriod("", now);
  const where = `Kept in ${path}.${on ? "" : " The history is off: /grammar history on keeps new fixes."}`;
  if (h.fixes.length === 0 && h.days.length === 0) {
    return `Nothing kept yet. ${on ? "Fixes are kept from your next checked prompt." : "The history is off: /grammar history on keeps fixes from now on."}`;
  }
  const m = summaryOf(h, ignore, p, now);
  if (m.checked === 0 && m.fixes === 0) {
    return [`Nothing kept for ${p.label}${language === undefined ? "" : ` in ${language}`}. ${where}`, ...othersLine(others, "stats")].join(`
`);
  }
  const fixes = visible(within(h, p), ignore);
  const label = p.label.charAt(0).toUpperCase() + p.label.slice(1);
  const lines = [
    `${label}${language === undefined ? "" : `, ${language}`} (${m.range}): ${m.checked} prompts checked, ${m.withFixes} with a fix (${pct(m.withFixes, m.checked)}), ${m.fixes} fixes kept.`
  ];
  if (m.trend !== undefined) {
    lines.push(p.before === undefined ? m.trend.text : `${m.trend.text}.`);
  }
  const pairs = pairsOf(fixes);
  if (m.kinds.length > 0) {
    const width = Math.max(...m.kinds.map((k) => k.kind.length));
    lines.push("", "By kind:");
    for (const { kind, n } of m.kinds) {
      const top = pairs.find((x) => x.kind === kind);
      const eg = top === undefined ? "" : `  e.g. ${arrow(top)}`;
      lines.push(`  ${kind.padEnd(width)}  ${String(n).padStart(4)}  ${pct(n, m.fixes).padStart(4)}${eg}`);
    }
  }
  const repeated = pairs.filter((x) => x.count > 1).slice(0, 10);
  lines.push("", repeated.length > 0 ? "Repeated fixes:" : "No fix repeated yet.");
  for (const x of repeated) {
    lines.push(`  ×${String(x.count).padEnd(3)} ${arrow(x)}`);
  }
  const forPeriod = words.trim() === "" ? "" : ` ${words.trim()}`;
  lines.push("", m.fixes >= REVIEW_FROM ? `/grammar review${forPeriod}: advice on these from ${reviewer} (one call).` : `/grammar review gives advice from ${REVIEW_FROM} fixes; ${m.fixes} so far.`, ...othersLine(others, "stats"), where);
  return lines.join(`
`);
};
var MAX_REVIEW_PAIRS = 300;
var reviewInput = (fixes) => {
  const counts = KINDS.map((kind) => ({ kind, n: fixes.filter((f) => f.kind === kind).length })).filter((k) => k.n > 0).sort((x, y) => y.n - x.n);
  const pairs = pairsOf(fixes).slice(0, MAX_REVIEW_PAIRS);
  return [
    `${fixes.length} fixes. By kind: ${counts.map((k) => `${k.kind} ${k.n}`).join(", ")}.`,
    'Each fix as "count× wrong → right (kind; why)", most frequent first:',
    ...pairs.map((p) => `${p.count}× ${arrow(p)} (${p.kind}${p.why === "" ? "" : `; ${p.why}`})`)
  ].join(`
`);
};
var reviewSystem = (language) => `You coach a non-native ${language} speaker who writes prompts to a coding assistant in ${language}. You get the fixes a proofreader made to their prompts over time, grouped, with how often each came up.
Write in ${language}.
Find the 3 to 5 habits behind the most mistakes, most frequent first. For each: a numbered line naming the habit and the rule that fixes it, in plain words, then one to three of their own fixes as examples, each on its own line as "  wrong → right".
Skip one-off typos unless they share a pattern. If a fix looks like the proofreader's own mistake rather than the writer's, leave it out.
Plain text only: no markdown, no headings, no bold, no intro and no closing line.`;
var ASK_MEMORY = 5;
var MAX_QUESTION = 1000;
var MAX_ANSWER = 2000;
var ASK_RECENT = 10;
var splitAsk = (words, now) => {
  const w = words.trim();
  const head = /^(\d+d|since\s+\S+)(?:\s+|$)/i.exec(w);
  const period = parsePeriod(head === null ? "" : head[1] ?? "", now);
  if (typeof period === "string") {
    return period;
  }
  return { period, question: head === null ? w : w.slice(head[0].length).trim() };
};
var askInput = (fixes, label, recent, turns, question) => {
  const langs = [...new Set(fixes.map(langOf))];
  const parts = fixes.length === 0 ? [`Their kept fixes (${label}): none kept.`] : langs.map((lang) => `Their kept fixes in ${lang} (${label}): 
${reviewInput(fixes.filter((f) => langOf(f) === lang))}`);
  if (recent.length > 0) {
    const many = new Set([...langs, ...recent.map((f) => f.language ?? ENGLISH)]).size > 1;
    const tail = (f) => [f.why, many ? f.language ?? ENGLISH : ""].filter((x) => x !== "").join("; ");
    parts.push(["Fixes in their latest prompts, newest first:", ...recent.map((f) => `${arrow(f)}${tail(f) === "" ? "" : ` (${tail(f)})`}`)].join(`
`));
  }
  if (turns.length > 0) {
    parts.push(["Earlier in this conversation, oldest first:", ...turns.map((t) => `Q: ${t.q}
A: ${t.a}`)].join(`

`));
  }
  parts.push(`Their question: ${question}`);
  return parts.join(`

`);
};
var ASK_SYSTEM = `You coach someone who writes prompts to a coding assistant in a language that may not be their first, and answer their questions about it. You get the fixes a proofreader made to their prompts over time (grouped by language, with counts), the fixes in their latest prompts, and what was asked and answered earlier in this conversation.
Answer in the language the question is asked in.
Answer the question directly, in a few short paragraphs at most. When their own fixes show the point, give one to three of them as examples, each on its own line as "  wrong → right". Use only fixes you were given and never invent mistakes they made. When there are too few fixes to see a pattern, say so and answer in general terms.
If the question is not about language or their writing, say in one line that you only answer questions about language and their writing.
Plain text only: no markdown, no headings, no bold, no intro and no closing line.`;

// src/endpoint.ts
var chatUrl = (endpoint) => {
  const base = endpoint.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) {
    return base;
  }
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
};
var hostOf = (endpoint) => {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return endpoint;
  }
};
var NO_QUIRKS = { thinking: false, temperature: false, maxTokens: false };
var chatBody = (model, r, q = NO_QUIRKS) => JSON.stringify({
  ...model === "" ? {} : { model },
  ...q.maxTokens ? { max_completion_tokens: r.maxTokens } : { max_tokens: r.maxTokens },
  ...q.temperature ? {} : { temperature: 0 },
  ...q.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } },
  stream: false,
  messages: [
    { role: "system", content: r.system },
    { role: "user", content: r.prompt }
  ]
});
var quirkOf = (q, error) => {
  const e = error.toLowerCase();
  if (!q.thinking && e.includes("chat_template_kwargs")) {
    return { ...q, thinking: true };
  }
  if (!q.maxTokens && e.includes("max_tokens")) {
    return { ...q, maxTokens: true };
  }
  if (!q.temperature && e.includes("temperature")) {
    return { ...q, temperature: true };
  }
  return;
};
var chatAnswer = (status, text) => {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}, not JSON: ${text.slice(0, 120)}` };
  }
  const err = j.error;
  if (status < 200 || status >= 300 || err !== undefined) {
    const why = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : text.slice(0, 160);
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}: ${why}`, error: why };
  }
  const choice = j.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    const cut = choice?.finish_reason === "length" ? " (cut off at max tokens)" : "";
    return { status, isAnswered: false, reason: `endpoint: empty answer${cut}` };
  }
  return { status, isAnswered: true, text: content };
};
var quirks = new Map;
async function endpointComplete(endpoint, model, key, r, fetcher = fetch) {
  const url = chatUrl(endpoint);
  const headers = {
    "content-type": "application/json",
    ...key === "" ? {} : { authorization: `Bearer ${key}` }
  };
  const hide = (s) => key === "" ? s : s.split(key).join("***");
  const deadline = Date.now() + r.timeoutMs;
  const once = async (q) => {
    const remaining = Math.max(500, deadline - Date.now());
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers,
        body: chatBody(model, r, q),
        signal: AbortSignal.timeout(remaining)
      });
      return chatAnswer(res.status, await res.text());
    } catch (err) {
      const msg = err instanceof Error ? err.name === "TimeoutError" ? `no answer in ${Math.round(r.timeoutMs / 1000)} s` : err.message : String(err);
      return { status: 0, isAnswered: false, reason: `endpoint ${hostOf(endpoint)}: ${msg}` };
    }
  };
  let q = quirks.get(url) ?? NO_QUIRKS;
  for (let attempt = 0;attempt < 4; attempt++) {
    const a = await once(q);
    const next = !a.isAnswered && a.status === 400 && a.error !== undefined ? quirkOf(q, a.error) : undefined;
    if (next === undefined) {
      return a.isAnswered ? { isAnswered: true, text: a.text } : { isAnswered: false, reason: hide(a.reason) };
    }
    q = next;
    quirks.set(url, q);
  }
  return { isAnswered: false, reason: "endpoint: refused every form of the request" };
}

// src/providers.ts
var ENDPOINT_REQUIRED_MESSAGE = "no endpoint configured; set an OpenAI-compatible endpoint with /grammar config endpoint <url> (e.g. http://localhost:11434 for Ollama or https://generativelanguage.googleapis.com/v1beta/openai for Google AI Studio)";
var isProviderReady = (s) => s.endpoint !== "";
var modelName = (s) => s.endpointModel || "the default model";
var checkerOf = (s) => s.endpoint !== "" ? `${modelName(s)} at ${hostOf(s.endpoint)}` : "none (set /grammar config endpoint <url>)";
var completeCoaching = async (s, system, prompt, maxTokens, timeoutMs, completer) => {
  if (s.endpoint === "") {
    return { refused: ENDPOINT_REQUIRED_MESSAGE };
  }
  const req = { model: s.endpointModel, system, prompt, maxTokens, timeoutMs };
  const r = completer !== undefined ? await completer(req) : await endpointComplete(s.endpoint, s.endpointModel, s.endpointKey, req);
  return r.isAnswered ? { text: r.text.trim(), model: modelName(s) } : { refused: r.reason };
};

// src/state.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, statSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
var MAX_FAILS = 3;
var MAX_RECENT_FIXES = 20;
var STALE_SESSION_MS = 7 * 86400000;
var emptySession = (now = Date.now()) => ({
  fails: 0,
  streak: 0,
  recentFixes: [],
  thread: [],
  updatedAt: now
});
var atomicWrite = (path, content) => {
  mkdirSync2(dirname2(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync2(tmp, content, "utf8");
  renameSync2(tmp, path);
};
var safeId = (id) => id.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
var sessionPath = (dataDir, conversationId) => join2(dataDir, "sessions", `${safeId(conversationId)}.json`);
var loadSession = (dataDir, conversationId, now = Date.now()) => {
  const path = sessionPath(dataDir, conversationId);
  if (!existsSync2(path)) {
    return emptySession(now);
  }
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
    return {
      fails: typeof raw.fails === "number" && Number.isFinite(raw.fails) ? raw.fails : 0,
      ...typeof raw.lastError === "string" && raw.lastError !== "" ? { lastError: raw.lastError } : {},
      streak: typeof raw.streak === "number" && Number.isFinite(raw.streak) ? raw.streak : 0,
      recentFixes: Array.isArray(raw.recentFixes) ? raw.recentFixes.slice(0, MAX_RECENT_FIXES) : [],
      thread: Array.isArray(raw.thread) ? raw.thread : [],
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now
    };
  } catch {
    return emptySession(now);
  }
};
var saveSession = (dataDir, conversationId, state, now = Date.now()) => {
  atomicWrite(sessionPath(dataDir, conversationId), JSON.stringify({ ...state, updatedAt: now }, null, 2));
};
var readHistoryFile = (path) => existsSync2(path) ? parseHistory(readFileSync2(path, "utf8")) : EMPTY_HISTORY;
var clearHistoryFile = (path) => {
  atomicWrite(path, historyText(EMPTY_HISTORY));
};

// src/statusline.ts
import { chmodSync as chmodSync2, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync3, statSync as statSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var isRecord2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var homeOf = (env) => (env.HOME ?? env.USERPROFILE ?? homedir2()).replace(/[\\/]+$/, "");
var defaultScriptDir = () => {
  try {
    return dirname3(fileURLToPath(import.meta.url));
  } catch {
    return;
  }
};
var resolveAgySettingsPath = (env = process.env) => {
  const override = env.AGY_CLI_SETTINGS?.trim();
  if (override) {
    return override;
  }
  return join3(homeOf(env), ".gemini", "antigravity-cli", "settings.json");
};
var resolveStatusLineScriptPath = (env = process.env, scriptDir = defaultScriptDir()) => {
  const pluginRoot = env.PLUGIN_ROOT?.trim();
  if (pluginRoot) {
    return join3(pluginRoot.replace(/[\\/]+$/, ""), "dist", "statusline.mjs");
  }
  if (scriptDir) {
    const sibling = join3(scriptDir, "statusline.mjs");
    if (existsSync3(sibling)) {
      return sibling;
    }
  }
  return join3(homeOf(env), ".gemini", "config", "plugins", "prompt-grammar", "dist", "statusline.mjs");
};
var buildStatusLineCommand = (scriptPath, platform = process.platform) => {
  if (platform === "win32") {
    const target = /[\s"&|<>^()]/.test(scriptPath) ? `"${scriptPath.replace(/"/g, "\\\"")}"` : scriptPath;
    return `if exist ${target} node ${target}`;
  }
  const target = /^[a-zA-Z0-9._/@:-]+$/.test(scriptPath) ? scriptPath : `'${scriptPath.replace(/'/g, "'\\''")}'`;
  return `[ ! -f ${target} ] || exec node ${target}`;
};
var isPromptGrammarStatusLine = (cmd) => typeof cmd === "string" && /prompt-grammar.*statusline\.mjs|statusline\.mjs/.test(cmd);
var readAgySettings = (settingsPath) => {
  if (!existsSync3(settingsPath)) {
    return { exists: false, raw: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync3(settingsPath, "utf8"));
    if (!isRecord2(parsed)) {
      return { exists: true, raw: {}, error: "not a JSON object" };
    }
    return { exists: true, raw: parsed };
  } catch (err) {
    return { exists: true, raw: {}, error: err instanceof Error ? err.message : String(err) };
  }
};
var isStatusLineActive = (env = process.env) => {
  const parsed = readAgySettings(resolveAgySettingsPath(env));
  if (parsed.error !== undefined) {
    return false;
  }
  const sl = isRecord2(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined;
  if (sl === undefined || sl.enabled === false) {
    return false;
  }
  return isPromptGrammarStatusLine(sl.command);
};
var writeSettingsAtomic = (settingsPath, obj) => {
  let mode = 384;
  if (existsSync3(settingsPath)) {
    try {
      mode = statSync2(settingsPath).mode & 511;
    } catch {}
  }
  mkdirSync3(dirname3(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync3(tmp, `${JSON.stringify(obj, null, 2)}
`, { encoding: "utf8", mode });
  try {
    chmodSync2(tmp, mode);
  } catch {}
  renameSync3(tmp, settingsPath);
};
var statusLineStatus = (paths, env = process.env, opts) => {
  const { settings } = loadConfigAndLists(paths, env);
  const settingsPath = resolveAgySettingsPath(env);
  const parsed = readAgySettings(settingsPath);
  const scriptPath = resolveStatusLineScriptPath(env, opts?.scriptDir);
  const displayLine = settings.display === "auto" ? "Display: auto (statusline in CLI when installed, reply in IDE/Desktop)" : `Display: ${settings.display}`;
  const lines = [displayLine, `Settings file: ${settingsPath}`];
  if (parsed.error !== undefined) {
    lines.push(`Status line: unreadable (${parsed.error})`);
    return lines.join(`
`);
  }
  const sl = isRecord2(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined;
  const cmd = typeof sl?.command === "string" ? sl.command.trim() : "";
  if (cmd === "") {
    lines.push("Status line: not installed.");
    lines.push(`Run /grammar statusline install to configure ${scriptPath}.`);
  } else if (isPromptGrammarStatusLine(cmd)) {
    const enabled = sl?.enabled !== false;
    const stacked = sl?.stack_with_default === true;
    lines.push(`Status line: installed (${enabled ? "enabled" : "disabled"}, stack_with_default: ${stacked}).`);
    lines.push(`Command: ${cmd}`);
    if (settings.display !== "statusline" && settings.display !== "auto") {
      lines.push('Note: display is currently not "auto" or "statusline"; run /grammar config display auto to activate.');
    }
  } else {
    lines.push(`Status line: another command is configured (${cmd}).`);
    lines.push("Run /grammar statusline install --force to replace it with prompt-grammar.");
  }
  return lines.join(`
`);
};
var installStatusLine = (paths, env = process.env, opts) => {
  const settingsPath = resolveAgySettingsPath(env);
  const parsed = readAgySettings(settingsPath);
  if (parsed.error !== undefined) {
    return `${settingsPath} does not parse (${parsed.error}), so it was left untouched. Fix it by hand.`;
  }
  const existingSl = isRecord2(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined;
  const existingCmd = typeof existingSl?.command === "string" ? existingSl.command.trim() : "";
  const scriptPath = resolveStatusLineScriptPath(env, opts?.scriptDir);
  const command = buildStatusLineCommand(scriptPath);
  if (existingCmd !== "" && !isPromptGrammarStatusLine(existingCmd) && !opts?.force) {
    return [
      `${settingsPath} already configures another statusLine command: ${existingCmd}`,
      "Run /grammar statusline install --force to overwrite it, or merge manually:",
      JSON.stringify({ statusLine: { type: "command", command, stack_with_default: true, padding: 0, enabled: true } }, null, 2)
    ].join(`
`);
  }
  const displayRes = writeGlobalField(paths.globalConfig, "display", "auto");
  if (!displayRes.ok) {
    return displayRes.error;
  }
  const nextSettings = {
    ...parsed.raw,
    statusLine: {
      type: "command",
      command,
      stack_with_default: true,
      padding: 0,
      enabled: true
    }
  };
  writeSettingsAtomic(settingsPath, nextSettings);
  return [
    `Installed prompt-grammar statusLine in ${settingsPath} (stack_with_default: true).`,
    `Updated display = auto in ${paths.globalConfig} (statusline in CLI, reply in IDE/Desktop).`,
    `Command: ${command}`
  ].join(`
`);
};
var uninstallStatusLine = (paths, env = process.env) => {
  const settingsPath = resolveAgySettingsPath(env);
  const parsed = readAgySettings(settingsPath);
  const { settings } = loadConfigAndLists(paths, env);
  const notes = [];
  if (!parsed.exists) {
    notes.push(`${settingsPath} not found; nothing to remove there.`);
  } else if (parsed.error !== undefined) {
    return `${settingsPath} does not parse (${parsed.error}), so it was left untouched.`;
  } else {
    const existingSl = isRecord2(parsed.raw.statusLine) ? parsed.raw.statusLine : undefined;
    const existingCmd = typeof existingSl?.command === "string" ? existingSl.command.trim() : "";
    if (existingCmd !== "" && isPromptGrammarStatusLine(existingCmd)) {
      const nextSettings = {
        ...parsed.raw,
        statusLine: {
          type: "",
          command: "",
          enabled: true
        }
      };
      writeSettingsAtomic(settingsPath, nextSettings);
      notes.push(`Removed prompt-grammar statusLine from ${settingsPath}.`);
    } else if (existingCmd !== "") {
      notes.push(`Left ${settingsPath} untouched (statusLine is configured by another command: ${existingCmd}).`);
    } else {
      notes.push(`No prompt-grammar statusLine configured in ${settingsPath}.`);
    }
  }
  if (settings.display === "statusline" || settings.display === "auto") {
    const displayRes = writeGlobalField(paths.globalConfig, "display", "reply");
    if (!displayRes.ok) {
      return `${notes.join(`
`)}
${displayRes.error}`;
    }
    notes.push(`Reset display = reply in ${paths.globalConfig}.`);
  }
  return notes.join(`
`);
};

// src/commands.ts
var capital = (w) => w.charAt(0).toUpperCase() + w.slice(1);
var plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
var languageName = (s) => s.language === AUTO ? "grammar" : joinNames(languagesOf(s.language), "and");
var usage = (s) => [
  `/grammar help: this list, and what is on now`,
  `/grammar [on|off]: the ${languageName(s)} check of your prompts`,
  `/grammar natural [on|off]: the native-speaker line`,
  `/grammar ignore add <words>: never flag these (phrases: separate with commas)`,
  `/grammar ignore rm <words>: flag them again`,
  `/grammar ignore: the ignore and skip lists, and their files`,
  `/grammar stats [7d|30d|since 2026-10-01] [language]: your most frequent mistakes, from the kept fixes`,
  `/grammar review [7d|30d|since 2026-10-01] [language]: a summary, then advice on them from ${modelName(s)} (one call, from ${REVIEW_FROM} fixes)`,
  `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s)} about your writing, with your fixes at hand (one call)`,
  `/grammar ask list|clear: what follow-ups remember (the last ${ASK_MEMORY} asks and reviews), or forget it`,
  `/grammar ask memory [on|off]: remembering asks for follow-ups`,
  `/grammar history [on|off|clear]: keeping fixes for stats and review`,
  `/grammar statusline [install|uninstall]: configure Antigravity CLI statusLine band (0 ms, ANSI colors)`,
  `/grammar config [key] [value]: view or update settings in ~/.gemini/config/grammar.json`
].join(`
`);
var withLanguages = (text, h) => {
  const all = languagesIn(h);
  return all.length > 1 ? `${text} Languages kept: ${all.map((l) => l.lang).join(", ")}.` : text;
};
var forLanguage = (h, words, s) => {
  const { lang, rest } = splitLanguage(words, languagesIn(h).map((l) => l.lang));
  return { ...pickLanguage(h, lang, s.language), rest };
};
var parseConfigValue = (key, rawVal) => {
  const v = rawVal.trim();
  if (v === "reset" || v === "default" || v === "unset") {
    return { ok: true, value: undefined };
  }
  switch (key) {
    case "enabled":
    case "natural":
    case "show_why":
    case "history":
    case "clean":
    case "ask_memory":
      if (v === "true" || v === "on")
        return { ok: true, value: true };
      if (v === "false" || v === "off")
        return { ok: true, value: false };
      return { ok: false, error: `${key} expects true|false or on|off.` };
    case "dialect":
      if (v === "any" || v === "us" || v === "uk")
        return { ok: true, value: v };
      return { ok: false, error: `dialect expects any, us, or uk.` };
    case "display": {
      const mode = normalizeDisplay(v);
      if (mode !== undefined)
        return { ok: true, value: mode };
      return { ok: false, error: `display expects reply, auto, async, system, statusline, or user_markdown.` };
    }
    case "min_words": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 50)
        return { ok: false, error: `min_words expects an integer 1..50.` };
      return { ok: true, value: n };
    }
    case "max_chars": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 200 || n > 20000)
        return { ok: false, error: `max_chars expects an integer 200..20000.` };
      return { ok: true, value: n };
    }
    case "timeout_ms": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 2000 || n > 120000)
        return { ok: false, error: `timeout_ms expects an integer 2000..120000.` };
      return { ok: true, value: n };
    }
    case "language": {
      const parsed = languageSetting(v);
      if (parsed === undefined)
        return { ok: false, error: `Invalid language "${v}".` };
      return { ok: true, value: parsed };
    }
    case "endpoint":
    case "endpoint_model":
    case "endpoint_key":
      return { ok: true, value: v === '""' || v === "''" ? "" : v };
    default:
      return { ok: false, error: `Unknown setting "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}.` };
  }
};
var runCommand = async ({
  args,
  conversationId,
  paths,
  now = Date.now(),
  completer,
  env = process.env,
  effectiveDisplay
}) => {
  const { settings: s, lists, projectAllowsHistory } = loadConfigAndLists(paths, env);
  const session = loadSession(paths.dataDir, conversationId, now);
  const trimmed = args.trim();
  const [first = "", ...rest] = trimmed === "" ? [] : trimmed.split(/\s+/);
  const sub = (rest[0] ?? "").toLowerCase();
  const loadHistorySafe = () => {
    try {
      const h = readHistoryFile(paths.historyFile);
      return { h, ignore: compileIgnore(lists.ignore) };
    } catch (err) {
      return `${paths.historyFile} does not parse (${err instanceof Error ? err.message : String(err)}). Fix it by hand, or /grammar history clear to start over.`;
    }
  };
  const remember = (q, a) => {
    if (!s.askMemory) {
      return;
    }
    session.thread = [...session.thread, { q: cut(q, MAX_QUESTION), a: cut(a, MAX_ANSWER) }].slice(-ASK_MEMORY);
    saveSession(paths.dataDir, conversationId, session, now);
  };
  switch (first.toLowerCase()) {
    case "help":
    case "?": {
      const paused = session.fails >= MAX_FAILS;
      const check = !s.enabled ? "off" : paused ? `paused after ${MAX_FAILS} failures (/grammar on resumes)${session.lastError ? ` — last error: ${session.lastError}` : ""}` : !isProviderReady(s) ? "on, waiting for endpoint (run /grammar config endpoint <url>)" : session.fails > 0 && session.lastError ? `on (${session.fails} recent failure${session.fails === 1 ? "" : "s"}: ${session.lastError})` : "on";
      const loaded = loadHistorySafe();
      const n = typeof loaded === "string" ? 0 : visible(loaded.h, loaded.ignore).length;
      const displayDesc = s.display === "auto" ? `auto (${effectiveDisplay ?? (isStatusLineActive(env) ? "statusline in CLI, reply in IDE/Desktop" : "reply")})` : s.display;
      const status = [
        `Check: ${check}. Natural line: ${s.natural ? "on" : "off"}. Display: ${displayDesc}.`,
        `Language: ${s.language === AUTO ? "auto (each prompt in its own language)" : languagesOf(s.language).length > 1 ? `${s.language} (each prompt in one of them)` : s.language}.`,
        `Model: ${checkerOf(s)}, spelling ${s.dialect}, at least ${s.minWords} words, up to ${s.maxChars} characters.`,
        `History: ${s.history ? "on" : "off"}, ${n} fixes kept${n >= REVIEW_FROM ? "" : ` (/grammar review from ${REVIEW_FROM})`}.`,
        s.askMemory ? `Ask memory: on, ${plural(session.thread.length, "exchange")} remembered (/grammar ask list).` : "Ask memory: off."
      ];
      return `${status.join(`
`)}

${usage(s)}`;
    }
    case "":
    case "on":
    case "off": {
      const want = first.toLowerCase() === "on" ? true : first.toLowerCase() === "off" ? false : !s.enabled;
      const res = writeGlobalField(paths.globalConfig, "enabled", want);
      if (!res.ok) {
        return res.error;
      }
      if (want) {
        session.fails = 0;
        saveSession(paths.dataDir, conversationId, session, now);
      }
      if (!want) {
        return `${capital(languageName(s))} check off.`;
      }
      if (!isProviderReady(s)) {
        return `${capital(languageName(s))} check on, waiting for endpoint (run /grammar config endpoint <url>).`;
      }
      return `${capital(languageName(s))} check on: ${checkerOf(s)} checks each prompt you send${s.language === AUTO ? ", in its own language" : ""}.`;
    }
    case "natural": {
      if (sub !== "" && sub !== "on" && sub !== "off") {
        return usage(s);
      }
      const want = sub === "on" ? true : sub === "off" ? false : !s.natural;
      const res = writeGlobalField(paths.globalConfig, "natural", want);
      if (!res.ok) {
        return res.error;
      }
      return want ? "Natural phrasing on: the check also says when a native speaker would put it differently." : "Natural phrasing off: grammar fixes only.";
    }
    case "ignore": {
      const words = entriesFrom(rest.slice(1).join(" "));
      if (sub === "" || sub === "list") {
        const files = [paths.globalConfig, paths.projectConfig].filter((p) => p !== undefined);
        const lines = [];
        for (const file of [...new Set(files)]) {
          const parsed = readRawConfig(file);
          const l = parsed.error === undefined ? parseLists(JSON.stringify(parsed.raw)) : { ignore: [], skip: [], history: true };
          lines.push(`${file}
  ignore: ${l.ignore.length > 0 ? l.ignore.join(", ") : "none"}
  skip: ${l.skip.length > 0 ? l.skip.join(", ") : "none"}`);
        }
        return lines.join(`
`);
      }
      if ((sub === "add" || sub === "rm") && words.length > 0) {
        const existing = readRawConfig(paths.globalConfig);
        if (existing.error !== undefined) {
          return `${paths.globalConfig} does not parse (${existing.error}), so it was left as it is. Fix it by hand.`;
        }
        const current = parseLists(JSON.stringify(existing.raw)).ignore;
        const lower = new Set(words.map((w) => w.toLowerCase()));
        const next = sub === "add" ? [...new Set([...current, ...words])] : current.filter((w) => !lower.has(w.toLowerCase()));
        const res = writeGlobalField(paths.globalConfig, "ignore", next);
        if (!res.ok) {
          return res.error;
        }
        const list = words.map((w) => JSON.stringify(w)).join(", ");
        return sub === "add" ? `Never flagged now: ${list}. Kept in ${paths.globalConfig}.` : `Flagged again: ${list}. Kept in ${paths.globalConfig}.`;
      }
      return usage(s);
    }
    case "stats": {
      const loaded = loadHistorySafe();
      if (typeof loaded === "string") {
        return loaded;
      }
      const words = rest.join(" ");
      const picked = forLanguage(loaded.h, words, s);
      const period = parsePeriod(picked.rest, now);
      if (typeof period === "string") {
        return withLanguages(period, loaded.h);
      }
      const others = picked.others.map((o) => ({ lang: o.lang, fixes: visible(within(inLanguage(loaded.h, o.lang), period), loaded.ignore).length })).filter((o) => o.fixes > 0);
      const h = loaded.h.fixes.length + loaded.h.days.length === 0 ? loaded.h : inLanguage(loaded.h, picked.lang);
      const language = picked.show ? picked.lang : undefined;
      return statsText(h, loaded.ignore, now, paths.historyFile, s.history, period, words, modelName(s), language, others);
    }
    case "review": {
      const loaded = loadHistorySafe();
      if (typeof loaded === "string") {
        return loaded;
      }
      const words = rest.join(" ");
      const picked = forLanguage(loaded.h, words, s);
      const period = parsePeriod(picked.rest, now);
      if (typeof period === "string") {
        return withLanguages(period, loaded.h);
      }
      const h = inLanguage(loaded.h, picked.lang);
      const fixes = visible(within(h, period), loaded.ignore);
      if (fixes.length < REVIEW_FROM) {
        const longer = period.before === undefined ? "" : " Try a longer period.";
        const where = picked.show ? ` in ${picked.lang}` : "";
        return `Not enough to go on yet: ${fixes.length} fixes kept${where} for ${period.label}, the review starts at ${REVIEW_FROM}.${longer} /grammar stats shows them so far.`;
      }
      const summary = summaryOf(h, loaded.ignore, period, now, picked.show ? picked.lang : undefined);
      const r = await completeCoaching(s, reviewSystem(picked.lang), reviewInput(fixes), 8000, 180000, completer);
      if ("refused" in r) {
        return `No review: ${r.refused}`;
      }
      remember(`/grammar review ${words}`.trim(), r.text);
      return formatReviewMarkdown(summary, r.text, r.model, s.askMemory);
    }
    case "ask": {
      const rawTail = trimmed.slice(first.length).trim();
      const lower = rawTail.toLowerCase();
      const askList = () => {
        if (!s.askMemory) {
          return "Ask memory: off. Each /grammar ask starts fresh. /grammar ask memory on remembers asks for follow-ups.";
        }
        if (session.thread.length === 0) {
          return `Ask memory: on, nothing remembered yet. Each /grammar ask and /grammar review is remembered for follow-ups, the last ${ASK_MEMORY}.`;
        }
        const short = (t) => {
          const line = t.replace(/\s+/g, " ").trim();
          return line.length > 90 ? `${cut(line, 90)}…` : line;
        };
        return [
          `Ask memory: on. Follow-ups remember ${plural(session.thread.length, "exchange")}, oldest first (the last ${ASK_MEMORY} are kept):`,
          ...session.thread.map((t, i) => `${i + 1}. ${short(t.q)}
   ${short(t.a)}`),
          "/grammar ask clear forgets them; /grammar ask memory off stops remembering. Gone when the session ends."
        ].join(`
`);
      };
      if (lower === "" || lower === "help") {
        const how = `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s)} about your writing, with your kept fixes at hand.
/grammar ask list|clear, /grammar ask memory on|off.`;
        return `${how}

${askList()}`;
      }
      if (lower === "list") {
        return askList();
      }
      if (lower === "clear") {
        const n = session.thread.length;
        session.thread = [];
        saveSession(paths.dataDir, conversationId, session, now);
        return n === 0 ? "Nothing remembered, nothing to forget." : `Forgot ${plural(n, "exchange")}: the next /grammar ask starts fresh.`;
      }
      const mem = /^memory(?:\s+(on|off))?$/.exec(lower);
      if (mem !== null) {
        const want = mem[1] === "on" ? true : mem[1] === "off" ? false : !s.askMemory;
        const res = writeGlobalField(paths.globalConfig, "ask_memory", want);
        if (!res.ok) {
          return res.error;
        }
        const n = session.thread.length;
        if (!want && n > 0) {
          session.thread = [];
          saveSession(paths.dataDir, conversationId, session, now);
        }
        return want ? `Ask memory on: follow-ups remember the last ${ASK_MEMORY} asks and reviews of the session. /grammar ask list shows them.` : `Ask memory off: each /grammar ask starts fresh${n > 0 ? `, and the ${plural(n, "remembered exchange")} ${n === 1 ? "is" : "are"} forgotten` : ""}.`;
      }
      const split = splitAsk(rawTail, now);
      if (typeof split === "string") {
        return split;
      }
      if (split.question === "") {
        return "Ask what? /grammar ask 7d which prepositions do I mix up?";
      }
      const question = cut(split.question, MAX_QUESTION);
      const loaded = loadHistorySafe();
      const fixes = typeof loaded === "string" ? [] : visible(within(loaded.h, split.period), loaded.ignore);
      const recent = session.recentFixes.slice(0, ASK_RECENT);
      const turns = s.askMemory ? session.thread : [];
      const r = await completeCoaching(s, ASK_SYSTEM, askInput(fixes, split.period.label, recent, turns, question), 4000, 120000, completer);
      if ("refused" in r) {
        return `No answer: ${r.refused}`;
      }
      remember(question, r.text);
      const memoryNote = !s.askMemory ? "memory off, each ask starts fresh" : turns.length === 0 ? "follow-ups remember this · /grammar ask clear forgets" : `remembered ${turns.length} earlier · /grammar ask list, clear`;
      const footer = `${r.model}, from ${plural(fixes.length, "fix", "fixes")} · ${memoryNote}`;
      return `${formatAdviceMarkdown(r.text)}

*${footer}*`;
    }
    case "history": {
      if (sub === "clear") {
        if (!existsSync4(paths.historyFile)) {
          return "Nothing kept, nothing to clear.";
        }
        clearHistoryFile(paths.historyFile);
        return `Cleared: ${paths.historyFile} holds no fixes now.`;
      }
      if (sub === "on" || sub === "off") {
        const want = sub === "on";
        const res = writeGlobalField(paths.globalConfig, "history", want);
        if (!res.ok) {
          return res.error;
        }
        return want ? `History on: each fix is kept in ${paths.historyFile} for /grammar stats and /grammar review.` : `History off: no new fixes are kept. What ${paths.historyFile} holds stays; /grammar history clear empties it.`;
      }
      if (sub !== "") {
        return usage(s);
      }
      const loaded = loadHistorySafe();
      if (typeof loaded === "string") {
        return `History: ${s.history ? "on" : "off"}. ${loaded}`;
      }
      return [
        `History: ${s.history ? "on" : "off"}${s.history && !projectAllowsHistory ? ', but off in this project (its .agents/grammar.json says "history": false)' : ""}.`,
        `${visible(loaded.h, loaded.ignore).length} fixes kept in ${paths.historyFile}: the last ${KEEP_DAYS} days, up to ${MAX_ENTRIES}.`,
        "/grammar history on|off switches it; /grammar history clear empties the file."
      ].join(`
`);
    }
    case "statusline": {
      if (sub === "" || sub === "status") {
        return statusLineStatus(paths, env);
      }
      if (sub === "install") {
        return installStatusLine(paths, env, { force: rest.slice(1).includes("--force") });
      }
      if (sub === "uninstall" || sub === "remove" || sub === "off") {
        return uninstallStatusLine(paths, env);
      }
      return usage(s);
    }
    case "config": {
      if (rest.length === 0) {
        return [
          `Config file: ${paths.globalConfig}`,
          ...paths.projectConfig && existsSync4(paths.projectConfig) ? [`Project file: ${paths.projectConfig}`] : [],
          `enabled: ${s.enabled}`,
          `natural: ${s.natural}`,
          `language: ${s.language}`,
          `dialect: ${s.dialect}`,
          `min_words: ${s.minWords}`,
          `max_chars: ${s.maxChars}`,
          `show_why: ${s.showWhy}`,
          `history: ${s.history}`,
          `clean: ${s.clean}`,
          `ask_memory: ${s.askMemory}`,
          `display: ${s.display}`,
          `timeout_ms: ${s.timeoutMs}`,
          `endpoint: ${s.endpoint || "(none)"}`,
          `endpoint_model: ${s.endpointModel || "(default)"}`,
          `endpoint_key: ${s.endpointKey ? "(set)" : "(none)"}`,
          "",
          `Set with: /grammar config <key> <value> (or \`unset\` to reset).`
        ].join(`
`);
      }
      const key = (rest[0] ?? "").toLowerCase();
      const rawVal = rest.slice(1).join(" ");
      if (rawVal === "") {
        return `Usage: /grammar config <key> <value>. Valid keys: ${CONFIG_KEYS.join(", ")}.`;
      }
      const parsed = parseConfigValue(key, rawVal);
      if (!parsed.ok) {
        return parsed.error;
      }
      const res = writeGlobalField(paths.globalConfig, key, parsed.value);
      if (!res.ok) {
        return res.error;
      }
      const shown = key === "endpoint_key" && parsed.value ? "***" : parsed.value === undefined ? "(default)" : String(parsed.value);
      let hint = "";
      if (key === "display" && parsed.value === "statusline" && !isStatusLineActive(env)) {
        hint = `
Run /grammar statusline install to configure Antigravity CLI statusLine.`;
      }
      return `Updated ${key} = ${shown} in ${paths.globalConfig}.${hint}`;
    }
    default:
      return usage(s);
  }
};

// scripts/cli.ts
var main = async () => {
  const args = process.argv.slice(2).join(" ");
  const paths = resolvePaths(process.cwd());
  const output = await runCommand({
    args: args === "" ? "help" : args,
    conversationId: process.env.PROMPT_GRAMMAR_SESSION ?? "cli",
    paths
  });
  process.stdout.write(`${output}
`);
};
await main();
