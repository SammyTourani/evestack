/**
 * Loading the contracts, in one place, because two things need the list.
 *
 * run.mjs runs them. `docs/every-documented-path-exists` reads the same list to
 * check that docs/upgrading.mdx's "What is currently pinned" table names every
 * one of them — that table published nine rows for a seventeen-contract suite,
 * for months, because nothing derived it from anything and nobody counted.
 *
 * Keeping the loader here rather than in run.mjs means the two callers cannot
 * disagree about what a contract is or where they live. A file exporting an array
 * contributes several; the runner and the docs check see the same several.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");

/** Every contract in contract/contracts/, in filename order, tagged with its file. */
export async function loadContracts() {
  const files = readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith(".contract.mjs"))
    .sort();

  const contracts = [];
  for (const file of files) {
    const module = await import(pathToFileURL(join(CONTRACTS_DIR, file)).href);
    const exported = module.default;
    for (const contract of Array.isArray(exported) ? exported : [exported]) {
      contracts.push({ ...contract, file: `contract/contracts/${file}` });
    }
  }
  return contracts;
}
