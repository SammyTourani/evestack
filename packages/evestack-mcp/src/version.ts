import { createRequire } from "node:module";

/**
 * The package's own version, read from package.json rather than typed twice.
 *
 * It was typed twice — `SERVER_INFO.version` in server.ts and the `user-agent`
 * in dashboard.ts — and both said "0.1.0" as string literals. That is not
 * cosmetic drift: the dashboard records the user-agent into
 * `evestack.approvals.user_agent`, so the moment this package is published at
 * 0.2.0 the audit log starts permanently recording a version that was never
 * released, against approvals of real tool calls. An audit row that names the
 * wrong client is worse than one that names none.
 *
 * `createRequire` rather than a JSON import: `with { type: "json" }` is still
 * gated behind flags on some Node versions this package supports, and a build
 * that resolves differently between `tsc` and Node is exactly the class of
 * problem this file exists to remove. From `dist/version.js`, `../package.json`
 * is the package root.
 */
const require = createRequire(import.meta.url);

const manifest = require("../package.json") as { version?: unknown };

export const VERSION: string =
  typeof manifest.version === "string" && manifest.version.length > 0
    ? manifest.version
    : "0.0.0-unknown";
