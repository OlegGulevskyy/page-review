import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function t3TaskRoot(id) {
    // T3 Code stores a "worktree" workspace strategy on scheduled tasks that launch a fresh thread
    // per run, and its tools cannot change it. Page-review runs must work in the project checkout
    // itself (the generated page may be uncommitted, and the project may not be a git repo), so
    // set that one column to "root". Backs the database up first; touches nothing else.

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
}
