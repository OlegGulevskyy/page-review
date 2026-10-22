import test from "node:test";
import assert from "node:assert/strict";
import { command, runnerConfig } from "../src/runner.js";
import { updateRunnerSettings } from "../src/settings.js";

test("provider overrides never inherit another provider's model or effort", () => {
  const db = { config: { runner: { kind: "claude", model: "opus", effort: "max" } } };
  assert.equal(runnerConfig(db).model, "opus");
  assert.deepEqual([runnerConfig(db, { runner: "codex" }).model, runnerConfig(db, { runner: "codex" }).effort], [null, null]);
  const cfg = runnerConfig(db, { runnerSettings: { kind: "codex", model: "custom-model", effort: "high" } });
  assert.equal(cfg.model, "custom-model");
  assert.equal(cfg.effort, "high");
});

test("settings reject invalid types and provider-specific effort", () => {
  for (const patch of [{ model: {} }, { effort: true }, { kind: "bad" }, { kind: "claude", effort: "ultra" }, { kind: "none", model: "opus" }]) {
    assert.throws(() => updateRunnerSettings({}, patch));
  }
  const next = updateRunnerSettings({ kind: "claude", model: "opus", effort: "max" }, { kind: "codex" });
  assert.deepEqual(next, { kind: "codex", model: null, effort: null });
});

test("model and effort are passed on fresh and resumed runs for both CLIs", () => {
  for (const kind of ["claude", "codex"]) {
    for (const session of [null, "session-id"]) {
      const { args } = command({ kind, model: "custom-model", effort: "max" }, "prompt", session, "/tmp");
      assert.equal(args[args.indexOf(kind === "claude" ? "--model" : "-m") + 1], "custom-model");
      assert.ok(args.includes(kind === "claude" ? "--effort" : 'model_reasoning_effort="max"'));
      assert.equal(args.includes("session-id"), Boolean(session));
      assert.equal(args.at(-1), "prompt");
      // claude's --allowedTools is variadic and would swallow the prompt without `--`.
      if (kind === "claude") assert.equal(args.at(-2), "--");
    }
  }
});
