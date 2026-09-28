#!/usr/bin/env node
// CI guard against the P3-1 class of bug: getString() calls referencing
// keys/attributes that do not exist in both locales. Also enforces
// en-US/zh-CN key parity.
//
// Usage: node scripts/check-i18n.mjs   (exit 1 on any problem)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localeDir = join(root, "addon", "locale");
const srcDir = join(root, "src");

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// FTL is line-oriented for our purposes: message ids start at column 0
// ("key = value"), attributes are indented ".attr = value", everything
// else (continuation lines, comments) is ignored.
function parseFtl(file) {
  const messages = new Map(); // id -> Set<attr>
  let current = null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const msg = line.match(/^([A-Za-z0-9-]+)\s*=/);
    if (msg) {
      current = msg[1];
      if (!messages.has(current)) messages.set(current, new Set());
      continue;
    }
    const attr = line.match(/^\s+\.([A-Za-z0-9-]+)\s*=/);
    if (attr && current) messages.get(current).add(attr[1]);
  }
  return messages;
}

const locales = {};
for (const loc of readdirSync(localeDir)) {
  const dir = join(localeDir, loc);
  if (!statSync(dir).isDirectory()) continue;
  locales[loc] = new Map();
  for (const f of walk(dir, [".ftl"])) {
    for (const [id, attrs] of parseFtl(f)) {
      const merged = locales[loc].get(id) ?? new Set();
      for (const a of attrs) merged.add(a);
      locales[loc].set(id, merged);
    }
  }
}

const problems = [];
const localeNames = Object.keys(locales).sort();

// 1. key parity across locales
const allIds = new Set();
for (const loc of localeNames) {
  for (const id of locales[loc].keys()) allIds.add(id);
}
for (const id of allIds) {
  for (const loc of localeNames) {
    if (!locales[loc].has(id)) {
      problems.push(`${loc}: missing message id "${id}"`);
    }
  }
}

// 2. every getString("key") / getString("key", "attr") resolves
const usedIds = new Set();
for (const file of walk(srcDir, [".ts"])) {
  const src = readFileSync(file, "utf8")
    .split(/\r?\n/)
    // skip comment lines: JSDoc examples contain getString() calls too
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const re =
    /getString\(\s*["']([A-Za-z0-9-]+)["']\s*(?:,\s*["']([A-Za-z0-9-]+)["'])?\s*[,)]/g;
  for (const m of src.matchAll(re)) {
    const [, id, attr] = m;
    usedIds.add(id);
    const rel = file.slice(root.length + 1);
    for (const loc of localeNames) {
      const msgs = locales[loc];
      if (!msgs.has(id)) {
        problems.push(`${rel}: getString("${id}") not defined in ${loc}`);
        continue;
      }
      if (attr && !msgs.get(id).has(attr)) {
        problems.push(
          `${rel}: getString("${id}", "${attr}") — ${loc} has no .${attr} attribute`,
        );
      }
      if (!attr) {
        // value-only access: the message must actually have a value, i.e.
        // exist with a "= ..." pattern (attribute-only messages render as
        // the literal key name at runtime)
        const attrsOnly = msgs.get(id);
        if (attrsOnly.size > 0 && !messageHasValue(join(localeDir), loc, id)) {
          problems.push(
            `${rel}: getString("${id}") used without a branch, but ${loc} only defines attributes (.${[...attrsOnly].join(", .")})`,
          );
        }
      }
    }
  }
}

// messageHasValue re-reads the files: whether an id has a direct value
// cannot be expressed by the per-id attr set alone.
function messageHasValue(localeDirBase, loc, id) {
  for (const f of walk(join(localeDirBase, loc), [".ftl"])) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(new RegExp(`^${id}\\s*=\\s*(.*)$`));
      if (!m) continue;
      // "key = <value>" has a value; a bare "key =" only continues into a
      // value when the next line is indented AND not an attribute
      // (".attr = ..." lines are attributes, not the value)
      if (m[1].trim()) return true;
      const next = lines[i + 1] ?? "";
      if (/^\s+[^.\s]/.test(next) && next.trim()) return true;
      return false;
    }
  }
  return false;
}

// 3. unused keys are informational only
const unused = [...allIds].filter((id) => !usedIds.has(id));
if (unused.length) {
  console.log(
    `i18n: note, ${unused.length} message id(s) unused in JS (may be data-l10n-id only): ${unused.join(", ")}`,
  );
}

if (problems.length) {
  console.error(`i18n check FAILED with ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `i18n check OK: ${allIds.size} ids across ${localeNames.join(", ")}, all getString() calls resolve`,
);
