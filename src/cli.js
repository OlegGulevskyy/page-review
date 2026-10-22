#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import open from "open";
import { Command, Option, InvalidArgumentError } from "commander";
import { api, openTarget, ensureServer, stopServer, serverHealth, PORT } from "./control.js";
import { DATA_DIR, loadDb } from "./store.js";
import { VERSION, PACKAGE_ROOT } from "./package.js";
import { setup } from "./setup.js";
import { buildStatus, printStatus, runnerLabel } from "./status.js";

const program = new Command();
const kinds = ["claude", "codex", "webhook", "none"];
const positive = (s) => {
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new InvalidArgumentError("Enter a positive whole number.");
  return Number(s);
};
async function browse(url) {
  try { await open(url, { wait: false }); }
  catch { console.error(`Could not open a browser automatically. Open this address yourself: ${url}`); }
}
async function review(target, options) {
  const { site, url } = await openTarget(target, options.webhook, options.context, { project_root: options.project, runner: options.runner });
  console.log(`\nReview ready: ${url}`);
  console.log(`Replies: ${runnerLabel(site.runner)}`);
  if (site.projectRoot) console.log(`Project: ${site.projectRoot}`);
  console.log("Select text and click Comment. You decide when to resolve each thread.\n");
  if (options.browser !== false) await browse(url);
}

program.name("page-review").version(VERSION)
  .description("Review HTML pages with your coding agent.\nOpen a page, leave comments in your browser, and let Claude Code or Codex help.\nYou review the changes and resolve each thread yourself.")
  .showHelpAfterError("Run 'page-review help' for commands and examples.")
  .addHelpText("after", `
Start here:
  npm install -g page-review
  page-review setup                  Choose Claude, Codex, both, or neither
  page-review demo                   Try a sample page
  page-review open ./report.html     Review your own HTML file

Everyday use:
  page-review open ./website         Review a folder of pages
  page-review open http://localhost:3000 --project ./my-app
  page-review status --open          View pages, comments, and agent setup
  page-review runner codex           Change the default agent
  page-review help open              Read help for one command

An agent CLI and its signed-in account are needed for automatic replies.
Setup installs the skills and connects tools; it explains any missing prerequisites.
The server runs locally in the background. Use 'page-review stop' when finished.
Local data: ~/.page-review (override with PAGE_REVIEW_HOME).
Control port: 4848 (override with PAGE_REVIEW_PORT).
`);

program.command("setup").description("Guided setup: install agent skills and connect Claude Code or Codex")
  .option("--skills <agents>", "Skills to install: claude, codex, claude,codex, both, or none")
  .option("-y, --yes", "Use defaults without prompts (requires --skills)")
  .option("--no-mcp", "Install skills without connecting agent tools")
  .addOption(new Option("--runner <provider>", "Default responder").choices(kinds))
  .addOption(new Option("--permissions <mode>", "What the agent may do").choices(["accept-edits", "bypass"]))
  .addHelpText("after", "\nExamples:\n  page-review setup\n  page-review setup --skills claude,codex --runner codex --yes\n  page-review setup --skills none --runner none --yes\n\nSkills are recommended, but optional. Existing skill files are backed up before updating.\nRerun setup after upgrading page-review or changing your Node installation.\n")
  .action(setup);

program.command("open <file-or-url>").description("Open an HTML file, folder, or running website for review")
  .option("--project <directory>", "Source project the agent should work in")
  .option("--context <notes>", "Explain the page or how its source is generated")
  .addOption(new Option("--runner <provider>", "Override the agent for this site").choices(kinds))
  .option("--webhook <url>", "Notify an external automation when comments arrive")
  .option("--no-browser", "Print the review address without opening a browser")
  .addHelpText("after", '\nExamples:\n  page-review open "./My report.html"\n  page-review open ./dist --project . --context "Built with npm run build"\n  page-review open http://localhost:3000 --project ./my-app\n\nThe server starts automatically. HTML is shown with a comment overlay.\nFor a generated page, point --project to its source and explain the build in --context.\n')
  .action(review);

program.command("demo").description("Open a sample HTML page to try commenting")
  .option("--no-browser", "Print the review address without opening a browser")
  .action(async (options) => {
    const dir = path.join(DATA_DIR, "examples", "welcome");
    const file = path.join(dir, "index.html");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.copyFileSync(path.join(PACKAGE_ROOT, "examples/welcome.html"), file);
    await review(file, { ...options, project: dir, context: "This is a sample page. Edit index.html directly when asked." });
  });

program.command("status").description("Show server health, review pages, and agent setup")
  .option("--open", "Start the server if needed and open the browser status page")
  .option("--json", "Print structured status for scripts")
  .action(async (options) => {
    if (options.open) await ensureServer();
    const health = await serverHealth();
    let status;
    if (health?.version === VERSION) status = await api("GET", "/status", undefined, { start: false });
    else status = buildStatus(loadDb(), { running: Boolean(health), port: PORT, version: health?.version || "unknown" });
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    if (options.open) await browse(status.dashboard);
  });

program.command("start").description("Start the local server in the background")
  .action(async () => { await ensureServer(); console.log(`Server ready: http://localhost:${PORT}/\nOpen a file with: page-review open ./report.html`); });
program.command("stop").description("Stop the local server; saved comments are kept")
  .action(async () => console.log(await stopServer() ? "Server stopped. Your comments are saved." : "Server is already stopped."));
program.command("restart").description("Restart the server after an upgrade; saved reviews reopen")
  .action(async () => { await stopServer(); await ensureServer(); console.log(`Server restarted: http://localhost:${PORT}/`); });
program.command("guide").description("Open the getting-started guide")
  .action(async () => { const file = path.join(PACKAGE_ROOT, "README.html"); console.log(file); await browse(file); });

program.command("runner [provider]").description("Show or change the default agent, model, and effort")
  .addOption(new Option("--model <name>", "Provider model name (use default to reset)"))
  .option("--effort <level>", "Provider effort level (use default to reset)")
  .addOption(new Option("--permissions <mode>", "Edit project files or allow full access").choices(["accept-edits", "bypass"]))
  .option("--max-parallel <count>", "Maximum simultaneous agent runs", positive)
  .option("--timeout <minutes>", "Time limit for each agent run", positive)
  .addHelpText("after", "\nExamples:\n  page-review runner\n  page-review runner codex --effort high\n  page-review runner claude --model opus --effort high\n  page-review runner --model default --effort default\n  page-review runner none\n\nThe page's Comments → Agent settings can override these defaults for that site.\nModel availability depends on your provider and account.\n")
  .action(async (provider, options) => {
    if (provider && !kinds.includes(provider)) throw new Error(`Unknown provider '${provider}'. Choose ${kinds.join(", ")}.`);
    const runner = {};
    if (provider) runner.kind = provider;
    for (const key of ["model", "effort", "permissions", "maxParallel"]) if (options[key] !== undefined) runner[key] = options[key] === "default" ? null : options[key];
    if (options.timeout !== undefined) runner.timeoutMin = options.timeout;
    const write = Object.keys(runner).length > 0;
    const c = await api(write ? "PATCH" : "GET", "/config", write ? { runner } : undefined);
    console.log(`Replies: ${runnerLabel(c.runner.kind)}\nModel: ${c.runner.model || "Provider default"}\nEffort: ${c.runner.effort || "Default"}\nPermissions: ${c.runner.permissions}\nParallel runs: ${c.runner.maxParallel}\nTimeout: ${c.runner.timeoutMin} minutes`);
  });

program.command("list [status]").description("List comment threads: open (default), resolved, or all")
  .action(async (status = "open") => {
    if (!["open", "resolved", "all"].includes(status)) throw new Error("Choose open, resolved, or all.");
    const list = await api("GET", `/threads?status=${status}`);
    for (const t of list) console.log(`${t.needs_reply ? "●" : "○"} ${t.id}  ${t.url}\n   “${t.quote.slice(0, 80)}”\n   ${t.last_message.slice(0, 120)}`);
    if (!list.length) console.log("No threads yet. Open a page and leave a comment to get started.");
  });
program.command("get <thread-id>").description("Read a thread and mark it as being worked on")
  .action(async (id) => {
    const t = await api("GET", `/threads/${encodeURIComponent(id)}`);
    if (t.needs_reply) await api("POST", `/threads/${t.id}/status`, { agent: "working" });
    console.log(JSON.stringify({ id: t.id, status: t.status, url: t.url, file: t.file, project_root: t.project_root, site_context: t.site_context, anchor: t.anchor, messages: t.messages.map((m) => ({ author: m.author, text: m.text, at: m.at })) }, null, 2));
  });
program.command("reply <thread-id> <text...>").description("Add an agent reply; the thread stays open for the user")
  .option("--anchor-text <text>", "The commented text as it now reads, when your change rewrote it")
  .addOption(new Option("--resolve", "Ignored: only the user resolves threads").hideHelp())
  .action(async (id, words, options) => {
    if (options.resolve) console.error("Threads stay open until the user resolves them in the browser.");
    const t = await api("POST", `/threads/${encodeURIComponent(id)}/messages`, { author: "agent", name: process.env.PAGE_REVIEW_AGENT_NAME || "Agent", text: words.join(" "), anchor_text: options.anchorText });
    console.log(`${t.id} ${t.status} (${t.messages.length} messages)`);
  });
program.command("log <thread-id>").description("Read the last agent run's output to troubleshoot a reply")
  .action(async (id) => {
    const t = await api("GET", `/threads/${encodeURIComponent(id)}`);
    if (!t.lastRun?.log) throw new Error("No agent run yet for this thread.");
    console.log(`${t.lastRun.kind} ${t.lastRun.startedAt} → ${t.lastRun.endedAt || "running"} exit=${t.lastRun.exitCode ?? "-"}\n`);
    process.stdout.write(fs.readFileSync(t.lastRun.log, "utf8"));
  });
program.command("webhook [site-or-url] [url]").description("Configure an advanced webhook integration; omit URL to clear it")
  .option("--default", "Set the default webhook")
  .option("--project <directory>", "Set the webhook for a source project")
  .action(async (siteOrUrl, url, options) => {
    if (options.default && options.project) throw new Error("Choose either --default or --project.");
    if (options.default) {
      await api("PATCH", "/config", { defaultWebhook: siteOrUrl || "" });
    } else if (options.project) {
      const root = path.resolve(options.project.replace(/^~(?=\/)/, os.homedir()));
      await api("PATCH", "/config", { project_webhook: { root, url: siteOrUrl || "" } });
    } else {
      if (!siteOrUrl) throw new Error("Provide a site ID, --default, or --project <directory>.");
      await api("PATCH", `/sites/${encodeURIComponent(siteOrUrl)}`, { webhook: url || "" });
    }
    console.log("Webhook setting saved.");
  });
program.command("mcp").description("Run the agent tool connection over stdio (for MCP clients)")
  .action(async () => { await import("./mcp.js"); });
program.command("t3-task-root <id>", { hidden: true }).action(async (id) => (await import("./t3-legacy.js")).t3TaskRoot(id));

try {
  if (process.argv.length === 2) program.outputHelp();
  else await program.parseAsync();
} catch (e) {
  console.error(`\n${e.message}\n`);
  process.exitCode = 1;
}
