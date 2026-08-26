// Flag parsing shared by the agent scripts.
//
// It exists because getting it wrong once was expensive: `policy.mjs --policy 1`
// read "--policy" as a policy name and "1" as a latitude, and opened a second
// policy against the book instead of reusing the first. Flags have to come out
// before positionals are read, and doing that in one place means doing it once.

/** The value after `flag`, or `fallback` when the flag is absent. */
export function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}

/** True when `name` is present as a bare switch. */
export function has(argv, name) {
  return argv.includes(name);
}

/**
 * Refuse a flag the script does not implement.
 *
 * Silently ignoring `--dry` on a script that has no dry run is how someone
 * spends a dollar believing they simulated it. An unknown flag is a mistake
 * about what the tool does, and the tool is the only one that can say so.
 */
export function reject(argv, known) {
  const unknown = argv.filter((a) => a.startsWith("--") && !known.includes(a));
  if (unknown.length) {
    throw new Error(
      `unknown ${unknown.length === 1 ? "flag" : "flags"}: ${unknown.join(", ")}. ` +
      `this script takes ${known.length ? known.join(", ") : "no flags"}`,
    );
  }
}

/**
 * Positional arguments with the named flags and their values removed.
 *
 * `valued` names the flags that consume the following argument; anything else
 * matching `--x` is treated as a bare switch and dropped on its own.
 */
export function positionals(argv, valued = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) { i++; continue; }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}
