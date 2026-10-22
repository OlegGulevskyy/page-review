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
import { contextPaths } from "./paths.js";

export const DATA_DIR = path.resolve(process.env.PAGE_REVIEW_HOME || path.join(os.homedir(), ".page-review"));
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

// The project a directory belongs to lives with the @path helpers, which also need it.
export { findProjectRoot } from "./paths.js";

// Thread: { id, siteId, page, anchor, status: "open"|"resolved", agent: "idle"|"pending"|"working",
//           messages: [{ id, author: "user"|"agent", text, at }], createdAt, updatedAt }
// `page` is the path within the site (e.g. "/report.html" or "/dashboard").
// `anchor` is { kind: "text"|"element", selector, exact, prefix, suffix, before, after, tag, snippet, original }.
// `before`/`after` are the page text around the anchor (whitespace collapsed), used to find it again
// after the anchored text is rewritten. `original` is the text first commented on, set once it changes.
const quoteOf = (a) => (a?.kind === "element" ? a.snippet : a?.exact) || "";

// Point a thread at its anchor's new place or text, keeping the first quoted text as `original`.
// `next` is a full anchor from the browser, or { text } when an agent reports what it rewrote the quote to.
export function moveAnchor(t, next) {
  const prev = t.anchor || {};
  const original = (prev.original ?? quoteOf(prev)).trim();
  const anchor = next.text != null
    ? { ...prev, [prev.kind === "element" ? "snippet" : "exact"]: String(next.text).slice(0, 600) }
    : { ...next, kind: next.kind === "element" ? "element" : "text" };
  if (quoteOf(anchor).trim() !== original) anchor.original = original;
  else delete anchor.original;
  t.anchor = anchor;
  return t;
}
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
    ...(t.anchor?.original ? { original_quote: t.anchor.original } : {}),
    context_paths: contextPaths(t, site).map((c) => c.path),
    last_message: last ? `${last.author}: ${last.text}` : "",
    messages: t.messages.length,
    site_context: site?.context || null,
    updated_at: t.updatedAt,
  };
}

export function pageUrl(site, page) {
  return `http://localhost:${site.port}${page}`;
}
