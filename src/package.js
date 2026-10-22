import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MCP_PATH = fileURLToPath(new URL("./mcp.js", import.meta.url));
export const PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const VERSION = PACKAGE.version;
