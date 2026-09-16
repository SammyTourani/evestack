#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function releaseManifest(root = ROOT) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const json = (path) => JSON.parse(read(path));
  const packages = {};
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    let pkg;
    try {
      pkg = json(`packages/${dir}/package.json`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!pkg.private || pkg.name === "@evestack/dashboard")
      packages[pkg.name] = pkg.version;
  }
  const template = json("templates/default/package.json");
  const dependencies = Object.fromEntries(
    Object.entries(template.dependencies).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? `^${packages[name]}` : range,
    ]),
  );
  if (Object.values(dependencies).some((value) => value.includes("undefined")))
    throw new Error("A template workspace dependency has no release version.");
  const imageTag = /export const DASHBOARD_IMAGE_TAG = "([^"]+)"/.exec(
    read("packages/create-evestack/shared.mjs"),
  )?.[1];
  if (imageTag !== packages["@evestack/dashboard"])
    throw new Error("Dashboard image and package versions disagree.");
  const postgresVersions = [
    "docker-compose.yml",
    "packages/create-evestack/create.mjs",
    "packages/create-evestack/attach.mjs",
  ].map((path) => {
    const versions = [...read(path).matchAll(/image:\s*pgvector\/pgvector:pg(\d+)\b/g)]
      .map((match) => Number(match[1]));
    if (!versions.length || versions.some((version) => version !== versions[0]))
      throw new Error(`Missing or inconsistent Postgres image in ${path}.`);
    return versions[0];
  });
  if (postgresVersions.some((version) => version !== postgresVersions[0]))
    throw new Error("Root, generated and attached Postgres versions disagree.");
  const sqlVersion = (name) => {
    const values = [
      ...read(`packages/dashboard/sql/${name}.sql`).matchAll(
        /target\s+constant integer\s*:=\s*(\d+)/g,
      ),
    ].map((match) => Number(match[1]));
    if (!values.length || values.some((value) => value !== values[0]))
      throw new Error(`Inconsistent ${name} schema guard.`);
    return values[0];
  };
  const runtimeVersion = (path, table) => {
    const text = read(path);
    const value = new RegExp(
      `INSERT INTO evestack\\.${table}\\(singleton,version\\) VALUES\\(true,(\\d+)\\)`,
    ).exec(text)?.[1];
    if (!value) throw new Error(`Missing ${table} schema marker.`);
    return Number(value);
  };
  return {
    formatVersion: 1,
    packages,
    runtime: {
      node: template.engines.node,
      eve: dependencies.eve,
      workflowPostgres: dependencies["@workflow/world-postgres"],
      postgresMajor: postgresVersions[0],
      dashboardImage: `ghcr.io/sammytourani/evestack-dashboard:${imageTag}`,
    },
    templateDependencies: dependencies,
    storageVersions: {
      traces: sqlVersion("traces"),
      facts: sqlVersion("facts"),
      regressions: sqlVersion("regressions"),
      routines: runtimeVersion(
        "packages/dashboard/lib/routines.ts",
        "routine_schema",
      ),
      budgetSettings: runtimeVersion(
        "packages/evestack-budget/src/runtime-settings.ts",
        "budget_settings_schema",
      ),
    },
    note: "Selected versions for this source checkout, not proof of publication or deployment. Upgrade the dashboard and opted-in budget agents together. Preserve durable Postgres data and verify a backup before migrations; never drop the evestack schema as a repair step.",
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error(
      "Use --check, or no arguments to write release-manifest.json.",
    );
  const path = join(ROOT, "release-manifest.json");
  const content = JSON.stringify(releaseManifest(), null, 2) + "\n";
  if (args.includes("--check")) {
    if (readFileSync(path, "utf8") !== content)
      throw new Error(
        "Release manifest is stale. Run node scripts/release-manifest.mjs.",
      );
    console.log(
      "Release manifest matches component versions, template dependencies and schema guards.",
    );
  } else {
    writeFileSync(path, content);
    console.log("Wrote release-manifest.json.");
  }
}
