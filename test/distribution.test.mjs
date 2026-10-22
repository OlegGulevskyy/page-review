import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "page-review distribution "));
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, PAGE_REVIEW_HOME: path.join(tmp, "review data"), CLAUDE_CONFIG_DIR: path.join(tmp, "claude profile"), CODEX_HOME: path.join(tmp, "codex profile"), NO_COLOR: "1" };
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
env.PAGE_REVIEW_PORT = String(probe.address().port);
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${env.PAGE_REVIEW_PORT}`;
const cli = (...args) => spawnSync(process.execPath, [path.join(root, "src/cli.js"), ...args], { env, encoding: "utf8", timeout: 15000 });
const success = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
const evalNode = (source) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const integrations = pathToFileURL(path.join(root, "src/integrations.js")).href;

test("help, validation, and stopped status do not start a server", () => {
  assert.match(success("help"), /Start here:/);
  assert.match(success("help", "setup"), /claude,codex/);
  assert.equal(cli("unknown-command").status, 1);
  assert.equal(cli("open").status, 1);
  assert.equal(cli("runner", "invalid").status, 1);
  assert.equal(cli("setup", "--yes").status, 1);
  assert.equal(cli("setup", "--skills", "invalid", "--yes").status, 1);
  const status = JSON.parse(success("status", "--json"));
  assert.equal(status.running, false);
  assert.equal(fs.existsSync(env.PAGE_REVIEW_HOME), false);
  assert.match(success("stop"), /already stopped/);
});

test("skill updates preserve prior content and are idempotent", () => {
  const file = path.join(env.CLAUDE_CONFIG_DIR, "skills/page-review/SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "user's previous skill");
  const install = () => evalNode(`import { installSkill } from ${JSON.stringify(integrations)}; console.log(JSON.stringify(installSkill("claude")));`);
  const result = install();
  assert.equal(result.changed, true);
  assert.equal(fs.readFileSync(result.backup, "utf8"), "user's previous skill");
  assert.match(fs.readFileSync(file, "utf8"), /only the user resolves them/i);
  assert.equal(install().changed, false);
  if (process.platform !== "win32") {
    const external = path.join(tmp, "external-skill");
    fs.writeFileSync(external, "shared content");
    fs.unlinkSync(file);
    fs.symlinkSync(external, file);
    install();
    assert.equal(fs.readFileSync(external, "utf8"), "shared content");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  }
});

test("setup permits no skills, installs either client, and reports a readable dashboard", async () => {
  assert.match(success("setup", "--skills", "none", "--runner", "none", "--yes"), /No skills selected/);
  assert.equal(fs.existsSync(path.join(tmp, ".agents/skills/page-review/SKILL.md")), false);
  const first = JSON.parse(success("status", "--json"));
  assert.equal(first.running, true);
  assert.equal(first.runner.kind, "none");
  assert.equal(first.runner.permissions, "accept-edits");
  const otherHome = spawnSync(process.execPath, [path.join(root, "src/cli.js"), "stop"], { env: { ...env, PAGE_REVIEW_HOME: path.join(tmp, "other workspace") }, encoding: "utf8" });
  assert.equal(otherHome.status, 1);
  assert.match(otherHome.stderr, /Another page-review workspace/);
  assert.equal(JSON.parse(success("status", "--json")).running, true);
  success("setup", "--skills", "both", "--runner", "none", "--no-mcp", "--yes");
  assert.ok(fs.existsSync(path.join(tmp, ".agents/skills/page-review/SKILL.md")));
  const output = success("demo", "--no-browser");
  assert.match(output, /Review ready:/);
  const s = JSON.parse(success("status", "--json"));
  assert.equal(s.sites.length, 1);
  assert.match(s.sites[0].url, /\/index.html$/);
  assert.equal(s.sites[0].state, "Ready");
  assert.equal(s.integrations.every((i) => i.skill === "Installed"), true);
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /Your review workspace/);
  assert.match(html, /Default responder/);
  assert.match(html, /Agent setup/);
  assert.match(await fetch(base + "/__review/guide").then((r) => r.text()), /Install and set up/);
  assert.match(await fetch(s.sites[0].url).then((r) => r.text()), /__review\/client.js/);
  // Existing reviews survive a restart and a repeated open.
  success("restart");
  assert.equal(JSON.parse(success("status", "--json")).sites[0].id, s.sites[0].id);
  success("demo", "--no-browser");
  assert.equal(JSON.parse(success("status", "--json")).sites.length, 1);
});

test("agent tools connect over the public MCP entry point", async () => {
  const client = new Client({ name: "distribution-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src/cli.js"), "mcp"], env });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "review_open"));
    assert.ok(tools.some((t) => t.name === "review_reply"));
    const result = await client.callTool({ name: "review_sites", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /welcome/);
  } finally { await client.close(); }
});

test.after(() => {
  cli("stop");
  fs.rmSync(tmp, { recursive: true, force: true });
});
