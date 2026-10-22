import * as p from "@clack/prompts";
import pc from "picocolors";
import { CLIENTS, findExecutable, installSkill, registerMcp } from "./integrations.js";
import { loadDb } from "./store.js";
import { api, ensureServer } from "./control.js";

export function parseSkills(value) {
  if (value === "none") return [];
  if (value === "both") return Object.keys(CLIENTS);
  const kinds = [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!kinds.length || kinds.some((k) => !CLIENTS[k])) throw new Error("Choose claude, codex, both, or none for --skills.");
  return kinds;
}

class Cancelled extends Error {}
function answer(value) {
  if (p.isCancel(value)) throw new Cancelled();
  return value;
}

export async function setup(options) {
  const interactive = !options.yes && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive && options.skills === undefined) throw new Error("Setup needs a terminal for the selection menu. For automation, use: page-review setup --skills claude,codex --yes");
  const installed = Object.keys(CLIENTS).filter((k) => findExecutable(k));
  const current = loadDb().config?.runner || {};
  let kinds = options.skills === undefined ? null : parseSkills(options.skills);
  let kind = options.runner, permissions = options.permissions;
  try {
    p.intro(pc.bgCyan(pc.black(" page-review setup ")));
    p.note("Review HTML pages in your browser. Leave comments; your coding agent answers and makes changes.\nSkills teach your agent how to open and work with reviews.", "Welcome");
    if (kinds === null) kinds = answer(await p.multiselect({
      message: "Which agents should get the page-review skill? We strongly recommend at least one.",
      options: Object.entries(CLIENTS).map(([value, label]) => ({ value, label, hint: installed.includes(value) ? "CLI found" : "CLI not found; skill can still be installed" })),
      initialValues: installed.length ? installed : Object.keys(CLIENTS), required: false,
    }));
    if (!kinds.length) p.log.warn("No skills selected for installation. Without a skill, your agent may not discover the review workflow. You can still open pages from the terminal and rerun setup anytime.");
    const preferred = current.kind || kinds.find((k) => installed.includes(k)) || installed[0] || "none";
    if (!kind && interactive) kind = answer(await p.select({
      message: "Who should answer new comments?",
      options: [
        ...Object.entries(CLIENTS).map(([value, label]) => ({ value, label, hint: installed.includes(value) ? "Uses your own signed-in account" : "Install and sign in to its CLI first" })),
        { value: "none", label: "No automatic replies yet", hint: "Collect comments and choose an agent later" },
        ...(current.kind === "webhook" ? [{ value: "webhook", label: "Keep the existing webhook" }] : []),
      ], initialValue: preferred,
    }));
    kind ||= preferred;
    if (!permissions && interactive && ["claude", "codex"].includes(kind)) permissions = answer(await p.select({
      message: "What may the agent do automatically?",
      options: [
        { value: "accept-edits", label: "Edit project files", hint: "Recommended. Some commands may be blocked in unattended runs." },
        { value: "bypass", label: "Edit files and run commands without approval", hint: "Full access. Only use with projects you trust." },
      ], initialValue: current.permissions || "accept-edits",
    }));
    permissions ||= current.permissions || "accept-edits";
    // All prompts finish before setup writes anything; Ctrl+C leaves the installation unchanged.
    await ensureServer();
    const results = [];
    for (const agent of kinds) {
      try {
        const skill = installSkill(agent);
        p.log.success(`${CLIENTS[agent]} skill ${skill.changed ? "installed" : "already up to date"}\n${skill.file}`);
        if (skill.backup) p.log.info(`Previous skill backed up to ${skill.backup}`);
        if (options.mcp !== false) {
          const connection = registerMcp(agent);
          if (connection.connected) p.log.success(`${CLIENTS[agent]} agent connection ready`);
          else { p.log.warn(connection.reason); results.push(connection.reason); }
        }
      } catch (e) { results.push(e.message); p.log.error(e.message); }
    }
    await api("PATCH", "/config", { runner: { kind, permissions } });
    if (CLIENTS[kind] && !installed.includes(kind)) {
      const message = `${CLIENTS[kind]} cannot answer comments until its CLI is installed and signed in.`;
      if (!results.includes(message)) results.push(message);
      p.log.warn(message);
    }
    if (results.length) p.note(
      "Claude Code: https://code.claude.com/docs/en/setup\nCodex: npm install -g @openai/codex, then run codex to sign in.\nAfter installing or fixing a client, rerun page-review setup.", "Finish connecting your agent");
    p.note("page-review demo                  Try a sample page\npage-review open ./report.html     Review your own file\npage-review status --open          Open the status page\npage-review help                   See all commands\n\nRestart your agent session to discover the new skill and tools.", "Next steps");
    p.outro(results.length ? "Setup saved. Some agent connections still need attention." : "You're ready to review a page.");
    if (results.length) process.exitCode = 1;
  } catch (e) {
    if (e instanceof Cancelled) { p.cancel("Setup cancelled. No changes made."); process.exitCode = 130; return; }
    throw e;
  }
}
