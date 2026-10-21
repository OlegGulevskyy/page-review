// Local agent runner: answers a thread by running `claude` or `codex` headless in the project
// directory the page lives in. One run per thread at a time; the session id is kept on the thread
// so the next comment in the same thread resumes the same conversation.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { now, pageUrl, threadSummary, DATA_DIR } from "./store.js";

export const DEFAULTS = { kind: "claude", permissions: "bypass", maxParallel: 3, timeoutMin: 20, model: null, effort: null };
export const KINDS = ["claude", "codex", "webhook", "none"];
const WAKE_DEBOUNCE_MS = 2500;
const RUNS_DIR = path.join(DATA_DIR, "runs");
const NAMES = { claude: "Claude", codex: "Codex" };

export function runnerConfig(db, site) {
  const cfg = { ...DEFAULTS, ...(db.config?.runner || {}) };
  const kind = site?.runnerSettings?.kind || site?.runner || cfg.kind;
  // Model IDs and effort settings belong to their provider.
  if (kind !== cfg.kind) Object.assign(cfg, { model: null, effort: null });
  return { ...cfg, kind, ...site?.runnerSettings };
}

export function createRunner({ db, saveDb, emitThread, scheduleWebhook, webhookFor }) {
  const timers = new Map(); // threadId -> debounce timeout
  const active = new Map(); // threadId -> { child, startedMessages }
  const queue = []; // [{ site, thread }]

  // Can anyone answer this site's threads? Decides the "pending" state shown in the browser.
  function canWake(site) {
    const cfg = runnerConfig(db, site);
    if (cfg.kind === "none") return false;
    if (cfg.kind === "webhook") return Boolean(webhookFor(site));
    return true;
  }

  function wake(site, thread, text) {
    const cfg = runnerConfig(db, site);
    if (cfg.kind === "none") return;
    if (cfg.kind === "webhook") return scheduleWebhook(site, thread, text);
    clearTimeout(timers.get(thread.id));
    timers.set(
      thread.id,
      setTimeout(() => {
        timers.delete(thread.id);
        enqueue(site, thread);
      }, WAKE_DEBOUNCE_MS),
    );
  }

  function enqueue(site, thread) {
    if (active.has(thread.id)) return; // the run checks for new messages when it ends
    if (queue.some((q) => q.thread.id === thread.id)) return;
    queue.push({ site, thread });
    pump();
  }

  function pump() {
    while (queue.length && active.size < runnerConfig(db).maxParallel) {
      const { site, thread } = queue.shift();
      if (db.threads[thread.id]) launch(site, db.threads[thread.id]);
    }
  }

  function needsReply(t) {
    return t.status === "open" && t.messages.at(-1)?.author === "user";
  }

  function postNote(thread, text) {
    thread.messages.push({ id: `m_${Date.now().toString(36)}`, author: "agent", name: "page-review", text, at: now() });
    thread.updatedAt = now();
  }

  function launch(site, thread) {
    const cfg = runnerConfig(db, site);
    // Settings or status may have changed while this run was waiting in the queue.
    if (!needsReply(thread) || cfg.kind === "none" || cfg.kind === "webhook") {
      const wakeWebhook = needsReply(thread) && cfg.kind === "webhook" && canWake(site);
      thread.agent = wakeWebhook ? "pending" : "idle";
      if (wakeWebhook) scheduleWebhook(site, thread, thread.messages.at(-1).text);
      saveDb(db);
      emitThread(thread);
      return;
    }
    const cwd = site.projectRoot || site.root;
    if (!cwd || !fs.existsSync(cwd)) {
      postNote(thread, `No project directory to run in for this site. Register it with review_open (project_root) or \`page-review open … --project <dir>\`.`);
      thread.agent = "idle";
      saveDb(db);
      emitThread(thread);
      return;
    }
    // An omitted CLI flag on resume can retain the old session setting instead of its default.
    const resetDefaults = ["model", "effort"].some((key) => !cfg[key] && thread.lastRun?.[key]);
    const session = thread.session?.kind === cfg.kind && !resetDefaults ? thread.session.id : null;
    const prompt = buildPrompt(site, thread, db, Boolean(session));
    const { cmd, args } = command(cfg, prompt, session, cwd);

    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const logFile = path.join(RUNS_DIR, `${thread.id}.log`);
    const log = fs.openSync(logFile, "a");
    fs.writeSync(log, `\n=== ${now()} ${cmd} ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")} (cwd ${cwd})\n`);

    const env = { ...process.env };
    // the server may have been spawned with a minimal PATH (from an MCP host): add the usual places
    env.PATH = [env.PATH, path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    delete env.CLAUDECODE; // we may be running under Claude Code; the child is its own session
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", log] });
    } catch (e) {
      postNote(thread, `Could not start ${NAMES[cfg.kind]}: ${e.message}`);
      thread.agent = "idle";
      saveDb(db);
      emitThread(thread);
      return;
    }
    thread.agent = "working";
    thread.worker = NAMES[cfg.kind];
    thread.lastRun = { kind: cfg.kind, model: cfg.model, effort: cfg.effort, startedAt: now(), log: logFile, resumed: Boolean(session) };
    saveDb(db);
    emitThread(thread);
    console.log(`run ${thread.id} ${cfg.kind}${session ? " (resume)" : ""} in ${cwd}`);

    const entry = { child, startedMessages: thread.messages.length };
    active.set(thread.id, entry);
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      fs.writeSync(log, c);
    });
    const killer = setTimeout(() => {
      fs.writeSync(log, `\n--- timeout after ${cfg.timeoutMin} min, killing\n`);
      child.kill("SIGTERM");
    }, cfg.timeoutMin * 60_000);
    child.on("error", (e) => fs.writeSync(log, `\n--- spawn error: ${e.message}\n`));
    child.on("close", (code) => {
      clearTimeout(killer);
      fs.closeSync(log);
      active.delete(thread.id);
      const t = db.threads[thread.id];
      if (t) {
        const sessionId = sessionFrom(cfg.kind, out);
        if (sessionId) t.session = { kind: cfg.kind, id: sessionId };
        t.lastRun = { ...t.lastRun, endedAt: now(), exitCode: code };
        if (needsReply(t) && t.messages.length === entry.startedMessages) {
          // the agent never replied: say so in the thread rather than leaving it spinning
          postNote(t, `${NAMES[cfg.kind]} run ended (exit ${code}) without replying. Log: \`${logFile}\``);
          t.agent = "idle";
        } else if (needsReply(t)) {
          t.agent = "pending"; // new user message during the run: go again
          enqueue(site, t);
        } else if (t.agent === "working") t.agent = "idle";
        saveDb(db);
        emitThread(t);
      }
      console.log(`run ${thread.id} ${cfg.kind} exit ${code}`);
      pump();
    });
  }

  return { wake, canWake, active: () => [...active.keys()] };
}

export function command(cfg, prompt, session, cwd) {
  const bypass = cfg.permissions !== "accept-edits";
  if (cfg.kind === "codex") {
    const args = ["exec", "--json", "-C", cwd, "--skip-git-repo-check"];
    args.push(bypass ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto");
    if (cfg.model) args.push("-m", cfg.model);
    if (cfg.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(cfg.effort)}`);
    if (session) args.push("resume", session, prompt);
    else args.push(prompt);
    return { cmd: "codex", args };
  }
  const args = ["-p", "--output-format", "json"];
  if (session) args.push("--resume", session);
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.effort) args.push("--effort", cfg.effort);
  if (bypass) args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits", "--allowedTools", "mcp__page-review__*", "Bash(page-review:*)");
  args.push(prompt);
  return { cmd: "claude", args };
}

function sessionFrom(kind, out) {
  if (kind === "claude") {
    try {
      const j = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1));
      return j.session_id || null;
    } catch {
      return out.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] || null;
    }
  }
  const m = out.match(/"thread_id"\s*:\s*"([^"]+)"/) || out.match(/"session_id"\s*:\s*"([^"]+)"/);
  return m?.[1] || null;
}

export function buildPrompt(site, thread, db, resumed) {
  const s = threadSummary(thread, db);
  const url = pageUrl(site, thread.page);
  const read = `Read the thread in full with the \`review_get\` tool if the page-review MCP tools are available, otherwise with \`page-review get ${thread.id}\`; reply with \`review_reply\` or \`page-review reply ${thread.id} "text"\`. Leave the thread open after replying, even when the work is complete. Only the user resolves threads; do not call review_set_status to resolve or use --resolve.`;
  if (resumed) {
    return (
      `New message in page-review comment thread ${thread.id} on ${url}. ${read} ` +
      `Read every message (the new one may change what was asked), do what it needs, reply in the thread, and leave it open for the user to review.`
    );
  }
  return [
    `Page-review comment thread ${thread.id} on ${url} is waiting for a reply.`,
    s.file ? `Page file: ${s.file}` : `The page is served by a dev server at ${site.target}.`,
    `Project: ${site.projectRoot || site.root} — you are running in it. It is the context for the page: read its CLAUDE.md or AGENTS.md if present, and search it when the comment needs something the page does not say.`,
    site.context ? `About this page (from whoever generated it): ${site.context}` : "",
    `Handle only this thread. ${read}`,
    `Read every message, not just the last. The anchor gives the quoted text (exact, with prefix/suffix), the nearest heading and a CSS path, or the element tag and snippet. Read the whole page source, not only that spot.`,
    `A question → answer it; change nothing unless the answer shows the page is wrong. A change → make it in the real source (never hand-edit a generated file: edit its generator and rebuild), at the quoted spot or wherever it belongs, and keep related parts consistent. Unclear → ask in the thread and leave it open.`,
    `Other runs may be editing the same files at the same time: make targeted edits and re-read a file before editing it.`,
    `Reply in the thread: what you changed and where, or the answer. Short; **bold**, \`code\` and links render. Leave it open for the user to review and resolve. The reply belongs in the thread, not only in your output.`,
  ]
    .filter(Boolean)
    .join("\n");
}
