import {
  SCANNER_LIMITS,
  scanSkill,
  verdictSummary,
  type Finding,
  type ScanResult,
  type Severity,
} from "@/lib/skill-scan";
import { listSkills, readFixtureSkill, SKILLS_DIR_ENV, type Skill } from "@/lib/skills";
import styles from "./skills.module.css";

export const dynamic = "force-dynamic";

const CANARY_SKILL = "malicious-fixture";

function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: styles.sevCritical ?? "",
  high: styles.sevHigh ?? "",
  medium: styles.sevMedium ?? "",
  low: styles.sevLow ?? "",
};

/** Where the description the model routes on came from, in the reader's terms. */
function describeSource(skill: Skill): string | null {
  switch (skill.descriptionSource) {
    case "frontmatter":
      return null;
    case "derived":
      return "derived by eve from the first line — no description in frontmatter";
    case "fallback":
      return "placeholder — eve had nothing to derive a description from";
    default:
      return "unknown to this page";
  }
}

function VerdictPill({ scan }: { scan: ScanResult }) {
  if (scan.verdict === "critical") {
    return <span className="status status-failed">critical</span>;
  }
  if (scan.verdict === "warning") {
    return <span className={`status ${styles.verdictWarn}`}>review</span>;
  }
  return <span className="status status-completed">no matches</span>;
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className={styles.finding}>
      <div className={styles.findingHead}>
        <span className={`${styles.sev} ${SEVERITY_CLASS[finding.severity]}`}>{finding.severity}</span>
        <span className={styles.findingTitle}>{finding.title}</span>
        <span className={styles.where}>
          {finding.file}
          {finding.line > 0 ? `:${finding.line}` : ""}
        </span>
      </div>
      <code className={styles.excerpt}>{finding.excerpt}</code>
      <p className={styles.why}>
        {finding.explanation} <span className={styles.rule}>[{finding.ruleId}]</span>
      </p>
    </div>
  );
}

function SkillCard({ skill, scan }: { skill: Skill; scan: ScanResult }) {
  const note = describeSource(skill);
  return (
    <li className={`${styles.skill} ${scan.verdict === "critical" ? styles.skillCritical : ""}`}>
      <div className={styles.head}>
        <span className={styles.name}>{skill.name}</span>
        <span className={styles.kind}>{skill.kind}</span>
        <VerdictPill scan={scan} />
        <span className={styles.headMeta}>
          {skill.files.length} file{skill.files.length === 1 ? "" : "s"} · {bytes(skill.totalBytes)} ·{" "}
          {stamp(skill.modifiedAt)}
        </span>
      </div>

      <p className={styles.desc}>
        {skill.description || <span className="faint">No description — the model has nothing to route on.</span>}
        {note && <span className={styles.descNote}>({note})</span>}
      </p>

      {skill.problems.length > 0 && (
        <div className={styles.problems}>
          <ul>
            {skill.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <details className={styles.findings}>
        <summary>
          {verdictSummary(scan)}
          {scan.findings.length > 0 &&
            ` — ${scan.counts.critical} critical, ${scan.counts.high} high, ${scan.counts.medium} medium, ${scan.counts.low} low`}
        </summary>
        {scan.findings.length === 0 ? (
          <p className={styles.why}>
            Nothing matched. That is the absence of known-bad patterns, not evidence this skill is
            safe — read {skill.kind === "package" ? "SKILL.md" : "the file"} before you trust it.
          </p>
        ) : (
          scan.findings.map((finding) => (
            <FindingRow key={`${finding.ruleId}:${finding.file}:${finding.line}`} finding={finding} />
          ))
        )}
        {scan.truncated && (
          <p className={styles.why}>
            Showing {scan.findings.length} of{" "}
            {scan.counts.critical + scan.counts.high + scan.counts.medium + scan.counts.low}{" "}
            findings, most severe first. The counts above are the whole scan; this list is capped so
            the page stays responsive. Without this line a capped list reads as a complete one, which
            is the mistake the verdict itself used to make.
          </p>
        )}
        {scan.unscanned.length > 0 && (
          <p className={styles.why}>
            Not scanned:{" "}
            {scan.unscanned.map((entry) => `${entry.file} (${entry.reason})`).join(", ")}. The verdict
            above covers less than it looks like it does.
          </p>
        )}
      </details>

      <div className={styles.foot}>
        <span className={styles.path}>{skill.entryPath}</span>
        {skill.license && (
          <>
            <span className={styles.dot}>·</span>
            <span>{skill.license}</span>
          </>
        )}
        <span className={styles.dot}>·</span>
        <a href={`/api/skills/${encodeURIComponent(skill.name)}`}>JSON</a>
      </div>
    </li>
  );
}

/**
 * The skills the agent can pull into a turn, and what a static scan makes of
 * them.
 *
 * There is no install button, and that is the design rather than a gap. Two
 * reasons, both empirical. skills.sh — the largest registry, and the one
 * vercel-labs/skills#426 asks for a browse API over — does publish
 * `/api/v1/skills*`, but every catalog endpoint answers `401
 * authentication_required` without a Vercel OIDC token, which is the one thing
 * an evestack user is guaranteed not to have. And a dashboard button that
 * writes new instruction files into the agent's skills directory turns this
 * page into a remote write surface for exactly the payload it exists to catch.
 * Skills arrive through git, where a human reviews a diff; this page is what
 * tells you what to look for in it.
 */
export default async function SkillsPage() {
  const { directory, skills } = await listSkills();
  const scanned = skills.map((skill) => ({ skill, scan: scanSkill(skill) }));
  const critical = scanned.filter((entry) => entry.scan.verdict === "critical").length;

  const fixture = await readFixtureSkill(CANARY_SKILL);
  const canary = fixture ? scanSkill(fixture) : null;

  return (
    <>
      <h1>Skills</h1>
      <p className={styles.sub}>
        eve advertises every skill in this directory to the model and hands it a <code>load_skill</code>{" "}
        tool. Anything here can put instructions into a live turn without a human seeing them first,
        which is why each one is scanned before it is listed.
      </p>

      <div className={styles.source}>
        <span>Reading</span>
        <span className={styles.sourcePath}>{directory.path}</span>
        <span className={styles.sourceTag}>
          {directory.resolvedBy === "env"
            ? SKILLS_DIR_ENV
            : directory.resolvedBy === "project"
              ? "agent/skills"
              : directory.resolvedBy === "bundled-template"
                ? "bundled template"
                : "not found"}
        </span>
        {directory.exists && (
          <span className={styles.sourceCount}>
            {skills.length} skill{skills.length === 1 ? "" : "s"}
            {critical > 0 ? ` · ${critical} critical` : ""}
          </span>
        )}
      </div>

      <details className={styles.limits}>
        <summary>A clean verdict is not proof of safety. What this scanner cannot do</summary>
        <ul>
          {SCANNER_LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>

      {canary && (
        <p className={`${styles.canary} ${canary.verdict === "critical" ? "" : styles.canaryBad}`}>
          <span>Firewall self-test:</span>
          {canary.verdict === "critical" ? (
            <>
              <span className="status status-completed">armed</span>
              <span>
                {canary.counts.critical} critical findings on the bundled malicious fixture, from{" "}
                {new Set(canary.findings.map((finding) => finding.ruleId)).size} distinct rules.
              </span>
            </>
          ) : (
            <>
              <span className="status status-failed">broken</span>
              <span>
                The bundled malicious fixture scanned <strong>{canary.verdict}</strong>. The scanner has
                stopped detecting things it used to — treat every clean verdict on this page as
                meaningless until that is fixed.
              </span>
            </>
          )}
          <a className={styles.rule} href="/api/skills?selftest=1">
            JSON
          </a>
        </p>
      )}

      {!directory.exists ? (
        <div className="empty">
          <h2>No skills directory</h2>
          <p>
            {directory.problem ?? "Nothing to read."}
            <br />
            eve scans <code>agent/skills/</code> for packaged skills (a directory with a{" "}
            <code>SKILL.md</code>) and flat <code>.md</code> or <code>.ts</code> skill files. If the
            agent has some and this page does not see them, the dashboard is running somewhere that
            cannot reach the agent&apos;s source tree — set <code>{SKILLS_DIR_ENV}</code>, or mount
            the directory into the container.
          </p>
          <p className="faint">Looked in: {directory.searched.join(", ")}</p>
        </div>
      ) : skills.length === 0 ? (
        <div className="empty">
          <h2>No skills installed</h2>
          <p>
            The directory exists and is empty. Add <code>agent/skills/&lt;name&gt;/SKILL.md</code> with
            a <code>description</code> in its frontmatter — that description is the only thing the
            model routes on, so write it as the task that should trigger the skill.
          </p>
        </div>
      ) : (
        <ul className={styles.list}>
          {scanned.map(({ skill, scan }) => (
            <SkillCard key={skill.name} skill={skill} scan={scan} />
          ))}
        </ul>
      )}
    </>
  );
}
