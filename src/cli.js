#!/usr/bin/env node
// page-review CLI
//   page-review open <file|dir|url> [--context "notes"] [--project <dir>] [--runner claude|codex|webhook|none] [--webhook URL] [--no-browser]
//   page-review runner [claude|codex|webhook|none] [--model m] [--effort level] [--permissions bypass|accept-edits] [--max-parallel n] [--timeout min]
//   page-review log <thread_id>                  # output of the last agent run on that thread
//   page-review list [open|resolved|all]
//   page-review get <thread_id>
//   page-review reply <thread_id> <text>
//   page-review webhook <site_id|--default|--project <root>> [url]
//   page-review t3-task-root <scheduledTaskId>   # make a T3 webhook task run in the project checkout
//   page-review status | stop
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, openTarget, ensureServer, PORT } from "./control.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest.splice(i, 2)[1];
};

try {
  if (cmd === "open") {
    const webhook = flag("--webhook");
    const context = flag("--context");
    const project_root = flag("--project");
    const runner = flag("--runner");
    const noBrowser = rest.includes("--no-browser");
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("usage: page-review open <file|dir|url> [--webhook URL]");
    const { site, url } = await openTarget(target, webhook, context, { project_root, runner });
    console.log(url);
    if (site.projectRoot) console.log(`project: ${site.projectRoot}  threads: ${site.root}/.page-review.json`);
    console.log(`answered by: ${site.runner}${site.runner === "webhook" ? ` (${site.webhook_effective || "no webhook set!"})` : ""}`);
    if (!noBrowser && process.platform === "darwin") spawnSync("open", [url]);
  } else if (cmd === "list") {
    const list = await api("GET", `/threads?status=${rest[0] || "open"}`);
    for (const t of list) console.log(`${t.needs_reply ? "●" : "○"} ${t.id}  ${t.url}\n   “${t.quote.slice(0, 80)}”\n   ${t.last_message.slice(0, 120)}`);
    if (!list.length) console.log("No threads.");
  } else if (cmd === "get") {
    const t = await api("GET", `/threads/${rest[0]}`);
    if (t.needs_reply) await api("POST", `/threads/${t.id}/status`, { agent: "working" });
    console.log(JSON.stringify({ id: t.id, status: t.status, url: t.url, file: t.file, project_root: t.project_root, site_context: t.site_context, anchor: t.anchor, messages: t.messages.map((m) => ({ author: m.author, text: m.text, at: m.at })) }, null, 2));
  } else if (cmd === "reply") {
    if (rest.includes("--resolve")) console.error("--resolve is ignored. Threads stay open until the user resolves them in the browser.");
    const [id, ...words] = rest.filter((a) => a !== "--resolve");
    const t = await api("POST", `/threads/${id}/messages`, { author: "agent", name: process.env.PAGE_REVIEW_AGENT_NAME || "Claude", text: words.join(" ") });
    console.log(`${t.id} ${t.status} (${t.messages.length} messages)`);
  } else if (cmd === "runner") {
    const r = {};
    const model = flag("--model"), effort = flag("--effort"), permissions = flag("--permissions"), maxParallel = flag("--max-parallel"), timeoutMin = flag("--timeout");
    if (model !== undefined) r.model = model;
    if (effort !== undefined) r.effort = effort;
    if (permissions !== undefined) r.permissions = permissions;
    if (maxParallel !== undefined) r.maxParallel = maxParallel;
    if (timeoutMin !== undefined) r.timeoutMin = timeoutMin;
    if (rest[0]) r.kind = rest[0];
    const c = await api(Object.keys(r).length ? "PATCH" : "GET", "/config", Object.keys(r).length ? { runner: r } : undefined);
    console.log(JSON.stringify(c.runner), c.active_runs?.length ? `active: ${c.active_runs.join(", ")}` : "");
  } else if (cmd === "log") {
    const t = await api("GET", `/threads/${rest[0]}`);
    if (!t.lastRun?.log) throw new Error("no run yet for this thread");
    console.log(`${t.lastRun.kind} ${t.lastRun.startedAt} → ${t.lastRun.endedAt || "running"} exit=${t.lastRun.exitCode ?? "-"}${t.session ? `  session ${t.session.id}` : ""}\n`);
    process.stdout.write(fs.readFileSync(t.lastRun.log, "utf8"));
  } else if (cmd === "webhook") {
    if (rest[0] === "--default") {
      const c = await api("PATCH", "/config", { defaultWebhook: rest[1] || "" });
      console.log(`default webhook: ${c.defaultWebhook || "none"}`);
    } else if (rest[0] === "--project") {
      const root = path.resolve((rest[1] || "").replace(/^~(?=\/)/, os.homedir()));
      if (!rest[1]) throw new Error("usage: page-review webhook --project <root> [url]");
      const c = await api("PATCH", "/config", { project_webhook: { root, url: rest[2] || "" } });
      console.log(`project ${root}: ${c.webhooks?.[root] || "none (uses the default)"}`);
    } else {
      const site = await api("PATCH", `/sites/${rest[0]}`, { webhook: rest[1] || "" });
      console.log(`${site.id} webhook: ${site.webhook || `none (uses the ${site.webhook_scope} one)`}`);
    }
  } else if (cmd === "t3-task-root") {
    // T3 Code stores a "worktree" workspace strategy on scheduled tasks that launch a fresh thread
    // per run, and its tools cannot change it. Page-review runs must work in the project checkout
    // itself (the generated page may be uncommitted, and the project may not be a git repo), so
    // set that one column to "root". Backs the database up first; touches nothing else.
    const id = rest[0];
    if (!id) throw new Error("usage: page-review t3-task-root <scheduledTaskId>");
    const dbFile = path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite");
    if (!fs.existsSync(dbFile)) throw new Error(`no T3 database at ${dbFile}`);
    const sql = (q) => {
      const r = spawnSync("sqlite3", ["-json", dbFile, q], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr.trim() || r.stdout.trim()}`);
      return r.stdout.trim() ? JSON.parse(r.stdout) : [];
    };
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    const rows = sql(`select task_id, title, project_id, workspace_strategy_json from scheduled_tasks where task_id = ${q(id)}`);
    if (rows.length !== 1) throw new Error(`no scheduled task ${id}`);
    const backup = path.join(os.tmpdir(), `t3-statev2-${Date.now()}.sqlite`);
    spawnSync("sqlite3", [dbFile, `.backup '${backup}'`]);
    sql(`update scheduled_tasks set workspace_strategy_json = '{"type":"root"}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where task_id = ${q(id)}`);
    const after = sql(`select workspace_strategy_json from scheduled_tasks where task_id = ${q(id)}`)[0].workspace_strategy_json;
    console.log(`${rows[0].title} (${rows[0].project_id}): ${rows[0].workspace_strategy_json} -> ${after}\nbackup: ${backup}`);
  } else if (cmd === "status") {
    await ensureServer();
    for (const s of await api("GET", "/sites")) console.log(`${s.id}  ${s.url}  ${s.root || s.target}${s.projectRoot ? `  [project ${s.projectRoot}]` : ""}  runner: ${s.runner}${s.runner === "webhook" ? ` (${s.webhook_scope})` : ""}`);
    console.log(`control: http://localhost:${PORT}`);
    const c = await api("GET", "/config");
    console.log(`runner: ${JSON.stringify(c.runner)}${c.active_runs?.length ? `  active: ${c.active_runs.join(", ")}` : ""}`);
    for (const [root, url] of Object.entries(c.webhooks || {})) console.log(`project webhook: ${root} -> ${url}`);
    console.log(`default webhook: ${c.defaultWebhook || "none"}`);
  } else if (cmd === "stop") {
    const { pid } = await api("GET", "/health");
    process.kill(pid);
    console.log(`stopped ${pid}`);
  } else {
    console.log("page-review open <file|dir|url> [--context notes] [--project dir] [--runner claude|codex|webhook|none] [--no-browser] | list [open|resolved|all] | get <id> | reply <id> <text> | log <id> | runner [kind] [--model m] [--effort level] [--permissions bypass|accept-edits] | webhook <site_id|--default|--project <root>> [url] | t3-task-root <scheduledTaskId> | status | stop");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
