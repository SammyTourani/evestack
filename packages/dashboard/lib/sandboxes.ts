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
 * ── Sampling is bounded ────────────────────────────────────────────────────
 *
 * Docker reports CPU as two cumulative counters, so a percentage only exists as
 * a delta between two samples, and `?stream=false` makes the daemon take both —
 * about two seconds per batch. Six workers inspect at most 24 containers;
 * larger inventories have explicit omitted coverage. Each response has an
 * absolute three-second deadline and a 2 MiB cap. A slow daemon cannot turn
 * one page render into an unbounded fan-out or an indefinitely growing body.
 *
 * `one-shot=true` returns immediately and leaves `precpu_stats` empty, which
 * makes every CPU figure null. That is the wrong trade for this page: "which
 * sandbox is pinning a core" is one of the two questions it exists to answer,
 * and missing counters or core counts remain unknown rather than assuming zero
 * activity or a one-core machine.
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
  | {
      readonly kind: "ok";
      readonly sandboxes: readonly Sandbox[];
      readonly coverage: {
        listed: number;
        inspected: number;
        omitted: number;
        limit: number;
      };
    };

/** The socket path, or null when the operator has not opted in. */
function dockerSocket(): string | null {
  const raw = process.env.EVESTACK_DOCKER_SOCKET?.trim();
  return raw && raw.length > 0 ? raw : null;
}

const TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SANDBOX_INSPECTION_LIMIT = 24;
const INSPECTION_WORKERS = 6;

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
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const req = request(
      {
        socketPath,
        path,
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { Host: "docker" },
      },
      (res) => {
        res.on("error", fail);
        res.on("aborted", () =>
          fail(new Error("Docker ended its response before completion.")),
        );
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          req.destroy(
            new Error(`Docker returned HTTP ${res.statusCode ?? "unknown"}.`),
          );
          return;
        }
        if (Number(res.headers["content-length"]) > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("Docker response exceeds the 2 MiB limit."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > MAX_RESPONSE_BYTES)
            req.destroy(new Error("Docker response exceeds the 2 MiB limit."));
          else chunks.push(c);
        });
        res.on("end", () => {
          clearTimeout(timer);
          if (bytes > MAX_RESPONSE_BYTES) return;
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            fail(
              new Error(
                "Docker returned invalid JSON; response contents were not displayed.",
              ),
            );
          }
        });
      },
    );
    // Absolute deadline, including a daemon that keeps trickling body bytes.
    timer = setTimeout(
      () => req.destroy(new Error(`Docker response exceeded ${TIMEOUT_MS}ms.`)),
      TIMEOUT_MS,
    );
    req.on("timeout", () =>
      req.destroy(new Error(`docker did not answer in ${TIMEOUT_MS}ms`)),
    );
    req.on("error", fail);
    req.end();
  });
}

interface RawContainer {
  Id: string;
  Created?: number;
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
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
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
  const values = [
    cpu?.cpu_usage?.total_usage,
    pre?.cpu_usage?.total_usage,
    cpu?.system_cpu_usage,
    pre?.system_cpu_usage,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  )
    return null;
  const used = cpu!.cpu_usage!.total_usage! - pre!.cpu_usage!.total_usage!;
  const system = cpu!.system_cpu_usage! - pre!.system_cpu_usage!;
  if (system <= 0 || used < 0) return null;
  const cores = cpu?.online_cpus ?? (Array.isArray(cpu?.cpu_usage?.percpu_usage) ? cpu.cpu_usage.percpu_usage.length : null);
  if (typeof cores !== "number" || !Number.isFinite(cores) || cores <= 0)
    return null;
  const fraction = (used / system) * cores;
  return Number.isFinite(fraction) ? fraction : null;
}

function toStats(raw: RawStats): SandboxStats {
  const finite = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const net =
    raw.networks &&
    typeof raw.networks === "object" &&
    !Array.isArray(raw.networks)
      ? Object.values(raw.networks)
      : [];
  const sum = (
    pick: (n: { rx_bytes?: number; tx_bytes?: number }) => number | undefined,
  ) => {
    if (!net.length) return null;
    const values = net.map((n) =>
      n && typeof n === "object" ? finite(pick(n)) : null,
    );
    return values.some((n) => n === null)
      ? null
      : finite(values.reduce<number>((total, n) => total + n!, 0));
  };
  return {
    cpu: cpuFraction(raw),
    memoryBytes: finite(raw.memory_stats?.usage),
    memoryLimitBytes: finite(raw.memory_stats?.limit),
    networkRxBytes: sum((n) => n.rx_bytes),
    networkTxBytes: sum((n) => n.tx_bytes),
    pids: finite(raw.pids_stats?.current),
  };
}

/**
 * Bounded container inspection from the daemon's inventory, running or stopped.
 *
 * `all=1` on purpose: an exited sandbox is evidence, not noise. A container that
 * died holding a session is exactly what someone debugging a wedged session is
 * looking for, and hiding it would make the page agree with `docker ps` rather
 * than with the question being asked.
 */
export async function listSandboxes(): Promise<SandboxAvailability> {
  const socketPath = dockerSocket();
  if (socketPath === null) return { kind: "disabled" };

  const filters = encodeURIComponent(
    JSON.stringify({ label: [SANDBOX_LABELS.marker] }),
  );
  let raw: RawContainer[];
  try {
    raw = await get<RawContainer[]>(
      socketPath,
      `/containers/json?all=1&filters=${filters}`,
    );
    if (
      !Array.isArray(raw) ||
      raw.some(
        (c) => !c || typeof c.Id !== "string" || !/^[a-f0-9]{64}$/i.test(c.Id),
      )
    )
      throw new Error("Docker returned an invalid container inventory.");
    if (new Set(raw.map((c) => c.Id)).size !== raw.length)
      throw new Error("Docker returned duplicate container IDs.");
  } catch (error) {
    return {
      kind: "unreachable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const now = Date.now();
  // Prioritize running and older-created containers, then a stable ID order.
  // Omitted containers remain an explicit blind spot in both the page and alerts.
  const oldest = (c: RawContainer) =>
    typeof c.Created === "number" && Number.isFinite(c.Created)
      ? c.Created
      : Infinity;
  raw.sort(
    (a, b) =>
      Number(b.State === "running") - Number(a.State === "running") ||
      oldest(a) - oldest(b) ||
      a.Id.localeCompare(b.Id),
  );
  const selected = raw.slice(0, SANDBOX_INSPECTION_LIMIT);
  const sandboxes: Sandbox[] = [];
  let cursor = 0;
  const string = (value: unknown, limit = 500): string | null =>
    typeof value === "string" && value.length <= limit ? value : null;
  await Promise.all(
    Array.from(
      { length: Math.min(INSPECTION_WORKERS, selected.length) },
      async () => {
        while (cursor < selected.length) {
          const c = selected[cursor++];
          const labels = c.Labels ?? {};
          const running = c.State === "running";

          // Inspect and stats are per container and independent; a failure in
          // either degrades that field rather than the row. A container that exits
          // between the list and the inspect is normal, not an error.
          const [inspect, stats] = await Promise.all([
            get<RawInspect>(socketPath, `/containers/${c.Id}/json`).catch(
              () => null,
            ),
            running
              ? get<RawStats>(
                  socketPath,
                  `/containers/${c.Id}/stats?stream=false&one-shot=false`,
                ).catch(() => null)
              : Promise.resolve(null),
          ]);

          const startedAt = string(inspect?.State?.StartedAt);
          const startedMs = startedAt === null ? NaN : Date.parse(startedAt);
          sandboxes.push({
            id: c.Id,
            name: (string(c.Names?.[0]) ?? c.Id).replace(/^\//, ""),
            image: string(c.Image) ?? "",
            state: string(c.State) ?? "unknown",
            status: string(c.Status) ?? "",
            startedAt,
            // Docker reports a zero time for a container that has never started.
            uptimeMs:
              Number.isFinite(startedMs) &&
              startedMs > 0 &&
              startedMs <= now &&
              running
                ? now - startedMs
                : null,
            networkMode:
              string(inspect?.HostConfig?.NetworkMode, 200) ??
              string(c.HostConfig?.NetworkMode, 200),
            sessionId: string(labels[SANDBOX_LABELS.sessionId]),
            agent: string(labels[SANDBOX_LABELS.agent]),
            channel: string(labels[SANDBOX_LABELS.channel]),
            templateKey: string(labels[SANDBOX_LABELS.templateKey]),
            role: string(labels[SANDBOX_LABELS.role]),
            stats: stats === null ? null : toStats(stats),
          });
        }
      },
    ),
  );

  // Running first, then longest-lived: the orphan that has been up for hours is
  // the row worth seeing, and sorting by name would bury it.
  sandboxes.sort((a, b) => {
    const ar = a.state === "running" ? 0 : 1;
    const br = b.state === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.uptimeMs ?? 0) - (a.uptimeMs ?? 0);
  });

  return {
    kind: "ok",
    sandboxes,
    coverage: {
      listed: raw.length,
      inspected: sandboxes.length,
      omitted: raw.length - sandboxes.length,
      limit: SANDBOX_INSPECTION_LIMIT,
    },
  };
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
