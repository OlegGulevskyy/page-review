import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import spawn from "cross-spawn";
import { parse } from "smol-toml";
import { DATA_DIR } from "./store.js";
import { MCP_PATH, PACKAGE_ROOT, VERSION } from "./package.js";

export const CLIENTS = { claude: "Claude Code", codex: "Codex" };
export const SKILL_SOURCE = path.join(PACKAGE_ROOT, "skills/page-review/SKILL.md");
export const providerPath = () => [process.env.PATH, path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(path.delimiter);

export function findExecutable(name) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of providerPath().split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const file = path.resolve(dir, name + ext);
      try {
        fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

export function clientPaths(kind) {
  const home = os.homedir();
  if (kind === "claude") return {
    skill: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "skills/page-review/SKILL.md"),
    config: process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json"),
  };
  if (kind === "codex") return {
    skill: path.join(home, ".agents/skills/page-review/SKILL.md"),
    config: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
  };
  throw new Error(`Unknown agent: ${kind}`);
}

export function readRegistration(kind) {
  const file = clientPaths(kind).config;
  if (!fs.existsSync(file)) return null;
  const data = fs.readFileSync(file, "utf8");
  return kind === "claude" ? JSON.parse(data).mcpServers?.["page-review"] || null : parse(data).mcp_servers?.["page-review"] || null;
}

function backup(file, label) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${label}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  fs.writeFileSync(dest, fs.readFileSync(file), { mode: 0o600 });
  return dest;
}

export function installSkill(kind) {
  const file = clientPaths(kind).skill;
  const content = fs.readFileSync(SKILL_SOURCE, "utf8");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return { file, changed: false };
  const previous = backup(file, `${kind}-skill`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // Replace a symlink itself, never overwrite its target.
  return { file, changed: true, backup: previous };
}

export function mcpSpec(kind) {
  return { command: process.execPath, args: [MCP_PATH], env: {
    PAGE_REVIEW_HOME: path.resolve(DATA_DIR), PAGE_REVIEW_PORT: String(process.env.PAGE_REVIEW_PORT || 4848),
    ...(CLIENTS[kind] ? { PAGE_REVIEW_AGENT_NAME: kind === "claude" ? "Claude" : "Codex" } : {}),
  } };
}

function runClient(kind, args) {
  const result = spawn.sync(kind, args, { encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: providerPath() } });
  if (result.error || result.status !== 0) throw new Error(`${CLIENTS[kind]} could not update its agent connection. Check '${kind} mcp --help' and rerun 'page-review setup'.`);
}

export function registerMcp(kind) {
  if (!findExecutable(kind)) return { connected: false, reason: `${CLIENTS[kind]} is not installed. Install it, sign in, then rerun page-review setup.` };
  const current = readRegistration(kind);
  const spec = mcpSpec(kind);
  if (current?.command === spec.command && JSON.stringify(current.args) === JSON.stringify(spec.args) &&
      Object.entries(spec.env).every(([key, value]) => current.env?.[key] === value)) return { connected: true, changed: false };
  // Do not replace an unrelated integration that happens to use the same name.
  if (current && ![current.command, ...(current.args || [])].some((s) => /page-review/.test(s))) {
    return { connected: false, reason: `An existing connection named page-review belongs to another command. Rename that connection with ${kind} mcp, then rerun setup.` };
  }
  const saved = backup(clientPaths(kind).config, `${kind}-config`);
  if (kind === "claude") {
    if (current) runClient(kind, ["mcp", "remove", "--scope", "user", "page-review"]);
    try { runClient(kind, ["mcp", "add-json", "--scope", "user", "page-review", JSON.stringify({ type: "stdio", ...spec })]); }
    catch (e) {
      if (current) {
        try { runClient(kind, ["mcp", "add-json", "--scope", "user", "page-review", JSON.stringify(current)]); }
        catch { e.message += ` Previous configuration backup: ${saved}`; }
      }
      throw e;
    }
  } else {
    runClient(kind, ["mcp", "add", "page-review", ...Object.entries(spec.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), "--", spec.command, ...spec.args]);
  }
  const verified = readRegistration(kind);
  if (verified?.command !== spec.command || JSON.stringify(verified.args) !== JSON.stringify(spec.args) ||
      !Object.entries(spec.env).every(([k, v]) => verified.env?.[k] === v)) throw new Error(`${CLIENTS[kind]} did not save the expected connection. Rerun page-review setup after checking its configuration.`);
  return { connected: true, changed: true, backup: saved };
}

export function integrationStatus() {
  const expected = fs.readFileSync(SKILL_SOURCE, "utf8");
  return Object.entries(CLIENTS).map(([kind, name]) => {
    const paths = clientPaths(kind);
    let skill = "Not installed", connection = "Not configured";
    try { if (fs.existsSync(paths.skill)) skill = fs.readFileSync(paths.skill, "utf8") === expected ? "Installed" : "Update available"; } catch { skill = "Cannot read skill"; }
    try {
      const registration = readRegistration(kind);
      if (registration) {
        const spec = mcpSpec(kind);
        connection = registration.command === spec.command && JSON.stringify(registration.args) === JSON.stringify(spec.args) &&
          Object.entries(spec.env).every(([k, v]) => registration.env?.[k] === v) ? "Connected" : "Run setup to update";
      }
    } catch { connection = "Cannot read configuration"; }
    return { kind, name, cli: Boolean(findExecutable(kind)), skill, connection, skillPath: paths.skill, version: VERSION };
  });
}
