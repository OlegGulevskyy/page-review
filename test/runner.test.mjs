// The runner starts the agent CLI in the project directory, resumes the session on the next
// comment, and reports a run that ends without a reply. Uses a fake `claude` on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-review-runner-"));
const home = path.join(tmp, "home");
const project = path.join(tmp, "project");
const pages = path.join(project, "out");
const bin = path.join(tmp, "bin");
fs.mkdirSync(pages, { recursive: true });
fs.mkdirSync(bin);
fs.writeFileSync(path.join(project, "CLAUDE.md"), "# demo");
fs.writeFileSync(path.join(pages, "a.html"), "<html><body><p>alpha beta</p></body></html>");
// fake claude: records argv + cwd, replies in the thread through the API, prints a session id
fs.writeFileSync(
  path.join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const prompt = args.at(-1);
const id = prompt.match(/thread (t_[a-f0-9]+)/)[1];
const resume = args.indexOf(args[0] === "exec" ? "resume" : "--resume");
(async () => {
  if (!fs.existsSync(process.env.FAKE_LOG + ".silent")) {
    await fetch(\`http://127.0.0.1:\${process.env.PAGE_REVIEW_PORT}/__review/api/threads/\${id}/messages\`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "agent", name: "Claude", text: resume >= 0 ? "resumed " + args[resume + 1] : "first reply", resolve: true }),
    });
  }
  console.log(JSON.stringify({ type: "result", session_id: "sess-" + id }));
})();
`,
  { mode: 0o755 },
);
fs.copyFileSync(path.join(bin, "claude"), path.join(bin, "codex"));

const PORT = 4960 + Math.floor(Math.random() * 30);
const fakeLog = path.join(tmp, "fake.log");
const env = { ...process.env, PAGE_REVIEW_HOME: home, PAGE_REVIEW_PORT: String(PORT), PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: fakeLog };
const server = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], { env, stdio: "ignore" });
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/__review/api${p}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error("timed out");
};
for (let i = 0; i < 40; i++) {
  await sleep(100);
  if (await fetch(`http://127.0.0.1:${PORT}/__review/api/health`).then((r) => r.ok).catch(() => false)) break;
}

test("a comment starts the agent in the project, the next one resumes the session", async () => {
  const site = await api("POST", "/sites", { dir: pages, context: "demo page" });
  assert.equal(site.runner, "claude");
  assert.equal(site.projectRoot, project);

  const t = await api("POST", "/threads", { siteId: site.id, page: "/a.html", anchor: { kind: "text", exact: "beta" }, text: "what is this?" });
  assert.equal(t.agent, "pending");
  let got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.messages.length === 2 ? x : null;
  });
  assert.equal(got.messages[1].text, "first reply");
  assert.equal(got.worker, "Claude");
  got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.session ? x : null;
  });
  assert.deepEqual(got.session, { kind: "claude", id: `sess-${t.id}` });
  assert.equal(got.agent, "idle");
  assert.equal(got.status, "open", "finished runs leave resolution to the user");
  const runs = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(runs.length, 1);
  assert.equal(fs.realpathSync(runs[0].cwd), fs.realpathSync(project), "runs in the project root, not the page directory");
  assert.ok(runs[0].args.includes("acceptEdits"));
  assert.ok(!runs[0].args.includes("--dangerously-skip-permissions"));
  assert.ok(runs[0].args.includes("--mcp-config"));
  assert.ok(!runs[0].args.includes("--resume"));
  assert.match(runs[0].args.at(-1), /demo page/, "site context is in the prompt");
  assert.match(runs[0].args.at(-1), /Only the user resolves threads/);

  await api("PATCH", `/sites/${site.id}`, { runner_settings: { kind: "claude", model: "opus", effort: "max" } });
  await api("POST", `/threads/${t.id}/messages`, { author: "user", text: "and more?" });
  got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.messages.length === 4 ? x : null;
  });
  assert.equal(got.messages[3].text, `resumed sess-${t.id}`);
  const runs2 = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(runs2.length, 2);
  assert.equal(runs2[1].args[runs2[1].args.indexOf("--model") + 1], "opus");
  assert.equal(runs2[1].args[runs2[1].args.indexOf("--effort") + 1], "max");
  assert.match(runs2[1].args.at(-1), /Only the user resolves threads/);
  assert.ok(fs.existsSync(path.join(home, "runs", `${t.id}.log`)));
  await until(async () => (await api("GET", `/threads/${t.id}`)).lastRun.endedAt);

  await api("PATCH", `/sites/${site.id}`, { runner_settings: { kind: "codex", model: "custom-codex", effort: "high" } });
  await api("POST", `/threads/${t.id}/messages`, { author: "user", text: "use the new provider" });
  got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.session?.kind === "codex" && x.lastRun.endedAt ? x : null;
  });
  assert.equal(got.lastRun.resumed, false, "provider changes start a fresh session with the existing thread context");
  assert.equal(got.lastRun.model, "custom-codex");
  assert.equal(got.lastRun.effort, "high");
  assert.equal(got.status, "open");
  const runs3 = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(runs3[2].args[0], "exec");
  assert.ok(runs3[2].args.includes("workspace-write"));
  assert.ok(runs3[2].args.some((arg) => arg.startsWith("mcp_servers.page-review.command=")));
  assert.equal(runs3[2].args[runs3[2].args.indexOf("-m") + 1], "custom-codex");
  assert.ok(runs3[2].args.includes('model_reasoning_effort="high"'));
  assert.ok(!runs3[2].args.includes("resume"));
  await api("PATCH", `/sites/${site.id}`, { runner_settings: { model: null, effort: null } });
  await api("POST", `/threads/${t.id}/messages`, { author: "user", text: "use CLI defaults" });
  got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.messages.length === 8 && x.lastRun.endedAt ? x : null;
  });
  assert.equal(got.lastRun.resumed, false, "default settings must not retain a previous session override");
  assert.equal(got.lastRun.model, null);
  assert.equal(got.lastRun.effort, null);
  await api("PATCH", `/sites/${site.id}`, { runner_settings: null });
});

test("an @-mentioned folder is suggested, remembered, and readable by the run", async () => {
  const other = path.join(tmp, "other-api");
  fs.mkdirSync(path.join(other, "routes"), { recursive: true });
  const site = await api("POST", "/sites", { dir: pages });
  const suggested = await api("GET", `/paths?site=${site.id}&q=../oth`);
  assert.equal(suggested[0].path, other, "relative paths list from the project root");
  const before = fs.readFileSync(fakeLog, "utf8").trim().split("\n").length;
  const t = await api("POST", "/threads", { siteId: site.id, page: "/a.html", text: "match @../other-api/routes please" });
  assert.deepEqual((await api("GET", `/threads/${t.id}`)).context_paths, [path.join(other, "routes")]);
  await until(async () => (await api("GET", `/threads/${t.id}`)).lastRun?.endedAt);
  const run = fs.readFileSync(fakeLog, "utf8").trim().split("\n").slice(before).map(JSON.parse)[0];
  assert.equal(run.args[run.args.indexOf("--add-dir") + 1], path.join(other, "routes"));
  assert.match(run.args.at(-1), /other-api\/routes\/` for context/);
  assert.equal((await api("GET", `/paths?site=${site.id}&q=`))[0].path, path.join(other, "routes"), "recently mentioned comes first");
});

test("turning the runner off cancels a pending run", async () => {
  const site = await api("POST", "/sites", { dir: pages });
  const before = fs.readFileSync(fakeLog, "utf8");
  const t = await api("POST", "/threads", { siteId: site.id, page: "/a.html", text: "cancel before launch" });
  await api("PATCH", `/sites/${site.id}`, { runner_settings: { kind: "none" } });
  await until(async () => (await api("GET", `/threads/${t.id}`)).agent === "idle");
  assert.equal(fs.readFileSync(fakeLog, "utf8"), before);
  await api("PATCH", `/sites/${site.id}`, { runner_settings: null });
});

test("a run that ends without replying is reported in the thread", async () => {
  fs.writeFileSync(fakeLog + ".silent", "");
  const site = await api("POST", "/sites", { dir: pages });
  const t = await api("POST", "/threads", { siteId: site.id, page: "/a.html", text: "silence please" });
  const got = await until(async () => {
    const x = await api("GET", `/threads/${t.id}`);
    return x.messages.length === 2 ? x : null;
  });
  assert.match(got.messages[1].text, /Claude run ended \(exit 0\) without replying/);
  assert.equal(got.messages[1].name, "page-review");
  assert.equal(got.agent, "idle");
  assert.equal(got.needs_reply, false, "a note from page-review counts as an answer, so it does not spin forever");
});

test.after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});
