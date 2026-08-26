// Guards against a class of bug that reached production twice.
//   node scripts/check-sources.mjs
//
// A regex written through a shell heredoc lost a level of escaping and `\b`
// became a literal backspace byte. The file still parsed, the tests still ran,
// and `/\b0\.\d+\b/` silently became `/<BS>0.d+<BS>/` — a pattern that matches
// nothing. The prose fallback in readRisk was dead for a day: every routed
// answer was judged unreadable, every leg fell through to a second paid call,
// and the other miners took the blame for it.
//
// Control characters are invisible in every diff and every editor. Nothing else
// in this repo would have caught it, so this does.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TEXT = /\.(mjs|js|sol|rs|html|yaml|yml|json|md|toml)$/;

// Tab, newline and carriage return are legitimate. Everything else in the C0
// range is a mistake — most often a mangled escape sequence.
const FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const NAME = {
  "\x08": "backspace (a mangled \\b)",
  "\x00": "NUL",
  "\x1b": "escape",
  "\x0c": "form feed",
  "\x7f": "delete",
};

// execFileSync, not execSync: no shell means no metacharacter has a meaning,
// and this file is run from CI where that habit is worth keeping even when the
// command is a constant.
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((f) => f && TEXT.test(f));

let bad = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted but still indexed
  }

  for (const m of text.matchAll(FORBIDDEN)) {
    const line = text.slice(0, m.index).split("\n").length;
    const ch = m[0];
    const label = NAME[ch] ?? `0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    console.error(`${file}:${line}: control character ${label}`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} control character${bad === 1 ? "" : "s"} found. These are invisible in a diff and break regexes silently.`);
  process.exit(1);
}
console.log(`sources clean — ${files.length} files, no control characters`);
