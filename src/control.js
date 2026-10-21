// Talk to the review server's control port, starting it in the background when it is down.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./store.js";

export const PORT = Number(process.env.PAGE_REVIEW_PORT || 4848);
const BASE = `http://127.0.0.1:${PORT}/__review/api`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");

async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureServer() {
  if (await healthy()) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, "server.log"), "a");
  spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await healthy()) return;
  }
  throw new Error(`page-review server did not start; see ${path.join(DATA_DIR, "server.log")}`);
}

export async function api(method, p, body) {
  await ensureServer();
  const r = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${p} -> HTTP ${r.status}`);
  return data;
}

// Register a file, directory or dev-server URL and return the review URL for it.
export async function openTarget(target, webhook, context, extra = {}) {
  if (/^https?:\/\//.test(target)) {
    const u = new URL(target);
    const site = await api("POST", "/sites", { target: u.origin, webhook, context, ...extra });
    return { site, url: `http://localhost:${site.port}${u.pathname}${u.search}` };
  }
  const abs = path.resolve(target.replace(/^~(?=\/)/, process.env.HOME));
  if (!fs.existsSync(abs)) throw new Error(`no such file or directory: ${abs}`);
  const isDir = fs.statSync(abs).isDirectory();
  const dir = isDir ? abs : path.dirname(abs);
  const site = await api("POST", "/sites", { dir, webhook, context, ...extra });
  const page = isDir ? "/" : "/" + encodeURIComponent(path.basename(abs));
  return { site, url: `http://localhost:${site.port}${page}` };
}
