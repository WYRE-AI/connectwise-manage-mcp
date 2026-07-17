import { defineConfig } from "vitest/config";

// Without this file vitest falls back to vite.config.ts, whose `root: "ui"`
// exists only to build the MCP Apps card bundle — tests live at the repo
// root, so pin vitest to the defaults here.
export default defineConfig({});
