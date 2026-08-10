/**
 * The sandbox containers eve is running, read from the Docker daemon.
 *
 * This is the page a hosted dashboard structurally cannot ship. Vercel's Agent
 * Runs can tell you a tool call happened; it cannot tell you that the container
 * which ran it is still alive forty minutes later with the network open. That
 * is only knowable from the machine, which is the whole argument for
 * self-hosting, and until now nothing in evestack looked.
 *
 * ── MOUNTING THE DOCKER SOCKET IS A PRIVILEGE ESCALATION ─────────────────────
 *
 * Read that plainly: a process that can talk to `/var/run/docker.sock` can start
 * a container with the host filesystem bind-mounted and become root on the host.
 * There is no "read-only Docker socket" — the API has no such mode. So:
 *
 *   - The feature is OFF unless `EVESTACK_DOCKER_SOCKET` names a path. Absent is
 *     not an error; the page says the feature is off and how to turn it on.
 *   - This module issues GET requests only. There are no lifecycle verbs yet; when
 *     they land they get a SECOND flag and the approval audit, so "I can see the
 *     sandboxes" and "I can kill them" stay separate decisions. The reader for
 *     that flag was written here before the actions existed and has been
 *     removed — a env-var reader with no caller is a promise the code does not
 *     keep, and this file is not the place to keep one.
 *   - The compose file does not mount it. Someone has to choose this.
 *
 * ── The labels are eve's, not ours ───────────────────────────────────────────
 *
 * `eve.sandbox`, `eve.sandbox.role`, `eve.sandbox.tag.*` and `eve.sandbox.template-key`
 * are written by `eve/sandbox/docker` upstream. No code in this repo authors
 * them, which makes them a contract in exactly the same category as the
 * `$eve.*` run attributes: a rename upstream empties this page in silence
 * rather than failing. Contract 09 guards the backend interface shape and says
 * nothing about label names, so the names are asserted here instead — see
 * `SANDBOX_LABELS`.
 *
 * ── Docker is not the only backend ───────────────────────────────────────────
 *
 * `@evestack/sandbox-opensandbox` is published and duck-types eve's
 * `SandboxBackend`. On that install there are no containers at all and
 * everything here correctly returns empty — which the page must present as "a
 * different backend is in use", not as "no sandboxes are running". Those are
 * very different sentences to someone checking whether their agent is leaking
 * containers.
 *
 * ── This page costs ~2 seconds, on purpose ───────────────────────────────────
 *
 * Docker reports CPU as two cumulative counters, so a percentage only exists as
 * a delta between two samples, and `?stream=false` makes the daemon take both —
 * about two seconds of wall clock. Measured: 1.97s with two containers and
 * 2.11s with six, because every container is sampled in parallel, so the cost
 * is paid once for the whole fleet rather than per row.
 *
 * `one-shot=true` returns immediately and leaves `precpu_stats` empty, which
 * makes every CPU figure null. That is the wrong trade for this page: "which
 * sandbox is pinning a core" is one of the two questions it exists to answer,
 * and a page that loads instantly and cannot answer it is not faster, it is
 * emptier. Two seconds on a page someone opens deliberately is fine.
 *
 * ── The join to a session is soft ────────────────────────────────────────────
 *
 * `eve.sandbox.tag.sessionId` is a `wrun_...` id, but a container can outlive
 * the run row it names: eve keeps one container per session with no idle
 * timeout, and 8 of 48 distinct run ids observed in telemetry pointed at runs
 * that no longer existed. An orphan is not a bug in the reader, it is the most
 * interesting row on the page, so the join is a LEFT JOIN and "session is gone"
 * is a rendered state rather than a filtered-out one.
 */

import { request } from "node:http";

/** Labels eve writes. Reading a renamed one yields undefined, not an error. */
export const SANDBOX_LABELS = {
  marker: "eve.sandbox",
  role: "eve.sandbox.role",
  sessionId: "eve.sandbox.tag.sessionId",
  agent: "eve.sandbox.tag.agent",
  channel: "eve.sandbox.tag.channel",
  devRunId: "eve.sandbox.tag.devRunId",
  templateKey: "eve.sandbox.template-key",
} as const;

export interface SandboxStats {
  /** Fraction of one core, so 1.5 means one and a half cores. */
  readonly cpu: number | null;
  readonly memoryBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly networkRxBytes: number | null;
  readonly networkTxBytes: number | null;
  readonly pids: number | null;
}

export interface Sandbox {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** Docker's own words: running, exited, paused, dead. */
  readonly state: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly uptimeMs: number | null;
  /**
   * `none` is what eve sets for an isolated sandbox. Anything else means the
   * container can reach the network, which is the single most important fact
   * on this page and the reason it is not buried in a details panel.
   */
  readonly networkMode: string | null;
  readonly sessionId: string | null;
  readonly agent: string | null;
  readonly channel: string | null;
  readonly templateKey: string | null;
  readonly role: string | null;
  readonly stats: SandboxStats | null;
}

export type SandboxAvailability =
  | { readonly kind: "disabled" }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "ok"; readonly sandboxes: readonly Sandbox[] };

/** The socket path, or null when the operator has not opted in. */
function dockerSocket(): string | null {
  const raw = process.env.EVESTACK_DOCKER_SOCKET?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const TIMEOUT_MS = 3_000;

/**
 * One GET against the daemon.
 *
 * Written against `node:http` rather than pulling in dockerode, because the
 * whole surface used here is three endpoints and a dependency that speaks the
 * entire Docker API is a much larger thing to have mounted a root-equivalent
 * socket for.
 */
function get<T>(socketPath: string, path: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = request(
      { socketPath, path, method: "GET", timeout: TIMEOUT_MS, headers: { Host: "docker" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(new Error(`docker ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error(`docker returned non-JSON: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`docker did not answer in ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}

interface RawContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
  HostConfig?: { NetworkMode?: string };
}

interface RawInspect {
  State?: { StartedAt?: string };
  HostConfig?: { NetworkMode?: string };
}

interface RawStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  pids_stats?: { current?: number };
}

/**
 * CPU as a fraction of one core, from two cumulative counters.
 *
 * Docker reports totals since container start, so a percentage only exists as a
 * delta between two samples. `?stream=false` gives one sample plus the previous
 * one in `precpu_stats`, which is what makes a single request enough — but the
 * first sample after start has a zero `precpu` system value, and dividing by it
 * yields Infinity. That case returns null, because "we cannot know yet" is not
 * the same as "idle" and rendering 0% for a container that just booted is the
 * kind of quiet wrong this codebase keeps finding.
 */
export function cpuFraction(stats: RawStats): number | null {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const used = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const system = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  if (system <= 0 || used < 0) return null;
  const cores = cpu?.online_cpus ?? 1;
  return (used / system) * cores;
}

function toStats(raw: RawStats): SandboxStats {
  const net = Object.values(raw.networks ?? {});
  const sum = (pick: (n: { rx_bytes?: number; tx_bytes?: number }) => number | undefined) =>
    net.length === 0 ? null : net.reduce((total, n) => total + (pick(n) ?? 0), 0);
  return {
    cpu: cpuFraction(raw),
    memoryBytes: raw.memory_stats?.usage ?? null,
    memoryLimitBytes: raw.memory_stats?.limit ?? null,
    networkRxBytes: sum((n) => n.rx_bytes),
    networkTxBytes: sum((n) => n.tx_bytes),
    pids: raw.pids_stats?.current ?? null,
  };
}

/**
 * Every sandbox container on this machine, running or not.
 *
 * `all=1` on purpose: an exited sandbox is evidence, not noise. A container that
 * died holding a session is exactly what someone debugging a wedged session is
 * looking for, and hiding it would make the page agree with `docker ps` rather
 * than with the question being asked.
 */
export async function listSandboxes(): Promise<SandboxAvailability> {
  const socketPath = dockerSocket();
  if (socketPath === null) return { kind: "disabled" };

  const filters = encodeURIComponent(JSON.stringify({ label: [SANDBOX_LABELS.marker] }));
  let raw: RawContainer[];
  try {
    raw = await get<RawContainer[]>(socketPath, `/containers/json?all=1&filters=${filters}`);
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }

  const now = Date.now();
  const sandboxes = await Promise.all(
    raw.map(async (c): Promise<Sandbox> => {
      const labels = c.Labels ?? {};
      const running = (c.State ?? "").toLowerCase() === "running";

      // Inspect and stats are per container and independent; a failure in
      // either degrades that field rather than the row. A container that exits
      // between the list and the inspect is normal, not an error.
      const [inspect, stats] = await Promise.all([
        get<RawInspect>(socketPath, `/containers/${c.Id}/json`).catch(() => null),
        running
          ? get<RawStats>(socketPath, `/containers/${c.Id}/stats?stream=false&one-shot=false`).catch(
              () => null,
            )
          : Promise.resolve(null),
      ]);

      const startedAt = inspect?.State?.StartedAt ?? null;
      const startedMs = startedAt === null ? NaN : Date.parse(startedAt);
      return {
        id: c.Id,
        name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        image: c.Image ?? "",
        state: c.State ?? "unknown",
        status: c.Status ?? "",
        startedAt,
        // Docker reports a zero time for a container that has never started.
        uptimeMs: Number.isFinite(startedMs) && startedMs > 0 && running ? now - startedMs : null,
        networkMode: inspect?.HostConfig?.NetworkMode ?? c.HostConfig?.NetworkMode ?? null,
        sessionId: labels[SANDBOX_LABELS.sessionId] ?? null,
        agent: labels[SANDBOX_LABELS.agent] ?? null,
        channel: labels[SANDBOX_LABELS.channel] ?? null,
        templateKey: labels[SANDBOX_LABELS.templateKey] ?? null,
        role: labels[SANDBOX_LABELS.role] ?? null,
        stats: stats === null ? null : toStats(stats),
      };
    }),
  );

  // Running first, then longest-lived: the orphan that has been up for hours is
  // the row worth seeing, and sorting by name would bury it.
  sandboxes.sort((a, b) => {
    const ar = a.state === "running" ? 0 : 1;
    const br = b.state === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.uptimeMs ?? 0) - (a.uptimeMs ?? 0);
  });

  return { kind: "ok", sandboxes };
}

/** How long a sandbox may live before the page calls it out. */
export const ORPHAN_AFTER_MS = 60 * 60 * 1000;

export interface SandboxConcern {
  readonly kind: "networked" | "orphaned" | "session-gone" | "unreadable";
  readonly sandbox: Sandbox;
}

/**
 * The three things worth interrupting someone about, and the fourth that says
 * one of the three could not be decided.
 *
 * Pure and exported so the rules are testable without a daemon — they are the
 * whole editorial content of the page, and a rule that only exists inside JSX
 * cannot be checked.
 *
 * ── WHY `unreadable` IS A CONCERN AND NOT A SILENCE ──────────────────────────
 *
 * Both of the first two tests are guarded with `!== null`, and both of those
 * nulls mean "Docker did not tell us", not "the answer is fine". `networkMode`
 * falls back through `inspect?.HostConfig` — and that inspect is a
 * `.catch(() => null)` on a 3-second timeout — to the list's own copy, and then
 * to null; `uptimeMs` comes only from the inspect. So a container the daemon is
 * too slow or too broken to describe was skipped by BOTH tests and then counted
 * in "All N running sandboxes are network-isolated" (lib/alerts.ts) and in
 * "Nothing needs attention." (app/sandboxes/page.tsx).
 *
 * That is the shape this repo has now fixed four times: the check that could
 * not run produced the reassuring answer. `sandbox_networked` is a PAGE
 * severity alert about code reaching the internet from inside a sandbox, so it
 * is the worst place in the product to guess in the flattering direction.
 *
 * `state` gets the same treatment. `listSandboxes` writes `c.State ?? "unknown"`,
 * and the loop below returns early for anything that is not exactly `running` —
 * so a container with no reported state was silently exempt from all three
 * checks rather than being reported as unexamined.
 */
export function concerns(
  sandboxes: readonly Sandbox[],
  knownSessionIds: ReadonlySet<string>,
  now = Date.now(),
): SandboxConcern[] {
  void now;
  const out: SandboxConcern[] = [];
  for (const sandbox of sandboxes) {
    if (sandbox.state !== "running") {
      // Not `continue` unconditionally: a container whose state Docker never
      // reported is not a stopped container, and treating it as one exempts it
      // from every test below without saying so.
      if (sandbox.state === "unknown" || sandbox.state === "") {
        out.push({ kind: "unreadable", sandbox });
      }
      continue;
    }
    // eve sets `none` for an isolated sandbox. Anything else can reach out —
    // and null is not "anything else", it is "we could not read it".
    if (sandbox.networkMode === null || sandbox.uptimeMs === null) {
      out.push({ kind: "unreadable", sandbox });
    }
    if (sandbox.networkMode !== null && sandbox.networkMode !== "none") {
      out.push({ kind: "networked", sandbox });
    }
    if (sandbox.uptimeMs !== null && sandbox.uptimeMs > ORPHAN_AFTER_MS) {
      out.push({ kind: "orphaned", sandbox });
    }
    // A live container whose session is not in the database. eve keeps one
    // container per session with no idle timeout, so this is how they pile up.
    if (sandbox.sessionId !== null && !knownSessionIds.has(sandbox.sessionId)) {
      out.push({ kind: "session-gone", sandbox });
    }
  }
  return out;
}
