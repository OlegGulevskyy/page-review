// Storage.
//
// - ~/.page-review/db.json holds the config, the sites and the threads of proxied dev servers.
// - Threads on served files live next to the files, in <site root>/.page-review.json, so a
//   review is cleaned up by deleting that one file (or the directory it is in).
// The review server is the only writer; the MCP server and the CLI talk to it over HTTP.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const DATA_DIR = process.env.PAGE_REVIEW_HOME || path.join(os.homedir(), ".page-review");
export const SITE_FILE = ".page-review.json"; // threads of a served directory
const DB_FILE = path.join(DATA_DIR, "db.json");

const empty = () => ({ config: {}, sites: {}, threads: {} });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const siteFile = (site) => (site.kind === "dir" ? path.join(site.root, SITE_FILE) : null);

export function loadDb() {
  const db = { ...empty(), ...(readJson(DB_FILE) || {}) };
  for (const site of Object.values(db.sites)) {
    const file = siteFile(site);
    if (!file) continue;
    for (const t of Object.values(readJson(file)?.threads || {})) db.threads[t.id] = t;
  }
  return db;
}

export function saveDb(db) {
  const home = { config: db.config, sites: db.sites, threads: {} };
  const perSite = {};
  for (const t of Object.values(db.threads)) {
    const file = siteFile(db.sites[t.siteId] || {});
    if (file) (perSite[file] ||= {}).threads = { ...(perSite[file].threads || {}), [t.id]: t };
    else home.threads[t.id] = t;
  }
  writeJson(DB_FILE, home);
  for (const site of Object.values(db.sites)) {
    const file = siteFile(site);
    if (!file || !fs.existsSync(site.root)) continue;
    const threads = perSite[file]?.threads || {};
    if (Object.keys(threads).length) writeJson(file, { page_review: 1, root: site.root, threads });
    else if (fs.existsSync(file)) fs.unlinkSync(file); // nothing left: leave no trace
  }
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
export const now = () => new Date().toISOString();

// A site is what pages are served from: a local directory, or a proxied dev server.
//   { id, kind: "dir", root, projectRoot, port } | { id, kind: "proxy", target, port }
// plus `webhook` (URL called when the user comments), `context` (notes for the agent) and `label`.
export function siteIdFor(key) {
  return "s_" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
}

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

// Thread: { id, siteId, page, anchor, status: "open"|"resolved", agent: "idle"|"pending"|"working",
//           messages: [{ id, author: "user"|"agent", text, at }], createdAt, updatedAt }
// `page` is the path within the site (e.g. "/report.html" or "/dashboard").
// `anchor` is { kind: "text"|"element", selector, exact, prefix, suffix, tag, snippet }.
export function threadSummary(t, db) {
  const site = db.sites[t.siteId];
  const last = t.messages[t.messages.length - 1];
  return {
    id: t.id,
    status: t.status,
    needs_reply: t.status === "open" && last?.author === "user",
    page: t.page,
    file: site?.kind === "dir" ? path.join(site.root, decodeURIComponent(t.page)) : undefined,
    project_root: site?.projectRoot || site?.root || undefined,
    url: site ? pageUrl(site, t.page) : undefined,
    quote: t.anchor?.exact || t.anchor?.snippet || "",
    last_message: last ? `${last.author}: ${last.text}` : "",
    messages: t.messages.length,
    site_context: site?.context || null,
    updated_at: t.updatedAt,
  };
}

export function pageUrl(site, page) {
  return `http://localhost:${site.port}${page}`;
}
