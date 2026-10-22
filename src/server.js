#!/usr/bin/env node
// page-review server.
//
// - Control port (PAGE_REVIEW_PORT, default 4848): the JSON API and live events, used by the
//   MCP server and the CLI.
// - One port per site: serves a local directory, or proxies a dev server, and injects the
//   comment client into every HTML response. The same /__review/* routes answer on every port,
//   so the client always talks to its own origin.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb, newId, now, siteIdFor, threadSummary, moveAnchor, pageUrl, findProjectRoot, DATA_DIR, SITE_FILE } from "./store.js";
import { createRunner, runnerConfig, KINDS } from "./runner.js";
import { contextPaths, suggestPaths } from "./paths.js";
import { runnerChoices, updateRunnerSettings } from "./settings.js";
import { buildStatus, statusHtml } from "./status.js";
import { VERSION, PACKAGE_ROOT } from "./package.js";

const CONTROL_PORT = Number(process.env.PAGE_REVIEW_PORT || 4848);
const FIRST_SITE_PORT = CONTROL_PORT + 2;
const CLIENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "client.js");
const WEBHOOK_DEBOUNCE_MS = 2500;

const db = loadDb();
const listeners = new Map(); // siteId -> http.Server
const watchers = new Map(); // siteId -> fs.FSWatcher
const streams = new Set(); // { res, siteId }
const webhookTimers = new Map(); // threadId -> timeout

// ── helpers ─────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function broadcast(siteId, event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of streams) if (!siteId || s.siteId === siteId || s.siteId === "*") s.res.write(line);
}

function emitThread(t) {
  broadcast(t.siteId, { type: "thread", thread: t });
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".pdf": "application/pdf",
};

function injectClient(html, site) {
  const tag = `<script src="/__review/client.js" data-site="${site.id}" data-kind="${site.kind}" defer></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag;
}

function normalizePage(site, page) {
  let p = page || "/";
  if (site.kind === "dir" && p.endsWith("/")) p += "index.html";
  return p;
}

// ── sites ───────────────────────────────────────────────────────────────

function nextFreePort() {
  const used = new Set(Object.values(db.sites).map((s) => s.port));
  let p = FIRST_SITE_PORT;
  while (used.has(p)) p++;
  return p;
}

function registerSite({ dir, target, webhook, label, context, project_root, runner, page }) {
  const key = dir ? `dir:${path.resolve(dir)}` : `proxy:${new URL(target).origin}`;
  const id = siteIdFor(key);
  const existing = db.sites[id];
  const site = existing || {
    id,
    kind: dir ? "dir" : "proxy",
    ...(dir ? { root: path.resolve(dir) } : { target: new URL(target).origin }),
    port: nextFreePort(),
    createdAt: now(),
  };
  if (site.kind === "dir" && !site.projectRootPinned) site.projectRoot = findProjectRoot(site.root) || site.root;
  if (project_root !== undefined) applyProjectRoot(site, project_root);
  if (runner !== undefined) applyRunner(site, runner);
  if (webhook !== undefined) site.webhook = webhook || null;
  if (label) site.label = label;
  if (context !== undefined) site.context = context || null;
  if (typeof page === "string" && page.startsWith("/") && !page.startsWith("//")) site.lastPage = page;
  db.sites[id] = site;
  saveDb(db);
  return startSite(site).then(() => site);
}

function startSite(site) {
  if (listeners.has(site.id)) return Promise.resolve();
  const server = http.createServer((req, res) => handle(req, res, site));
  if (site.kind === "proxy") server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, site));
  if (site.kind === "dir") watchDir(site);
  listeners.set(site.id, server);
  return new Promise((resolve) => {
    server.once("error", (e) => {
      console.error(`site ${site.id} could not listen on ${site.port}: ${e.message}`);
      listeners.delete(site.id);
      resolve();
    });
    server.listen(site.port, "127.0.0.1", resolve);
  });
}

function watchDir(site) {
  let timer;
  try {
    const w = fs.watch(site.root, { recursive: true }, (_e, file) => {
      if (!file || /(^|\/)(\.git|node_modules)(\/|$)|\.tmp$|~$/.test(file) || path.basename(file) === SITE_FILE) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast(site.id, { type: "reload", file }), 150);
    });
    watchers.set(site.id, w);
  } catch (e) {
    console.error(`cannot watch ${site.root}: ${e.message}`);
  }
}

function applyProjectRoot(site, root) {
  if (!root) {
    site.projectRootPinned = false;
    site.projectRoot = site.kind === "dir" ? findProjectRoot(site.root) || site.root : null;
    return;
  }
  const abs = path.resolve(root.replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  site.projectRoot = abs;
  site.projectRootPinned = true;
}

function applyRunner(site, kind) {
  if (kind && !KINDS.includes(kind)) throw new Error(`runner must be one of ${KINDS.join(", ")}`);
  delete site.runnerSettings;
  if (!kind) return delete site.runner;
  site.runner = kind;
}

// ── wake the agent when the user writes: local runner, or a webhook ─────

// Site override, then the webhook registered for the project the site lives in, then the default.
function webhookScope(site) {
  if (site?.webhook) return { url: site.webhook, scope: "site" };
  const byProject = site?.projectRoot && db.config?.webhooks?.[site.projectRoot];
  if (byProject) return { url: byProject, scope: "project" };
  if (db.config?.defaultWebhook) return { url: db.config.defaultWebhook, scope: "default" };
  return { url: null, scope: "none" };
}
const webhookFor = (site) => webhookScope(site).url;
const siteView = (s) => ({
  ...s,
  url: pageUrl(s, "/"),
  threads_file: s.kind === "dir" ? path.join(s.root, SITE_FILE) : null,
  runner: runnerConfig(db, s).kind,
  runner_settings: runnerConfig(db, s),
  runner_override: Boolean(s.runnerSettings || s.runner),
  webhook_effective: webhookScope(s).url,
  webhook_scope: webhookScope(s).scope,
});

// Paths the user @-mentions come first in the next suggestions.
function rememberPaths(site, text) {
  const found = contextPaths({ messages: [{ author: "user", text }] }, site).map((c) => c.path);
  if (!found.length) return;
  db.config ||= {};
  db.config.recentPaths = [...new Set([...found, ...(db.config.recentPaths || [])])].slice(0, 12);
}

function scheduleWebhook(site, thread, text) {
  const hook = webhookFor(site);
  if (!hook) return;
  clearTimeout(webhookTimers.get(thread.id));
  webhookTimers.set(
    thread.id,
    setTimeout(async () => {
      webhookTimers.delete(thread.id);
      const pending = Object.values(db.threads).filter(
        (t) => t.siteId === site.id && t.status === "open" && t.messages.at(-1)?.author === "user",
      );
      const s = threadSummary(thread, db);
      const body = {
        event: "comment",
        site_id: site.id,
        thread_id: thread.id,
        page_url: s.url,
        file: s.file || "",
        project_root: s.project_root || "",
        quote: s.quote,
        text,
        context_paths: s.context_paths.join(","),
        pending_count: pending.length,
        pending_thread_ids: pending.map((t) => t.id).join(","),
      };
      try {
        const r = await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        console.log(`webhook ${site.id} ${thread.id} -> ${r.status}`);
      } catch (e) {
        console.error(`webhook ${site.id} failed: ${e.message}`);
      }
    }, WEBHOOK_DEBOUNCE_MS),
  );
}

const runner = createRunner({ db, saveDb, emitThread, scheduleWebhook, webhookFor });

// ── API ─────────────────────────────────────────────────────────────────

async function api(req, res, url) {
  const parts = url.pathname.replace(/^\/__review\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const q = url.searchParams;

  if (parts[0] === "health") return send(res, 200, { ok: true, name: "page-review", version: VERSION, pid: process.pid, data_dir: DATA_DIR });
  if (parts[0] === "status" && method === "GET") return send(res, 200, buildStatus(db, { running: true, active: runner.active(), port: CONTROL_PORT, listening: [...listeners.keys()] }));

  if (parts[0] === "events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": hi\n\n");
    const s = { res, siteId: q.get("site") || "*" };
    streams.add(s);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      streams.delete(s);
    });
    return;
  }

  if (parts[0] === "paths" && method === "GET") return send(res, 200, suggestPaths(q.get("q") || "", db.sites[q.get("site")], db.config?.recentPaths));

  if (parts[0] === "config") {
    db.config ||= {};
    if (method === "PATCH") {
      const b = await readBody(req);
      if ("defaultWebhook" in b) db.config.defaultWebhook = b.defaultWebhook || null;
      if (b.runner && typeof b.runner === "object") {
        let r;
        try { r = updateRunnerSettings(db.config.runner, b.runner); }
        catch (e) { return send(res, 400, { error: e.message }); }
        if ("permissions" in b.runner) r.permissions = b.runner.permissions === "accept-edits" ? "accept-edits" : "bypass";
        if ("maxParallel" in b.runner) r.maxParallel = Math.max(1, Number(b.runner.maxParallel) || 3);
        if ("timeoutMin" in b.runner) r.timeoutMin = Math.max(1, Number(b.runner.timeoutMin) || 20);
        db.config.runner = r;
      }
      if (b.project_webhook?.root) {
        const root = path.resolve(b.project_webhook.root);
        db.config.webhooks ||= {};
        if (b.project_webhook.url) db.config.webhooks[root] = b.project_webhook.url;
        else delete db.config.webhooks[root];
      }
      saveDb(db);
    }
    return send(res, 200, { ...db.config, runner: runnerConfig(db), runner_choices: runnerChoices(), active_runs: runner.active() });
  }

  if (parts[0] === "sites") {
    if (method === "GET") return send(res, 200, Object.values(db.sites).map(siteView));
    if (method === "POST" && !parts[1]) {
      const b = await readBody(req);
      if (!b.dir && !b.target) return send(res, 400, { error: "dir or target is required" });
      if (b.dir && !fs.existsSync(b.dir)) return send(res, 400, { error: `no such directory: ${b.dir}` });
      let site;
      try {
        site = await registerSite(b);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      return send(res, 200, siteView(site));
    }
    if (method === "PATCH" && parts[1]) {
      const site = db.sites[parts[1]];
      if (!site) return send(res, 404, { error: "no such site" });
      const b = await readBody(req);
      let settings;
      if ("runner_settings" in b && b.runner_settings !== null) {
        try {
          const validated = updateRunnerSettings(runnerConfig(db, site), b.runner_settings);
          settings = { kind: validated.kind, model: validated.model, effort: validated.effort };
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if ("webhook" in b) site.webhook = b.webhook || null;
      if (b.label) site.label = b.label;
      if ("context" in b) site.context = b.context || null;
      try {
        if ("project_root" in b) applyProjectRoot(site, b.project_root);
        if ("runner" in b) applyRunner(site, b.runner);
        if ("runner_settings" in b) {
          delete site.runner;
          if (settings) site.runnerSettings = settings;
          else delete site.runnerSettings;
        }
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      saveDb(db);
      return send(res, 200, siteView(site));
    }
  }

  if (parts[0] === "threads") {
    const id = parts[1];
    if (method === "GET" && !id) {
      const status = q.get("status") || "all";
      let list = Object.values(db.threads);
      if (q.get("site")) list = list.filter((t) => t.siteId === q.get("site"));
      if (q.get("page")) list = list.filter((t) => t.page === q.get("page"));
      if (status !== "all") list = list.filter((t) => t.status === status);
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return send(res, 200, q.get("full") ? list : list.map((t) => threadSummary(t, db)));
    }
    if (method === "POST" && !id) {
      const b = await readBody(req);
      const site = db.sites[b.siteId];
      if (!site) return send(res, 400, { error: "unknown site" });
      if (!b.text?.trim()) return send(res, 400, { error: "text is required" });
      const t = {
        id: newId("t"),
        siteId: site.id,
        page: normalizePage(site, b.page),
        anchor: b.anchor || null,
        status: "open",
        agent: runner.canWake(site) ? "pending" : "idle",
        messages: [{ id: newId("m"), author: "user", text: b.text.trim(), at: now() }],
        createdAt: now(),
        updatedAt: now(),
      };
      db.threads[t.id] = t;
      rememberPaths(site, t.messages[0].text);
      saveDb(db);
      emitThread(t);
      runner.wake(site, t, t.messages[0].text);
      return send(res, 200, t);
    }
    const t = db.threads[id];
    if (!t) return send(res, 404, { error: "no such thread" });
    const site = db.sites[t.siteId];
    if (method === "GET" && !parts[2]) return send(res, 200, { ...threadSummary(t, db), ...t });

    if (method === "POST" && parts[2] === "messages") {
      const b = await readBody(req);
      if (!b.text?.trim()) return send(res, 400, { error: "text is required" });
      const author = b.author === "agent" ? "agent" : "user";
      t.messages.push({ id: newId("m"), author, ...(author === "agent" && b.name ? { name: String(b.name).slice(0, 40) } : {}), text: b.text.trim(), at: now() });
      if (author === "agent" && typeof b.anchor_text === "string" && b.anchor_text.trim() && t.anchor) moveAnchor(t, { text: b.anchor_text.trim() });
      if (author === "user") {
        rememberPaths(site, b.text);
        t.status = "open";
        t.agent = runner.canWake(site) ? "pending" : "idle";
      } else {
        t.agent = "idle";
        // Agent replies never resolve a thread, including legacy clients sending resolve=true.
      }
      t.updatedAt = now();
      saveDb(db);
      emitThread(t);
      if (author === "user" && site) runner.wake(site, t, b.text.trim());
      return send(res, 200, t);
    }
    if (method === "POST" && parts[2] === "anchor") {
      const b = await readBody(req);
      if (!b.anchor || typeof b.anchor !== "object") return send(res, 400, { error: "anchor is required" });
      moveAnchor(t, b.anchor);
      saveDb(db);
      emitThread(t);
      return send(res, 200, t);
    }
    if (method === "POST" && parts[2] === "status") {
      const b = await readBody(req);
      if (b.author !== "user" && b.status === "resolved") return send(res, 400, { error: "Only the user can resolve a thread. Leave it open for review." });
      if (b.status) t.status = b.status === "resolved" ? "resolved" : "open";
      if (b.agent) t.agent = ["idle", "pending", "working"].includes(b.agent) ? b.agent : t.agent;
      t.updatedAt = now();
      saveDb(db);
      emitThread(t);
      return send(res, 200, t);
    }
    if (method === "DELETE" && !parts[2]) {
      delete db.threads[id];
      saveDb(db);
      broadcast(t.siteId, { type: "deleted", id });
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: "not found" });
}

// ── request handling ────────────────────────────────────────────────────

async function handle(req, res, site) {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/__review/client.js") {
      return send(res, 200, fs.readFileSync(CLIENT_JS), { "content-type": "text/javascript; charset=utf-8" });
    }
    if (url.pathname.startsWith("/__review/api")) return await api(req, res, url);
    if (url.pathname === "/__review/guide") return send(res, 200, fs.readFileSync(path.join(PACKAGE_ROOT, "README.html")), { "content-type": "text/html; charset=utf-8" });
    if (!site) return send(res, 200, statusHtml(buildStatus(db, { running: true, active: runner.active(), port: CONTROL_PORT, listening: [...listeners.keys()] })), { "content-type": "text/html; charset=utf-8" });
    return site.kind === "dir" ? serveFile(req, res, site, url) : proxy(req, res, site);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
}

function serveFile(req, res, site, url) {
  const rel = decodeURIComponent(url.pathname);
  const file = path.resolve(site.root, "." + rel);
  if (file !== site.root && !file.startsWith(site.root + path.sep)) return send(res, 403, "forbidden");
  let target = file;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, "index.html");
    if (fs.existsSync(index)) target = index;
    else return listDir(res, site, target, rel);
  }
  if (!fs.existsSync(target)) return send(res, 404, `not found: ${rel}`);
  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  if (ext === ".html" || ext === ".htm") {
    return send(res, 200, injectClient(fs.readFileSync(target, "utf8"), site), { "content-type": type });
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  fs.createReadStream(target).pipe(res);
}

function listDir(res, site, dir, rel) {
  const base = rel.endsWith("/") ? rel : rel + "/";
  const items = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith("."))
    .map((d) => `<li><a href="${base}${encodeURIComponent(d.name)}${d.isDirectory() ? "/" : ""}">${d.name}${d.isDirectory() ? "/" : ""}</a></li>`)
    .join("");
  send(res, 200, `<!doctype html><meta charset="utf-8"><title>${site.root}</title><body style="font:15px system-ui;padding:24px"><h3>${site.root}${rel}</h3><ul>${items}</ul></body>`, {
    "content-type": "text/html; charset=utf-8",
  });
}

function proxy(req, res, site) {
  const target = new URL(site.target);
  const headers = { ...req.headers, host: target.host, "accept-encoding": "identity" };
  const up = http.request(
    { hostname: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers },
    (upRes) => {
      const type = upRes.headers["content-type"] || "";
      if (!type.includes("text/html")) {
        res.writeHead(upRes.statusCode, upRes.headers);
        return upRes.pipe(res);
      }
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        const body = injectClient(Buffer.concat(chunks).toString("utf8"), site);
        const h = { ...upRes.headers };
        delete h["content-length"];
        delete h["content-encoding"];
        delete h["content-security-policy"];
        res.writeHead(upRes.statusCode, h);
        res.end(body);
      });
    },
  );
  up.on("error", (e) => send(res, 502, `dev server ${site.target} is not answering: ${e.message}`));
  req.pipe(up);
}

function proxyUpgrade(req, socket, head, site) {
  const target = new URL(site.target);
  const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${k === "host" ? target.host : v}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// ── boot ────────────────────────────────────────────────────────────────

const control = http.createServer((req, res) => handle(req, res, null));
control.on("error", (e) => {
  console.error(`page-review: control port ${CONTROL_PORT}: ${e.message}`);
  process.exit(1);
});
control.listen(CONTROL_PORT, "127.0.0.1", async () => {
  for (const site of Object.values(db.sites)) {
    if (site.kind === "dir" && !site.projectRoot && !site.projectRootPinned) site.projectRoot = findProjectRoot(site.root) || site.root;
    await startSite(site);
  }
  saveDb(db);
  console.log(`page-review on http://localhost:${CONTROL_PORT} (${Object.keys(db.sites).length} sites, data in ${DATA_DIR})`);
});
