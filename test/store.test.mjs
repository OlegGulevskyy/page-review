// End-to-end check against a private server instance: threads on served files are stored next to
// the files, the project root is detected, and the home db only keeps config and sites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-review-test-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
const pages = path.join(project, "docs", "out");
fs.mkdirSync(pages, { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}");
fs.writeFileSync(path.join(pages, "report.html"), "<html><body><h1>Hello</h1><p>The quick brown fox</p></body></html>");

const PORT = 4900 + Math.floor(Math.random() * 50);
const env = { ...process.env, PAGE_REVIEW_HOME: home, PAGE_REVIEW_PORT: String(PORT) };
const server = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], { env, stdio: "ignore" });
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/__review/api${p}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 100));
  if (await fetch(`http://127.0.0.1:${PORT}/__review/api/health`).then((r) => r.ok).catch(() => false)) break;
}

test("threads live next to the served files and the project root is found", async () => {
  const site = await api("POST", "/sites", { dir: pages, context: "test page", runner: "none" });
  assert.equal(site.kind, "dir");
  assert.equal(site.projectRoot, project);

  const t = await api("POST", "/threads", { siteId: site.id, page: "/report.html", anchor: { kind: "text", exact: "brown fox" }, text: "make it bold" });
  const file = path.join(pages, ".page-review.json");
  assert.ok(fs.existsSync(file), "thread file next to the page");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(stored.threads), [t.id]);
  const homeDb = JSON.parse(fs.readFileSync(path.join(home, "db.json"), "utf8"));
  assert.deepEqual(homeDb.threads, {}, "home db keeps no threads of served directories");

  const got = await api("GET", `/threads/${t.id}`);
  assert.equal(got.file, path.join(pages, "report.html"));
  assert.equal(got.project_root, project);
  assert.equal(got.needs_reply, true);

  const html = await fetch(`http://127.0.0.1:${site.port}/report.html`).then((r) => r.text());
  assert.match(html, /__review\/client\.js/);

  await api("POST", `/threads/${t.id}/messages`, { author: "agent", text: "done", resolve: true });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).threads[t.id].status, "open", "legacy agent replies cannot auto-resolve");
  const denied = await api("POST", `/threads/${t.id}/status`, { author: "agent", status: "resolved" });
  assert.match(denied.error, /Only the user/);
  const legacyDenied = await api("POST", `/threads/${t.id}/status`, { status: "resolved" });
  assert.match(legacyDenied.error, /Only the user/);
  await api("POST", `/threads/${t.id}/status`, { status: "resolved", author: "user" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).threads[t.id].status, "resolved");

  await api("DELETE", `/threads/${t.id}`);
  assert.ok(!fs.existsSync(file), "no thread file left once the last thread is deleted");
});

test("site settings persist, reject invalid effort, and can return to global defaults", async () => {
  const site = await api("POST", "/sites", { dir: pages });
  await api("PATCH", "/config", { runner: { kind: "claude", model: "opus", effort: "high" } });
  const changed = await api("PATCH", `/sites/${site.id}`, { runner_settings: { kind: "codex", model: "custom-codex", effort: "max" } });
  assert.equal(changed.runner, "codex");
  assert.equal(changed.runner_settings.model, "custom-codex");
  assert.equal(changed.runner_settings.effort, "max");
  assert.equal(changed.runner_override, true);
  const stored = JSON.parse(fs.readFileSync(path.join(home, "db.json"), "utf8"));
  assert.deepEqual(stored.sites[site.id].runnerSettings, { kind: "codex", model: "custom-codex", effort: "max" });
  const invalid = await api("PATCH", `/sites/${site.id}`, { runner_settings: { effort: "bogus" } });
  assert.match(invalid.error, /Unsupported effort/);
  const unchanged = (await api("GET", "/sites")).find((s) => s.id === site.id);
  assert.equal(unchanged.runner_settings.effort, "max");
  const reset = await api("PATCH", `/sites/${site.id}`, { runner_settings: null });
  assert.equal(reset.runner, "claude");
  assert.equal(reset.runner_settings.model, "opus");
  assert.equal(reset.runner_override, false);
  const switched = await api("PATCH", "/config", { runner: { kind: "codex" } });
  assert.equal(switched.runner.model, null);
  assert.equal(switched.runner.effort, null);
});

test.after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});
