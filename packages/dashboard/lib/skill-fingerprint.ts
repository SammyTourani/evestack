import { createHash } from "node:crypto";
import type { Skill } from "./skills";

export interface SkillFileFingerprint {
  path: string;
  hash: string;
  kind: string;
  bytes: number;
}
export interface SkillChanges {
  available: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

/** Older reviews have no per-file baseline; an absent baseline is not an empty skill. */
export function compareSkillFiles(
  current: SkillFileFingerprint[],
  previous: unknown,
): SkillChanges {
  const empty = { available: false, added: [], changed: [], removed: [] };
  if (
    !Array.isArray(previous) ||
    previous.length > 200 ||
    previous.some(
      (file) =>
        !file ||
        typeof file.path !== "string" ||
        file.path.length > 4096 ||
        typeof file.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.hash),
    )
  )
    return empty;
  if (new Set(previous.map((file) => file.path)).size !== previous.length)
    return empty;
  const before = new Map(previous.map((file) => [file.path, file.hash]));
  const after = new Map(current.map((file) => [file.path, file.hash]));
  return {
    available: true,
    added: current
      .filter((file) => !before.has(file.path))
      .map((file) => file.path),
    changed: current
      .filter(
        (file) => before.has(file.path) && before.get(file.path) !== file.hash,
      )
      .map((file) => file.path),
    removed: previous
      .filter((file) => !after.has(file.path))
      .map((file) => file.path)
      .sort(),
  };
}

/** Reviews bind to the text actually scanned and to its installed source, not just a reusable name. */
export function skillFingerprint(skill: Skill) {
  const files = [...skill.files].sort((a, b) => a.path.localeCompare(b.path));
  const reviewable =
    skill.kind !== "module" &&
    files.length > 0 &&
    skill.problems.length === 0 &&
    files.every(
      (file) => file.kind === "text" && typeof file.text === "string",
    );
  const source = createHash("sha256").update(skill.rootPath).digest("hex");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        kind: skill.kind,
        name: skill.name,
        files: files.map((file) => ({
          path: file.path,
          kind: file.kind,
          text: file.text ?? null,
          bytes: file.bytes,
          linkTarget: file.linkTarget ?? null,
        })),
      }),
    )
    .digest("hex");
  const manifest: SkillFileFingerprint[] = files.map((file) => ({
    path: file.path,
    kind: file.kind,
    bytes: file.bytes,
    hash: createHash("sha256")
      .update(
        JSON.stringify({
          kind: file.kind,
          text: file.text ?? null,
          bytes: file.bytes,
          linkTarget: file.linkTarget ?? null,
        }),
      )
      .digest("hex"),
  }));
  return { hash, source, reviewable, manifest };
}
