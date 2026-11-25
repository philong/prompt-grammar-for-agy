#!/usr/bin/env node

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
var keptLanguage = (setting, said) => {
  const names = languagesOf(setting);
  if (names.length === 0) {
    return said;
  }
  if (names.length === 1) {
    return setting;
  }
  const words = ` ${said.toLowerCase()} `;
  return names.find((n) => n.toLowerCase() === said.toLowerCase()) ?? [...names].sort((a, b) => b.length - a.length).find((n) => words.includes(` ${n.toLowerCase()} `));
};
var LETTERS = /\p{L}{2}/u;
var lettersFor = (setting) => setting === ENGLISH ? /[A-Za-z]{2}/ : LETTERS;
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
var compileSkip = (entries) => entries.flatMap((entry) => {
  const re = regexOf(entry);
  if (re !== null) {
    return re === undefined ? [] : [re];
  }
  try {
    return [new RegExp(entry, "i")];
  } catch {
    return [];
  }
});
var UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
var wordCount = (text) => {
  const unspaced = (text.match(UNSPACED) ?? []).reduce((n, run) => n + Math.ceil([...run].length / 2), 0);
  return unspaced + (text.replace(UNSPACED, " ").match(/\p{L}+(['’]\p{L}+)*/gu) ?? []).length;
};
var cut = (text, max) => {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const space = head.search(/\s\S*$/);
  return space > max / 2 ? head.slice(0, space) : head;
};
var applyFixes = (text, fixes) => fixes.reduce((t, f) => {
  const i = t.toLowerCase().indexOf(f.from.toLowerCase());
  return i < 0 ? t : t.slice(0, i) + f.to + t.slice(i + f.from.length);
}, text);
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
var MAX_LEN = 60;
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
var CODEISH = /[/\\_(){}[\]<>=`@#$|~]|\w\.\w|(^|\s)\.\w/;
var norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
var changesWords = (f) => norm(f.from) !== norm(f.to);
var keepable = (f) => f.from.trim() !== "" && f.from.length <= MAX_LEN && f.to.length <= MAX_LEN && changesWords(f) && !CODEISH.test(f.from) && !CODEISH.test(f.to);
var oldestDay = (now) => dayOf(now - (KEEP_DAYS - 1) * DAY_MS);
var prune = (h, now) => {
  const sinceDay = oldestDay(now);
  const since = Date.parse(`${sinceDay}T00:00:00Z`);
  return {
    version: 1,
    fixes: h.fixes.filter((f) => f.at >= since).slice(-MAX_ENTRIES),
    days: h.days.filter((d) => d.day >= sinceDay).sort((a, b) => a.day.localeCompare(b.day) || langOf(a).localeCompare(langOf(b)))
  };
};
var record = (h, fixes, now, lang = ENGLISH) => {
  const day = dayOf(now);
  const field = langField(lang);
  const mine = (d) => d.day === day && langOf(d) === langOf(field);
  const today = h.days.find(mine);
  const days = [
    ...h.days.filter((d) => !mine(d)),
    { day, checked: (today?.checked ?? 0) + 1, withFixes: (today?.withFixes ?? 0) + (fixes.length > 0 ? 1 : 0), ...field }
  ];
  const kept = fixes.filter(keepable).map((f) => ({ from: f.from.trim(), to: f.to.trim(), why: f.why.trim(), kind: kindOf(f.kind), at: now, ...field }));
  return prune({ version: 1, fixes: [...h.fixes, ...kept], days }, now);
};

// src/check.ts
var MAX_PROMPT_WORDS = 100;
var ENGLISH_BASE = `You proofread English that a non-native speaker typed as a prompt to a coding assistant.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase "i" or sentence start is fine), punctuation style, apostrophes left out of contractions (lets, dont, im, thats), a casual tone, slang and short forms (smth, pls, u, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`;
var base = (language) => {
  const names = languagesOf(language);
  return `${names.length === 0 ? "You proofread a prompt typed to a coding assistant, in whatever language it is written in; the writer may not be a native speaker of it." : names.length > 1 ? `You proofread a prompt typed to a coding assistant in ${joinNames(names)}; the writer may not be a native speaker of it.` : `You proofread ${language} that a non-native speaker typed as a prompt to a coding assistant.`}
Check the text in its main language. Words from another language mixed in (English technical terms, say) are fine as they are.
Report only real mistakes: spelling and typos, grammar (tense, agreement, articles, prepositions, word order and the like), a wrong word, a missing word.
Ignore all of these: capitalization (a lowercase sentence start, or "i" in English, is fine), punctuation style, apostrophes left out of contractions (lets, dont, im), a casual tone, slang and chat short forms (smth, pls, btw, lol, etc), code, commands, file paths, identifiers, URLs, logs, and quoted or pasted text.
Keep the writer's voice: change as few words as possible, never rephrase for style.`;
};
var DIALECT = {
  any: "Accept American and British spelling alike.",
  us: "The writer uses American English: a British spelling (colour, organise) is a spelling mistake.",
  uk: "The writer uses British English: an American spelling (color, organize) is a spelling mistake."
};
var dialectRule = (language, dialect) => language === ENGLISH ? [DIALECT[dialect]] : language === AUTO || languagesOf(language).includes(ENGLISH) ? [`In English text: ${DIALECT[dialect]}`] : [];
var KIND = `, "kind": "<one of: ${KINDS.join(", ")}>"`;
var answer = (language, showWhy, kind) => {
  const fix = (why) => `[{"from": "<exact words from the text>", "to": "<the fixed words>"${showWhy ? `, "why": "<2 to 4 words${why}>"` : ""}${kind ? KIND : ""}}]`;
  if (language === ENGLISH) {
    return `Answer with JSON only, no prose and no code fence:
{"english": true, "fixes": ${fix("")}}
"fixes" is [] when the English is fine. If the text is not mainly English, answer {"english": false, "fixes": []}.`;
  }
  const names = languagesOf(language);
  const named = names.length === 0 ? "<its main language, named in English>" : names.length > 1 ? `<its main language: ${joinNames(names)}>` : language;
  const other = names.length === 0 ? 'If the text holds no natural language (only code, say), answer {"language": null, "fixes": []}.' : `If the text is not mainly ${joinNames(names)}, answer {"language": null, "fixes": []}.`;
  return `Answer with JSON only, no prose and no code fence:
{"language": "${named}", "fixes": ${fix(", in the text's language")}}
"fixes" is [] when the text is fine. ${other}`;
};
var ENGLISH_KIND_RULE = `For "kind": article is a missing, extra or wrong a, an or the; missing word and extra word are for any other word.`;
var KIND_RULE = `For "kind": article is a missing, extra or wrong article (a, an, the; le, la, un; der, die, das); missing word and extra word are for any other word; a wrong gender or case ending is agreement.`;
var ENGLISH_NATURAL = `Also add "natural" to the JSON: null in most cases. Only when a native speaker would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`;
var NATURAL = `Also add "natural" to the JSON: null in most cases. Only when a native speaker of the text's language would clearly say a sentence differently (an unidiomatic phrase, a word-for-word translation), even with the grammar fixed, give that one sentence the way a native speaker would say it, in the same language: same meaning, same casual tone, the writer's own casing.
Never use "natural" for style taste, for a sentence that is fine once the fixes are applied, or for code.`;
var system = ({ natural, language = ENGLISH, dialect = "any", showWhy = true, kind = true, ignore = [] }) => {
  const words = ignore.slice(0, MAX_PROMPT_WORDS);
  const never = words.length > 0 ? [`Never flag these, the writer means them as written: ${words.map((w) => JSON.stringify(w)).join(", ")}.`] : [];
  const english = language === ENGLISH;
  return [
    english ? ENGLISH_BASE : base(language),
    ...dialectRule(language, dialect),
    ...never,
    answer(language, showWhy, kind),
    ...kind ? [english ? ENGLISH_KIND_RULE : KIND_RULE] : [],
    ...natural ? [english ? ENGLISH_NATURAL : NATURAL] : []
  ].join(`
`);
};
var isFix = (x) => {
  const f = x;
  return typeof f?.from === "string" && typeof f.to === "string";
};
var parseReply = (text, fallback) => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON in the reply");
  }
  const reply = JSON.parse(text.slice(start, end + 1));
  if (reply.language === null || reply.english === false) {
    return null;
  }
  if (!Array.isArray(reply.fixes)) {
    throw new Error("no fixes in the reply");
  }
  const said = languageOf(reply.language);
  const language = said !== undefined && said !== AUTO ? said : reply.english === true ? ENGLISH : fallback;
  if (language === undefined) {
    throw new Error("no language in the reply");
  }
  const fixes = reply.fixes.filter(isFix).filter((f) => f.from.trim() !== f.to.trim()).map((f) => ({ from: f.from, to: f.to, why: typeof f.why === "string" ? f.why : "", kind: kindOf(f.kind) }));
  const natural = typeof reply.natural === "string" && reply.natural.trim() !== "" ? reply.natural.trim() : null;
  return { fixes, natural, language };
};
var fallbackFor = (setting) => languagesOf(setting).length === 1 ? setting : undefined;
var keepFixes = (fixes, text, ignore) => {
  const lower = text.toLowerCase();
  return fixes.filter((f) => f.from.trim() !== "" && lower.includes(f.from.toLowerCase()) && !isIgnored(ignore, f.from));
};
var same = (a, b) => {
  const plain = (s) => s.trim().toLowerCase().replace(/[.!?]+$/, "");
  return plain(a) === plain(b);
};
var usefulNatural = (natural, text, fixes, ignore = { words: [], matchers: [] }) => {
  if (natural === null || same(natural, text) || same(natural, applyFixes(text, fixes))) {
    return null;
  }
  const lower = natural.toLowerCase();
  const dropsKept = ignore.words.some((w) => text.toLowerCase().includes(w.toLowerCase()) && !lower.includes(w.toLowerCase()));
  return dropsKept ? null : natural;
};
var ANSWERS = /(^|\n\n)Answers? to your question/;
var USER_REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
var typedPart = (text) => {
  const wrapped = USER_REQUEST.exec(text);
  const inner = wrapped !== null ? wrapped[1] ?? "" : text;
  const m = ANSWERS.exec(inner);
  return (m === null ? inner : inner.slice(0, m.index)).trim();
};

// src/format.ts
var STREAK_FROM = 3;
var CHECK = "✓";
var LOGO = "✎";
var NATURAL2 = "↳";
var plainFixes = (fixes, natural, showWhy) => {
  const list = fixes.map((f) => `${f.from} → ${f.to === "" ? "(remove)" : f.to}${showWhy && f.why !== "" ? ` (${f.why})` : ""}`);
  return `${list.join("  ·  ")}${natural === null ? "" : `${list.length > 0 ? `
` : ""}${NATURAL2} ${natural}`}`;
};
var markdownFixes = (fixes, natural, showWhy) => {
  const list = fixes.map((f) => {
    const fixed = f.to === "" ? "*(remove)*" : `**${f.to}**`;
    const why = showWhy && f.why !== "" ? ` *(${f.why})*` : "";
    return `~~${f.from}~~ ${fixed}${why}`;
  });
  const lines = [];
  if (list.length > 0) {
    lines.push(`${LOGO} ${list.join("  ·  ")}`);
  }
  if (natural !== null) {
    lines.push(`${NATURAL2} *${natural}*`);
  }
  return lines.join(`
`);
};
var cleanText = (n) => `${CHECK} no mistakes${n >= STREAK_FROM ? ` · ${n} in a row` : ""}`;
var sanitizeTerminalText = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
var ansiFixes = (fixes, natural, showWhy) => {
  const list = fixes.map((f) => {
    const from = sanitizeTerminalText(f.from);
    const to = sanitizeTerminalText(f.to);
    const why = sanitizeTerminalText(f.why);
    const reason = showWhy && why !== "" ? ` \x1B[2m(${why})\x1B[0m` : "";
    return to === "" ? `\x1B[31;9m${from}\x1B[0m \x1B[2m(remove)\x1B[0m${reason}` : `\x1B[32m${to}\x1B[0m${reason}`;
  });
  const lines = [];
  if (list.length > 0) {
    lines.push(`\x1B[36m${LOGO}\x1B[0m ${list.join("\x1B[2m  ·  \x1B[0m")}`);
  }
  if (natural !== null) {
    const nat = sanitizeTerminalText(natural);
    if (nat !== "") {
      lines.push(`\x1B[36m${NATURAL2}\x1B[0m \x1B[2;3m${nat}\x1B[0m`);
    }
  }
  return lines.join(`
`);
};
var statusLinePlainFixes = (fixes, natural, showWhy) => {
  const list = fixes.map((f) => {
    const from = sanitizeTerminalText(f.from);
    const to = sanitizeTerminalText(f.to);
    const why = sanitizeTerminalText(f.why);
    const reason = showWhy && why !== "" ? ` (${why})` : "";
    return to === "" ? `${from} (remove)${reason}` : `${to}${reason}`;
  });
  const lines = [];
  if (list.length > 0) {
    lines.push(`${LOGO} ${list.join("  ·  ")}`);
  }
  if (natural !== null) {
    const nat = sanitizeTerminalText(natural);
    if (nat !== "") {
      lines.push(`${NATURAL2} ${nat}`);
    }
  }
  return lines.join(`
`);
};
var ansiClean = (n) => `\x1B[32m${CHECK} No mistakes\x1B[0m${n >= STREAK_FROM ? `\x1B[2m · ${n} in a row\x1B[0m` : ""}`;
var ansiError = (errorLine) => `\x1B[2m${sanitizeTerminalText(errorLine)}\x1B[0m`;

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
var completeCheck = async (s, system, prompt, timeoutMs, completer) => {
  if (s.endpoint === "") {
    return { isAnswered: false, gated: true, reason: ENDPOINT_REQUIRED_MESSAGE };
  }
  const req = {
    model: s.endpointModel,
    system,
    prompt,
    maxTokens: 2048,
    timeoutMs: timeoutMs ?? Math.max(s.timeoutMs, 30000)
  };
  if (completer !== undefined) {
    return completer(req);
  }
  return endpointComplete(s.endpoint, s.endpointModel, s.endpointKey, req);
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
var pendingPath = (dataDir, conversationId) => join2(dataDir, "pending", `${safeId(conversationId)}.json`);
var statusLinePath = (dataDir, conversationId) => join2(dataDir, "statusline", `${safeId(conversationId)}.json`);
var inflightPath = (dataDir, conversationId) => join2(dataDir, "inflight", `${safeId(conversationId)}.json`);
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
var recordToHistoryFile = (path, fixes, now, lang = ENGLISH) => {
  try {
    const current = readHistoryFile(path);
    atomicWrite(path, historyText(record(current, fixes, now, lang)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
var MAX_PENDING = 10;
var readPendingList = (path) => {
  if (!existsSync2(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};
var appendPending = (dataDir, conversationId, result) => {
  const path = pendingPath(dataDir, conversationId);
  const queue = [...readPendingList(path), result].slice(-MAX_PENDING);
  atomicWrite(path, JSON.stringify(queue));
};
var saveStatusLine = (dataDir, conversationId, entry) => {
  const existing = readStatusLine(dataDir, conversationId);
  if (existing !== undefined && existing.updatedAt > entry.updatedAt) {
    return;
  }
  atomicWrite(statusLinePath(dataDir, conversationId), JSON.stringify(entry));
};
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
var clearStatusLine = (dataDir, conversationId, minUpdatedAt) => {
  if (minUpdatedAt !== undefined) {
    const existing = readStatusLine(dataDir, conversationId);
    if (existing !== undefined && existing.updatedAt > minUpdatedAt) {
      return;
    }
  }
  const path = statusLinePath(dataDir, conversationId);
  if (!existsSync2(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {}
};
var readInflight = (dataDir, conversationId) => {
  const path = inflightPath(dataDir, conversationId);
  if (!existsSync2(path)) {
    return;
  }
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
    if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || raw.id === "" || typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) {
      return;
    }
    const pid = typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : undefined;
    return {
      id: raw.id,
      startedAt: raw.startedAt,
      ...pid !== undefined ? { pid } : {}
    };
  } catch {
    return;
  }
};
var clearInflight = (dataDir, conversationId, expectedId) => {
  if (expectedId !== undefined) {
    const current = readInflight(dataDir, conversationId);
    if (current === undefined || current.id !== expectedId) {
      return;
    }
  }
  const path = inflightPath(dataDir, conversationId);
  if (!existsSync2(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {}
};

// src/runner.ts
var checkableText = (rawInput, settings, lists, fails) => {
  if (!settings.enabled || fails >= MAX_FAILS) {
    return;
  }
  const text = typedPart(rawInput);
  if (text === "" || text.startsWith("/")) {
    return;
  }
  if (!lettersFor(settings.language).test(text) || wordCount(text) < settings.minWords) {
    return;
  }
  if (compileSkip(lists.skip).some((re) => re.test(text))) {
    return;
  }
  return text;
};
var runPromptCheck = async ({
  rawInput,
  conversationId,
  settings,
  lists,
  paths,
  now = Date.now(),
  completer
}) => {
  const session = loadSession(paths.dataDir, conversationId, now);
  const text = checkableText(rawInput, settings, lists, session.fails);
  if (text === undefined) {
    return { skipped: true };
  }
  const ignore = compileIgnore(lists.ignore);
  const keepHistory = settings.history && lists.history;
  const sysPrompt = system({
    natural: settings.natural,
    language: settings.language,
    dialect: settings.dialect,
    showWhy: settings.showWhy,
    kind: keepHistory,
    ignore: ignore.words
  });
  const failOutcome = (reason) => {
    const nextFails = session.fails + 1;
    session.fails = nextFails;
    session.lastError = reason;
    const check = {
      id: now,
      text,
      status: "error",
      fixes: [],
      error: reason,
      paused: nextFails === MAX_FAILS
    };
    saveSession(paths.dataDir, conversationId, session, Date.now());
    const paused = check.paused ? `; paused after ${MAX_FAILS} failures in a row, /grammar on to try again` : "";
    const errLine = `! no grammar check: ${reason}${paused}`;
    saveStatusLine(paths.dataDir, conversationId, {
      id: String(check.id),
      ansi: ansiError(errLine),
      plain: errLine,
      updatedAt: now
    });
    return { skipped: false, check, markdown: `*${errLine}*`, plain: errLine };
  };
  const r = await completeCheck(settings, sysPrompt, cut(text, settings.maxChars), settings.timeoutMs, completer);
  if (!r.isAnswered) {
    if (r.gated) {
      return { skipped: true };
    }
    return failOutcome(r.reason);
  }
  try {
    const reply = parseReply(r.text, fallbackFor(settings.language));
    const language = reply === null ? undefined : keptLanguage(settings.language, reply.language);
    if (reply === null || language === undefined) {
      session.fails = 0;
      delete session.lastError;
      saveSession(paths.dataDir, conversationId, session, Date.now());
      return { skipped: true };
    }
    const fixes = keepFixes(reply.fixes, text, ignore);
    const natural = settings.natural ? usefulNatural(reply.natural, text, fixes, ignore) : null;
    const clean = fixes.length === 0 && natural === null;
    session.fails = 0;
    delete session.lastError;
    session.streak = clean ? session.streak + 1 : 0;
    if (fixes.length > 0) {
      const tagged = fixes.map((f) => ({ ...f, language }));
      session.recentFixes = [...tagged, ...session.recentFixes].slice(0, MAX_RECENT_FIXES);
    }
    const check = {
      id: now,
      text,
      status: "done",
      fixes,
      natural,
      language,
      ...clean ? { streak: session.streak } : {}
    };
    saveSession(paths.dataDir, conversationId, session, now);
    let historyError;
    if (keepHistory) {
      const saved = recordToHistoryFile(paths.historyFile, fixes, now, language ?? ENGLISH);
      if (!saved.ok) {
        historyError = saved.error;
      }
    }
    if (!clean) {
      const plain = `✎ ${plainFixes(fixes, natural, settings.showWhy)}`;
      const ansi = ansiFixes(fixes, natural, settings.showWhy);
      const statusPlain = statusLinePlainFixes(fixes, natural, settings.showWhy);
      saveStatusLine(paths.dataDir, conversationId, { id: String(check.id), ansi, plain: statusPlain, updatedAt: now });
      return {
        skipped: false,
        check,
        markdown: markdownFixes(fixes, natural, settings.showWhy),
        plain,
        historyError
      };
    }
    if (settings.clean) {
      saveStatusLine(paths.dataDir, conversationId, {
        id: String(check.id),
        ansi: ansiClean(session.streak),
        plain: cleanText(session.streak),
        updatedAt: now
      });
    } else {
      clearStatusLine(paths.dataDir, conversationId, now);
    }
    if (settings.clean && session.streak >= STREAK_FROM) {
      const line = cleanText(session.streak);
      return { skipped: false, check, markdown: `*${line}*`, plain: line, historyError };
    }
    return { skipped: false, check, historyError };
  } catch (err) {
    return failOutcome(err instanceof Error ? err.message : String(err));
  }
};

// scripts/check-worker.ts
var main = async () => {
  const rawJob = process.env.PROMPT_GRAMMAR_JOB;
  if (!rawJob) {
    return;
  }
  const job = JSON.parse(rawJob);
  const paths = resolvePaths(job.cwd);
  const { settings, lists } = loadConfigAndLists(paths);
  const effectiveDisplay = job.display ?? settings.display;
  const jobId = job.id ?? (typeof job.now === "number" ? String(job.now) : undefined);
  try {
    const outcome = await runPromptCheck({
      rawInput: job.rawInput,
      conversationId: job.conversationId,
      settings,
      lists,
      paths,
      now: job.now ?? Date.now()
    });
    if (outcome.skipped || effectiveDisplay === "statusline") {
      return;
    }
    if (outcome.check.status === "error" && !outcome.check.paused) {
      return;
    }
    if (outcome.markdown || outcome.plain) {
      appendPending(paths.dataDir, job.conversationId, {
        id: String(outcome.check.id),
        markdown: outcome.markdown,
        plain: outcome.plain,
        createdAt: Date.now()
      });
    }
  } finally {
    if (jobId !== undefined) {
      clearInflight(paths.dataDir, job.conversationId, jobId);
    }
  }
};
await main().catch(() => {
  return;
});
