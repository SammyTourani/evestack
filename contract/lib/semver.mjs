/**
 * Just enough semver to answer "does the installed eve satisfy the ranges this
 * repo declares".
 *
 * A dependency would be the obvious answer, but the contract suite's whole
 * value proposition is that it runs on a bare checkout with nothing installed
 * but eve itself — so it stays dependency-free. The tradeoff is deliberate:
 * `satisfies` throws on any range shape it does not fully understand rather
 * than guessing, so an exotic range surfaces as a loud failure instead of a
 * silent pass.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

export class UnsupportedRangeError extends Error {}

export function parse(version) {
  const match = VERSION_RE.exec(String(version).trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** Returns <0, 0 or >0. Any prerelease sorts below the same release version. */
export function compare(a, b) {
  const left = typeof a === "string" ? parse(a) : a;
  const right = typeof b === "string" ? parse(b) : b;
  if (left === null || right === null) throw new UnsupportedRangeError(`Cannot compare ${a} with ${b}`);

  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] - right[part];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Expands `^x.y.z` / `~x.y.z` into the equivalent pair of comparators. */
function expandCaretOrTilde(operator, version) {
  const v = parse(version);
  if (v === null) throw new UnsupportedRangeError(`${operator}${version} is not a version this checker understands`);

  const lower = { op: ">=", version: v };
  if (operator === "~") {
    return [lower, { op: "<", version: { major: v.major, minor: v.minor + 1, patch: 0, prerelease: null } }];
  }
  // npm's caret on 0.x pins the minor, because 0.x minors are breaking.
  const upper =
    v.major > 0
      ? { major: v.major + 1, minor: 0, patch: 0, prerelease: null }
      : { major: 0, minor: v.minor + 1, patch: 0, prerelease: null };
  return [lower, { op: "<", version: upper }];
}

function parseComparator(token) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (match === null) throw new UnsupportedRangeError(`Cannot parse comparator "${token}"`);
  const [, operator = "=", raw] = match;

  if (operator === "^" || operator === "~") return expandCaretOrTilde(operator, raw);

  const version = parse(raw);
  if (version === null) throw new UnsupportedRangeError(`"${token}" is not a plain version comparator`);
  return [{ op: operator, version }];
}

function satisfiesAll(version, comparators) {
  return comparators.every(({ op, version: bound }) => {
    const result = compare(version, bound);
    switch (op) {
      case ">=":
        return result >= 0;
      case ">":
        return result > 0;
      case "<=":
        return result <= 0;
      case "<":
        return result < 0;
      case "=":
        return result === 0;
      default:
        throw new UnsupportedRangeError(`Unknown operator "${op}"`);
    }
  });
}

/**
 * Supports `*`, exact versions, `^`, `~`, plain comparators, space-joined AND,
 * and `||`-joined OR. Anything else — a dist-tag like `beta`, a URL, a
 * `workspace:` protocol — throws, so the caller decides whether to skip it or
 * report it.
 */
export function satisfies(version, range) {
  const parsed = parse(version);
  if (parsed === null) throw new UnsupportedRangeError(`"${version}" is not a semver version`);

  const trimmed = String(range).trim();
  if (trimmed === "" || trimmed === "*" || trimmed === "x") return true;

  return trimmed.split("||").some((clause) => {
    const comparators = clause
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "")
      .flatMap(parseComparator);
    return satisfiesAll(parsed, comparators);
  });
}
