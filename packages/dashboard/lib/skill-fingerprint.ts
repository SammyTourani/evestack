import { createHash } from "node:crypto";
import type { Skill } from "./skills";

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
  return { hash, source, reviewable };
}
