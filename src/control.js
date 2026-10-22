// Talk to the review server's control port, starting it in the background when it is down.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./store.js";
import { VERSION } from "./package.js";

export const PORT = Number(process.env.PAGE_REVIEW_PORT || 4848);
const BASE = `http://127.0.0.1:${PORT}/__review/api`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");

export async function serverHealth() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PAGE_REVIEW_PORT must be a port number between 1 and 65535.");
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) throw new Error(`Port ${PORT} is occupied by another service. Choose another PAGE_REVIEW_PORT.`);
    const h = await r.json();
    if (!h.ok || !Number.isInteger(h.pid) || (h.name !== "page-review" && !h.data_dir)) throw new Error(`Port ${PORT} is occupied by another service. Choose another PAGE_REVIEW_PORT.`);
    const canonical = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
    if (h.data_dir && canonical(h.data_dir) !== canonical(DATA_DIR)) throw new Error(`Another page-review workspace is using port ${PORT}. Use its PAGE_REVIEW_HOME or choose another PAGE_REVIEW_PORT.`);
    return h;
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") return null;
    if (e.name === "TimeoutError") throw new Error(`The service on port ${PORT} is not responding. Check it before starting another server.`);
    throw e;
  }
}

export async function ensureServer() {
  const existing = await serverHealth();
  if (existing) {
    if (existing.version !== VERSION) throw new Error("The running page-review server needs updating. Run: page-review restart");
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, "server.log"), "a");
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", log, log], env: process.env });
  let spawnError;
  child.on("error", (e) => { spawnError = e; });
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (spawnError) throw new Error(`Could not start the server: ${spawnError.message}`);
    if (await serverHealth()) return;
  }
  throw new Error(`page-review server did not start; see ${path.join(DATA_DIR, "server.log")}`);
}

export async function stopServer() {
  const health = await serverHealth();
  if (!health) return false;
  const config = await fetch(`${BASE}/config`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
  if (config.active_runs?.length) throw new Error("Agents are still working. Wait for them to finish, then try again.");
  process.kill(health.pid, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { if (!await serverHealth()) return true; }
    catch (e) { if (e.cause?.code !== "ECONNRESET" && e.cause?.code !== "UND_ERR_SOCKET") throw e; }
  }
  throw new Error("The server has not stopped yet. Try page-review status in a moment.");
}

export async function api(method, p, body, { start = true } = {}) {
  if (start) await ensureServer();
  const r = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${p} -> HTTP ${r.status}`);
  return data;
}

// Register a file, directory or dev-server URL and return the review URL for it.
export async function openTarget(target, webhook, context, extra = {}) {
  if (/^https?:\/\//.test(target)) {
    const u = new URL(target);
    const site = await api("POST", "/sites", { target: u.origin, webhook, context, page: u.pathname + u.search, ...extra });
    return { site, url: `http://localhost:${site.port}${u.pathname}${u.search}` };
  }
  const abs = path.resolve(target.replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(abs)) throw new Error(`no such file or directory: ${abs}`);
  const isDir = fs.statSync(abs).isDirectory();
  const dir = isDir ? abs : path.dirname(abs);
  const page = isDir ? "/" : "/" + encodeURIComponent(path.basename(abs));
  const site = await api("POST", "/sites", { dir, webhook, context, page, ...extra });
  return { site, url: `http://localhost:${site.port}${page}` };
}
