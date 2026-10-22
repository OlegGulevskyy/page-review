// `@path` mentions: a user points the agent at a folder (or file) for context by writing it in a
// comment, e.g. "same as @~/dev/billing-api/src/routes" or "@../web". Paths start with /, ~/, ./
// or ../; paths with spaces are quoted: @"~/My Docs/spec". Relative paths are from the project root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MENTION = /(^|[\s(])@(?:"([^"\n]+)"|((?:~|\.{1,2})?\/[^\s"'`()<>]*))/g;
const SUGGESTIONS = 40;

export function mentions(text) {
  const out = [];
  for (const m of String(text || "").matchAll(MENTION)) {
    const p = m[2] ?? m[3].replace(/(.)[.,;:!?]+$/, "$1"); // "see @~/dev/api." ends the sentence, not the path
    if (p) out.push(p);
  }
  return out;
}

const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
export function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p;
}
export const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const baseOf = (site) => site?.projectRoot || site?.root || os.homedir();

// The project a directory belongs to: the nearest ancestor (or the directory itself) that looks
// like a project root. That is where the agent answering the comments should work from.
const PROJECT_MARKERS = [".git", "CLAUDE.md", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".t3"];
export function findProjectRoot(dir) {
  let d = path.resolve(dir);
  const home = os.homedir();
  while (true) {
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(d, m)))) return d;
    const parent = path.dirname(d);
    if (parent === d || d === home || parent === "/") return null;
    d = parent;
  }
}

// Existing paths mentioned in the user's messages of a thread, oldest first: [{ path, dir }].
export function contextPaths(thread, site) {
  const found = new Map();
  for (const m of thread?.messages || []) {
    if (m.author !== "user") continue;
    for (const p of mentions(m.text)) {
      const abs = path.resolve(baseOf(site), expandHome(p));
      if (found.has(abs)) continue;
      try {
        found.set(abs, { path: abs, dir: fs.statSync(abs).isDirectory() });
      } catch { /* a typo or a path from another machine: not context */ }
    }
  }
  return [...found.values()];
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) try { isDir = fs.statSync(full).isDirectory(); } catch { /* dangling */ }
      return { name: d.name, path: full, dir: isDir };
    });
  } catch {
    return [];
  }
}

const item = (p, dir, insert) => ({ label: path.basename(p) + (dir ? "/" : ""), detail: tildify(path.dirname(p)), insert, path: p, dir });

const SCRATCH = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const folders = (dir) => entries(dir).filter((e) => e.dir && !e.name.startsWith(".")).map((e) => e.path).sort((a, b) => a.localeCompare(b));

// Where to look for a bare name: the projects next to this one (when the page belongs to a real
// project, not a scratch folder in /tmp), next to the projects mentioned before, then home.
function neighbourhoods(site, recent) {
  const roots = [site?.projectRoot, ...recent].map((p) => p && findProjectRoot(p)).filter((r) => r && !SCRATCH.some((s) => within(s, r)));
  return [...new Set([...roots.map((r) => path.dirname(r)), os.homedir()])];
}

// Autocomplete for what follows the @. A path (~/de, ../, /Users/x/) lists that directory; a bare
// name (or nothing yet) searches the recently mentioned paths and the folders near them.
export function suggestPaths(q, site, recent = []) {
  const base = baseOf(site);
  if (!/^(~|\.{1,2})?\//.test(q)) {
    const needle = q.toLowerCase();
    const seen = new Set([base, os.homedir()]);
    const out = [];
    for (const p of [...recent, ...neighbourhoods(site, recent).flatMap(folders)]) {
      if (seen.has(p) || !path.basename(p).toLowerCase().includes(needle)) continue;
      seen.add(p);
      let dir;
      try { dir = fs.statSync(p).isDirectory(); } catch { continue; }
      out.push(item(p, dir, tildify(p) + (dir ? "/" : "")));
      if (out.length === SUGGESTIONS) break;
    }
    return out;
  }
  const cut = q.lastIndexOf("/") + 1;
  const head = q.slice(0, cut), prefix = q.slice(cut).toLowerCase();
  return entries(path.resolve(base, expandHome(head)))
    .filter((e) => e.name.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name))
    .slice(0, SUGGESTIONS)
    .map((e) => item(e.path, e.dir, head + e.name + (e.dir ? "/" : "")));
}
