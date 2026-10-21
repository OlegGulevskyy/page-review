import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// CLI aliases for Claude; Codex's installed catalog includes custom/account-specific models.
export function runnerChoices() {
  let models = [];
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
    const cache = JSON.parse(fs.readFileSync(file, "utf8"));
    models = (cache.models || []).filter((m) => typeof m.slug === "string" && m.visibility !== "hide")
      .map((m) => ({ id: m.slug, efforts: m.supported_reasoning_levels?.map((e) => e.effort).filter((e) => typeof e === "string") }));
  } catch { /* A custom model can still be entered when no catalog is cached. */ }
  return [
    { id: "claude", name: "Claude Code", models: ["sonnet", "opus", "haiku"].map((id) => ({ id })), efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "codex", name: "Codex", models, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "webhook", name: "Webhook", models: [], efforts: [] },
    { id: "none", name: "Off", models: [], efforts: [] },
  ];
}

// Validate before mutating saved config. Switching provider must not carry an incompatible model.
export function updateRunnerSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("runner settings must be an object");
  const next = { kind: "claude", model: null, effort: null, ...current };
  if ("kind" in patch && patch.kind !== next.kind) Object.assign(next, { model: null, effort: null });
  if ("kind" in patch) next.kind = patch.kind;
  const choice = runnerChoices().find((p) => p.id === next.kind);
  if (!choice) throw new Error("runner.kind must be claude, codex, webhook, or none");
  for (const key of ["model", "effort"]) {
    if (!(key in patch)) continue;
    if (patch[key] !== null && typeof patch[key] !== "string") throw new Error(`runner.${key} must be a string or null`);
    next[key] = patch[key]?.trim() || null;
  }
  if (!choice.efforts.length) {
    if (next.model || next.effort) throw new Error("Model and effort apply only to Claude Code and Codex");
  } else {
    const efforts = choice.models.find((m) => m.id === next.model)?.efforts || choice.efforts;
    if (next.effort && !efforts.includes(next.effort)) throw new Error(`Unsupported effort for ${next.model || choice.name}: ${next.effort}`);
  }
  return next;
}
