// Measure the recorded clips and write media/clips.json.
//
//   node scripts/probe-clips.mjs
//
// Remotion sequences by frame, so it needs a duration per clip. Reading it from
// the file rather than trusting the waits in record-demo.mjs matters: a page
// that took four seconds to answer makes a longer clip than one that took one,
// and the whole point of recording against the live miner is that we do not get
// to decide which it was.

import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, "../media/raw");
const OUT = join(HERE, "../media/clips.json");

// Order is the story, not the directory listing.
const ORDER = ["reading", "route", "ledger", "jobable", "slides"];

// A repo-relative path, run from the repo root. The absolute one contains a
// space, and `shell: true` on Windows splits on it: ffprobe reported
// "'Hackathon\amanat\media\raw\reading.webm' provided as input filename,
// but 'C:\Hackathons\Telegraph' was already specified."
const ROOT = join(HERE, "..");
const seconds = (name) => {
  // ffprobe writes its banner and the stream summary to stderr, so both pipes
  // have to be read. execFileSync returns stdout alone and reported every clip
  // as having no duration.
  const r = spawnSync("npx", ["remotion", "ffprobe", `media/raw/${name}.webm`], {
    encoding: "utf8",
    cwd: ROOT,
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (!m) throw new Error(`no duration in ffprobe output for ${name}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

const present = new Set(readdirSync(RAW).filter((f) => f.endsWith(".webm")).map((f) => f.replace(/\.webm$/, "")));
const clips = ORDER.filter((n) => present.has(n)).map((name) => {
  const dur = seconds(name);
  console.log(`${name.padEnd(10)} ${dur.toFixed(2)}s`);
  return { name, seconds: dur };
});

if (!clips.length) throw new Error("no clips in media/raw — run scripts/record-demo.mjs first");
writeFileSync(OUT, JSON.stringify({ recorded_at: new Date().toISOString(), clips }, null, 2) + "\n");
console.log(`\nwrote media/clips.json — ${clips.reduce((s, c) => s + c.seconds, 0).toFixed(1)}s of footage`);
