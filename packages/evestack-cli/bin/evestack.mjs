#!/usr/bin/env node
import { main } from "../src/cli.mjs";

// Set the code rather than calling process.exit, so a piped stdout is not
// truncated mid-write — `evestack doctor --sql | psql` loses its last lines if
// the process is torn down before the pipe drains.
process.exitCode = await main(process.argv.slice(2));
