import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Exercise the scaffold's real install flow without network access or services.
// Windows discovers .cmd launchers; POSIX executes the scripts' shebangs.
export function shimPath() {
  const bin = mkdtempSync(join(tmpdir(), "evestack-test-shims-"));
  const windows = process.platform === "win32";
  const write = (name, body) => {
    const file = join(bin, name + (windows ? ".cmd" : ""));
    writeFileSync(file, body);
    if (!windows) chmodSync(file, 0o755);
  };
  const install = windows
    ? '@echo off\r\nif "%~1"=="install" mkdir node_modules\\eve 2>nul\r\nexit /b 0\r\n'
    : '#!/bin/sh\nif [ "$1" = "install" ]; then mkdir -p node_modules/eve; fi\nexit 0\n';
  for (const name of ["npm", "pnpm", "yarn", "bun"]) write(name, install);
  for (const name of ["docker", "ollama"]) {
    write(name, windows ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  }
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}
