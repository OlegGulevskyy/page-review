import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { DATA_DIR, pageUrl } from "./store.js";
import { runnerConfig } from "./runner.js";
import { integrationStatus } from "./integrations.js";
import { VERSION } from "./package.js";

export function buildStatus(db, { running = false, active = [], port = 4848, version = VERSION, listening } = {}) {
  const all = Object.values(db.threads);
  const count = (items) => ({ open: items.filter((t) => t.status === "open").length, resolved: items.filter((t) => t.status === "resolved").length,
    waiting: items.filter((t) => t.status === "open" && t.messages.at(-1)?.author === "user").length });
  return {
    name: "page-review", version, running, dashboard: `http://localhost:${port}/`, dataDir: DATA_DIR,
    runner: runnerConfig(db), activeRuns: active.length, counts: count(all), integrations: integrationStatus(),
    sites: Object.values(db.sites).map((site) => {
      const threads = all.filter((t) => t.siteId === site.id);
      const pages = [...new Set([site.lastPage, ...threads.map((t) => t.page)].filter(Boolean))];
      const missing = site.kind === "dir" && !fs.existsSync(site.root);
      return { id: site.id, label: site.label || (site.root ? path.basename(site.root) : site.target),
        source: site.root || site.target, project: site.projectRoot, runner: runnerConfig(db, site), counts: count(threads),
        state: missing ? "Folder missing" : !running ? "Server stopped" : listening && !listening.includes(site.id) ? "Could not start" : "Ready",
        url: pageUrl(site, site.lastPage || pages.at(-1) || "/"),
        pages: pages.map((page) => ({ path: page, url: pageUrl(site, page) })) };
    }),
  };
}

export const runnerLabel = (kind) => ({ claude: "Claude Code", codex: "Codex", none: "Off — comments are saved without automatic replies", webhook: "Webhook" })[kind] || kind;

export function printStatus(s) {
  console.log(`\n${pc.bold("Page review")} ${pc.dim(`v${VERSION}`)}\n`);
  console.log(`  Server       ${s.running ? pc.green("Running") : pc.yellow("Stopped")}`);
  if (s.running) console.log(`  Status page  ${s.dashboard}`);
  if (s.running && s.version !== VERSION) console.log(pc.yellow(`  Update       Server ${s.version || "unknown"}; run page-review restart to use v${VERSION}.`));
  console.log(`  Replies      ${runnerLabel(s.runner.kind)}`);
  if (["claude", "codex"].includes(s.runner.kind)) {
    console.log(`  Model        ${s.runner.model || "Provider default"}  ·  Effort: ${s.runner.effort || "Default"}`);
    console.log(`  Permissions  ${s.runner.permissions === "bypass" ? "Full access without approval" : "Project file edits; some commands may be blocked"}`);
  }
  console.log(`  Comments     ${s.counts.open} open  ·  ${s.counts.resolved} resolved  ·  ${s.counts.waiting} awaiting reply`);
  console.log(`  Agent runs   ${s.activeRuns} active`);
  console.log(`  Saved data   ${s.dataDir}\n`);
  console.log(pc.bold("Agent setup"));
  for (const i of s.integrations) console.log(`  ${i.name.padEnd(12)} CLI: ${i.cli ? "found" : "not installed"}  ·  Skill: ${i.skill}  ·  Tools: ${i.connection}`);
  console.log(pc.dim("  Connections use your agent's own account. Run its CLI to sign in.\n"));
  console.log(pc.bold("Your review pages"));
  if (!s.sites.length) console.log("  No pages yet. Try: page-review demo");
  for (const site of s.sites) {
    console.log(`\n  ${pc.bold(site.label)}  ${pc.dim(site.state)}`);
    console.log(`  ${site.url}\n  ${site.source}`);
    console.log(`  ${site.counts.open} open · ${site.counts.waiting} awaiting reply · Replies: ${runnerLabel(site.runner.kind)}`);
  }
  console.log(`\n${pc.bold("Next steps")}\n  page-review open ./report.html   Open a file for review\n  page-review setup                Install skills or fix agent connections\n  page-review status --open        Open the browser status page\n  page-review help                 See commands and examples\n`);
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function statusHtml(s) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="20"><title>Page review · Status</title>
  <style>
  :root{font-family:system-ui,sans-serif;color:#25352f;background:#f5f4ee;line-height:1.55}body{max-width:1080px;margin:48px auto;padding:0 24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:42px;letter-spacing:-1.5px;line-height:1.1;margin:12px 0}h2{font-size:21px;margin:0 0 16px}h3{margin:0;font-size:17px}p{margin:8px 0 18px}.muted,small{color:#637168}.badge{display:inline-block;padding:5px 12px;border-radius:24px;background:#dcecdf;color:#285b3e;font-size:13px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.stat,section{border:1px solid #dce1d8;border-radius:14px;background:#fff;padding:22px}.stat strong{font-size:30px;display:block}.stat span{font-size:13px;color:#637168}main{display:grid;grid-template-columns:1.5fr 1fr;gap:22px}section{margin-bottom:22px}.site{padding:18px 0;border-top:1px solid #e6e8e2}.site:first-of-type{border-top:0}.site a{font-weight:600;overflow-wrap:anywhere}a{color:#24644a}code{font:13px ui-monospace,monospace;background:#f0f2ec;border-radius:5px;padding:3px 6px;overflow-wrap:anywhere}.command{display:block;margin:12px 0;padding:12px;white-space:pre-wrap}.source{font-size:12px;overflow-wrap:anywhere}.agent{margin:16px 0}dl{display:grid;grid-template-columns:100px 1fr;font-size:14px;gap:10px}dt{color:#637168}dd{margin:0;overflow-wrap:anywhere}footer{color:#637168;font-size:12px;padding:10px 0 30px}.steps{padding-left:20px}.steps li{margin:10px 0}@media(max-width:700px){body{margin:24px auto;padding:0 16px}main{display:block}.stats{grid-template-columns:repeat(2,1fr)}h1{font-size:34px}header{align-items:flex-start}}
  </style>
  <header><div><small>PAGE REVIEW · v${esc(s.version)}</small><h1>Your review workspace</h1><p class="muted">Pages, comments, and the agents helping you improve them.</p></div><span class="badge">Server running</span></header>
  <div class="stats"><div class="stat"><strong>${s.sites.length}</strong><span>Review sites</span></div><div class="stat"><strong>${s.counts.open}</strong><span>Open comments</span></div><div class="stat"><strong>${s.counts.waiting}</strong><span>Awaiting a reply</span></div><div class="stat"><strong>${s.activeRuns}</strong><span>Agents working</span></div></div>
  <main><div><section><h2>Your pages</h2>${s.sites.length ? s.sites.map((site) => `<article class="site"><h3><a href="${esc(site.url)}">${esc(site.label)}</a></h3><p class="muted source">${esc(site.source)}</p><p>${esc(site.state)} · ${site.counts.open} open · ${site.counts.resolved} resolved</p><p class="muted">Replies: ${esc(runnerLabel(site.runner.kind))}</p>${site.pages.map((page) => `<div><a href="${esc(page.url)}">${esc(page.path)}</a></div>`).join("")}</article>`).join("") : `<p>No review pages yet. Start with a sample:</p><code class="command">page-review demo</code><p>Or open an HTML file on your computer:</p><code class="command">page-review open ./report.html</code>`}</section>
  <section><h2>How a review works</h2><ol class="steps"><li>Open a page using <code>page-review open</code>.</li><li>Select text and click <strong>Comment</strong>, or Alt+click an element.</li><li>Your agent answers and makes requested changes.</li><li>Review the result and click <strong>Resolve</strong> when you are happy.</li></ol><p class="muted">Choose a different provider, model, or effort in the page’s Comments → Agent settings.</p></section></div>
  <div><section><h2>Default responder</h2><dl><dt>Provider</dt><dd>${esc(runnerLabel(s.runner.kind))}</dd><dt>Model</dt><dd>${esc(s.runner.model || "Provider default")}</dd><dt>Effort</dt><dd>${esc(s.runner.effort || "Default")}</dd><dt>Permissions</dt><dd>${s.runner.permissions === "bypass" ? "Full access without approval" : "Project file edits; some commands may be blocked"}</dd></dl><p class="muted">Individual sites can override these defaults.</p><code class="command">page-review setup</code></section>
  <section><h2>Agent setup</h2>${s.integrations.map((i) => `<div class="agent"><strong>${esc(i.name)}</strong><div class="muted">CLI: ${i.cli ? "Found" : "Not installed"}<br>Skill: ${esc(i.skill)}<br>Tools: ${esc(i.connection)}</div></div>`).join("")}<p class="muted">Run setup to install skills and connect tools. Sign in through your agent’s own CLI.</p></section>
  <section><h2>Need a hand?</h2><code class="command">page-review help</code><p><a href="/__review/guide">Read the getting-started guide</a></p><p class="source muted">Local data: ${esc(s.dataDir)}<br>Comments on HTML files are saved beside them in .page-review.json.</p></section></div></main>
  <footer>Runs on your computer · Page refreshes every 20 seconds · <a href="/">Refresh now</a></footer></html>`;
}
