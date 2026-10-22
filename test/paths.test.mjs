// @path mentions in comments: parsing, resolving against the project, suggestions, and the
// access the agent gets to them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mentions, contextPaths, suggestPaths } from "../src/paths.js";
import { command, buildPrompt } from "../src/runner.js";

// Not under the system temp dir: pages there count as scratch, with no neighbouring projects.
const tmp = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".paths-"));
const project = path.join(tmp, "web");
const api = path.join(tmp, "billing-api");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}");
fs.mkdirSync(path.join(api, "routes"), { recursive: true });
fs.mkdirSync(path.join(api, ".git"));
fs.writeFileSync(path.join(api, "routes", "invoices.ts"), "");
fs.mkdirSync(path.join(tmp, "My Docs"));
const site = { kind: "dir", root: project, projectRoot: project };
const user = (text) => ({ author: "user", text });

test("mentions need a path-looking @, so emails and handles stay text", () => {
  assert.deepEqual(mentions("see @~/dev/api and (@../web/src/), then @/abs/x."), ["~/dev/api", "../web/src/", "/abs/x"]);
  assert.deepEqual(mentions('like @"~/My Docs/spec" says'), ["~/My Docs/spec"]);
  assert.deepEqual(mentions("mail me@example.com or ping @olga, @~ alone"), []);
});

test("context paths resolve from the project root, skip what does not exist, and ignore agent messages", () => {
  const thread = {
    messages: [
      user("compare with @../billing-api/routes and @../nope"),
      { author: "agent", text: "I also looked at @../web" },
      user(`and @${api}/routes/invoices.ts, again @../billing-api/routes/`),
    ],
  };
  assert.deepEqual(contextPaths(thread, site), [
    { path: path.join(api, "routes"), dir: true },
    { path: path.join(api, "routes", "invoices.ts"), dir: false },
  ]);
});

test("suggestions: a bare name searches recent paths and sibling projects, a path lists its directory", () => {
  const names = (items) => items.map((i) => i.label);
  const near = (items) => names(items.filter((i) => i.detail !== "~")); // home folders come last
  assert.deepEqual(near(suggestPaths("", site)), ["billing-api/", "My Docs/"], "siblings, without the project itself");
  assert.deepEqual(near(suggestPaths("BILL", site)), ["billing-api/"]);
  const recent = path.join(api, "routes", "invoices.ts");
  assert.deepEqual(near(suggestPaths("", site, [recent])), ["invoices.ts", "billing-api/", "My Docs/"], "recent first");
  const listed = suggestPaths("../billing-api/", site);
  assert.deepEqual(names(listed), ["routes/"], "dot entries only when asked for");
  assert.equal(listed[0].insert, "../billing-api/routes/");
  assert.deepEqual(names(suggestPaths("../billing-api/.g", site)), [".git/"]);
  assert.deepEqual(names(suggestPaths(`${api}/routes/inv`, site)), ["invoices.ts"]);
  assert.deepEqual(suggestPaths("../missing/", site), []);
});

test("a scratch page in the temp dir suggests home folders, and the neighbours of projects mentioned before", () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "page-review-scratch-")));
  fs.mkdirSync(path.join(path.dirname(scratch), path.basename(scratch) + "-sibling"));
  const scratchSite = { kind: "dir", root: scratch, projectRoot: scratch };
  try {
    const plain = suggestPaths("", scratchSite);
    assert.ok(plain.length && plain.every((i) => i.detail === "~"), "home folders, not the rest of the temp dir");
    const labels = suggestPaths("", scratchSite, [path.join(api, "routes")]).map((i) => i.label);
    assert.deepEqual(labels.slice(0, 3), ["routes/", "billing-api/", "My Docs/"], "recent, then next to its project");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(scratch + "-sibling", { recursive: true, force: true });
  }
});

test("claude can read mentioned folders outside the project but not edit them; codex reads anyway", () => {
  const context = [
    { path: path.join(api, "routes"), dir: true },
    { path: path.join(api, "routes", "invoices.ts"), dir: false },
    { path: path.join(project, "src"), dir: true },
    { path: tmp, dir: true },
  ];
  const { args } = command({ kind: "claude", permissions: "accept-edits" }, "prompt", null, project, context);
  const after = (flag) => args.slice(args.indexOf(flag) + 1, args.findIndex((a, i) => i > args.indexOf(flag) && a.startsWith("--")));
  assert.deepEqual(after("--add-dir"), [path.join(api, "routes"), tmp], "deduplicated, and not the project's own folders");
  assert.deepEqual(after("--disallowedTools"), [`Edit(/${path.join(api, "routes")}/**)`], "an ancestor of the project stays editable");
  assert.equal(args.at(-1), "prompt");
  const codex = command({ kind: "codex", permissions: "accept-edits" }, "prompt", null, project, context).args;
  assert.ok(!codex.includes("--add-dir"), "codex --add-dir would make them writable");
});

test("the prompt names the mentioned paths, fresh and resumed", () => {
  const thread = { id: "t_1", page: "/a.html", messages: [user("see @../billing-api")] };
  const db = { sites: { s: site }, threads: {} };
  for (const resumed of [false, true]) assert.match(buildPrompt(site, { ...thread, siteId: "s" }, db, resumed), /pointed you at `.*billing-api\/` for context.*do not edit/);
  assert.doesNotMatch(buildPrompt(site, { ...thread, siteId: "s", messages: [user("plain")] }, db, false), /pointed you at/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
