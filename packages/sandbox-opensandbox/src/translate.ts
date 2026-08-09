/**
 * The pure translations between eve's conventions and OpenSandbox's wire
 * shapes: where a path lands, how a command's output is reassembled, what an
 * execution's exit code actually means, how a spawned process is made
 * killable, and how an eve network policy maps onto OpenSandbox's egress
 * model.
 *
 * They live in their own module for one reason. Everything in index.ts needs a
 * live OpenSandbox server to run at all, so nothing there can be pinned by a
 * test; these need nothing, and the first two both shipped with a bug —
 * `joinOutput` first mashed multi-line stdout into one word, then
 * over-corrected into inventing a trailing newline. Both were module-private,
 * which is precisely why neither was ever caught by a test. `exitCodeOf` was
 * module-private for the same reason and shipped the same way: its doc comment
 * said a killed command must not report success and its body returned 0 for
 * exactly that case.
 *
 * Deliberately NOT added to the package's `exports` map: the tests reach these
 * by relative path into `dist/`, the same way @evestack/schedules tests its
 * cron parser, so they became testable without becoming public API.
 */

/**
 * eve pins `/workspace` as the live working directory for every backend and
 * documents relative-path anchoring against it on `SandboxSession.resolvePath`
 * (eve dist/src/shared/sandbox-session.d.ts). It is one namespace across
 * backends, so it is not configurable here — see `OpenSandboxOptions`.
 */
export const WORKSPACE = "/workspace";

/**
 * `/workspace` is one namespace across every eve backend, so a relative path
 * must resolve the same way here as it does on Docker or Vercel.
 */
export function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  if (path.startsWith("$HOME/")) return `/root/${path.slice(6)}`;
  return `${WORKSPACE}/${path}`;
}

/**
 * OpenSandbox returns stdout as one message PER LINE with the newline stripped:
 * `printf "a\nb\nc\n"` arrives as `[{text:"a"},{text:"b"},{text:"c"}]`. Joining
 * those with "" — as this did originally — produced "abc", so every multi-line
 * command the model ran came back as one mashed-together string. Verified
 * against a live server before and after.
 *
 * So "\n" is a SEPARATOR here, not a terminator, and that difference was the
 * second bug this function shipped. Appending one after the last line made
 * `printf %s x` return "x\n" where eve's Docker backend returns "x" — and a
 * one-line result is the common case for a tool call, so the invented byte
 * landed on nearly every command.
 *
 * Be honest about the cost: a trailing newline is unrecoverable. It is stripped
 * from every message, so `printf 'a\nb'` and `printf 'a\nb\n'` both arrive as
 * `[{text:"a"},{text:"b"}]`, and both come back as "a\nb" where Docker would
 * tell them apart. Interior newlines are exact; the final one is dropped rather
 * than guessed at, because guessing wrong corrupts the short outputs — which
 * are most of them — instead of the long ones.
 */
export function joinOutput(messages: readonly unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  const lines = messages.map((m) => {
    if (typeof m === "string") return m;
    const record = m as Record<string, unknown>;
    const value = record.text ?? record.content ?? record.line ?? record.data;
    return typeof value === "string" ? value : "";
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/**
 * What this backend reports for a command that never told anyone how it ended.
 *
 * 137 is 128 + SIGKILL(9) — the number Linux, Docker, and therefore eve's own
 * `docker()` backend surface for a process that was killed rather than exited.
 * Using it here means both kinds of downstream reader get a defensible answer:
 * code that only asks `exitCode !== 0` sees failure, and code that reads the
 * number sees "killed" rather than a made-up 1.
 */
export const KILLED_EXIT_CODE = 137;

/**
 * The exit code of one OpenSandbox execution.
 *
 * `null` is reachable and it does NOT mean zero. The SDK derives a foreground
 * exit code in `inferForegroundExitCode`
 * (@alibaba-group/opensandbox/src/adapters/commandsAdapter.ts): an `error`
 * event's value is parsed as an integer, a clean `execution_complete` is 0, and
 * **anything else is `null`** — a server-side timeout kill (`RunCommandOpts.
 * timeoutSeconds`, documented as "the server will terminate the command"), an
 * OOM-killed container, or an SSE stream that simply ends. In every one of
 * those the command did not complete.
 *
 * This function's doc comment has always said so. Its body did the opposite:
 * `execution.exitCode ?? (execution.error ? 1 : 0)` returned **0** whenever
 * there was no error object, so a killed command was reported to the model as a
 * success — and README.md advertised the fixed behaviour ("A null exit code is
 * reported as failure, not success") that the code did not implement.
 * Reproduced before the fix: an execution of `{exitCode: null, error:
 * undefined}` came back from `session.run()` as `{"exitCode":0}`.
 *
 * `undefined` is folded in with `null` on purpose: it is what the SDK leaves
 * behind for a `background: true` run, which is equally "no exit code known".
 */
export function exitCodeOf(execution: {
  readonly exitCode?: number | null;
  readonly error?: unknown;
}): number {
  if (typeof execution.exitCode === "number") return execution.exitCode;
  // An error object with no parseable code is a generic failure; no error and
  // no code is a process that was terminated out from under us.
  return execution.error ? 1 : KILLED_EXIT_CODE;
}

// ---------------------------------------------------------------------------
// Killing a spawned process
// ---------------------------------------------------------------------------

/** Single-quote for `sh`. Same implementation as eve's own `shellQuote`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Walks /proc to kill a pid and every descendant of it, then removes the pid
 * file. Lifted from eve's Docker backend (`DOCKER_KILL_TREE_SCRIPT` in eve
 * dist/src/execution/sandbox/bindings/docker-session.js) so a spawned process
 * dies the same way on this backend as it does on `docker()`.
 *
 * Killing only the recorded pid is not enough: the pid belongs to the shell
 * execd started for the command, and the interesting process is usually its
 * child. `exit 0` on a missing or empty pid file is what makes `kill()`
 * idempotent — a process that already exited removed its own pid file.
 *
 * bash, not sh: `local`, `${var//pattern/}` and `/proc/[0-9]*` are bashisms.
 * The image is required to contain bash anyway (eve verifies it during setup),
 * and this is invoked as an explicit `bash -c` so it does not depend on which
 * shell execd happens to run commands with.
 */
const KILL_TREE_SCRIPT = [
  `pid_file="$1"`,
  `target="$(cat "$pid_file" 2>/dev/null)" || exit 0`,
  `[ -n "$target" ] || exit 0`,
  `kill_tree() {`,
  `  local parent="$1" dir child ppid line`,
  `  for dir in /proc/[0-9]*; do`,
  '    child="${dir#/proc/}"',
  `    ppid=""`,
  `    while IFS= read -r line; do`,
  `      case "$line" in`,
  '        PPid:*) ppid="${line#PPid:}"; ppid="${ppid//[^0-9]/}"; break ;;',
  `      esac`,
  `    done < "$dir/status" 2>/dev/null`,
  `    [ "$ppid" = "$parent" ] && kill_tree "$child"`,
  `  done`,
  `  kill -9 "$parent" 2>/dev/null`,
  `}`,
  `kill_tree "$target"`,
  `rm -f "$pid_file"`,
  `exit 0`,
].join("\n");

/** Where one spawned process records its pid so `kill()` can find it. */
export function spawnPidFilePath(unique: string): string {
  return `/tmp/.evestack-sbx-spawn-${unique}.pid`;
}

/**
 * The command `kill()` runs INSIDE the sandbox.
 *
 * The previous `kill()` only called `AbortController.abort()`, which closes our
 * SSE connection and nothing else — verified against the current build: during
 * `kill()` the adapter made zero further calls to the sandbox. Whether execd
 * reaps a command when its client disconnects is a server-side detail the SDK
 * does not promise; it ships a separate termination API precisely because
 * hanging up is not a kill. So the process is killed by name, from inside.
 */
export function killProcessTreeCommand(pidFile: string): string {
  // Script as $0's argument list, exactly as eve's docker backend passes it, so
  // the pid file never has to be interpolated into the script body.
  return `bash -c ${shellQuote(KILL_TREE_SCRIPT)} evestack-kill-tree ${shellQuote(pidFile)}`;
}

/**
 * Wraps a spawned command so its pid is recorded before it starts and cleaned
 * up after it ends, without changing what the command itself does.
 *
 * Newline-separated rather than `;`-separated because the caller's command may
 * legally end in a `# comment` or contain a heredoc, either of which would
 * swallow whatever followed on the same line. Deliberately NOT `exec`'d and
 * deliberately not re-wrapped in `bash -lc`: `exec foo && bar` would drop
 * `bar`, and a second shell would give `spawn()` a different environment from
 * `run()` on the same session. `exit $status` keeps the command's own exit code
 * as the execution's exit code.
 */
export function spawnWrapperCommand(command: string, pidFile: string): string {
  const quoted = shellQuote(pidFile);
  return [`echo "$$" > ${quoted}`, command, `status=$?`, `rm -f ${quoted}`, `exit $status`].join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Network policy
// ---------------------------------------------------------------------------

/**
 * OpenSandbox's egress model (@alibaba-group/opensandbox src/models/sandboxes.ts).
 *
 * A `type` and not an `interface`, and `egress` a mutable array: the SDK's own
 * `NetworkPolicy` extends `Record<string, unknown>` and declares `egress` as a
 * mutable array, and an interface has no implicit index signature while a
 * `ReadonlyArray` will not widen — either one makes this unassignable to
 * `SandboxCreateOptions.networkPolicy`, which is the entire point of it.
 */
export type OpenSandboxNetworkPolicy = {
  readonly defaultAction: "allow" | "deny";
  readonly egress?: Array<{ readonly action: "allow" | "deny"; readonly target: string }>;
};

function unsupported(detail: string): Error {
  return new Error(
    `opensandbox({ networkPolicy }): ${detail} The OpenSandbox egress model is a default action plus a ` +
      `list of {action, target} domain rules, and this adapter refuses to apply a policy it can only ` +
      `partially express — a network restriction that is half-applied reports success having left the ` +
      `hole open. Use vercel() or microsandbox() for the full eve policy model.`,
  );
}

/**
 * eve's `SandboxNetworkPolicy` (which is Vercel's `NetworkPolicy`) as an
 * OpenSandbox `networkPolicy`, or a throw.
 *
 * Both models are "a default action plus rules", so the coarse cases map
 * exactly. What does NOT map throws instead of being dropped:
 *
 * - `subnets` — OpenSandbox's own type says "IP/CIDR is not supported in the
 *   egress MVP", and a CIDR deny-list that is silently discarded is a hole.
 * - a per-domain rule (`transform` / `forwardURL` / `match`) — header injection
 *   at the firewall is OpenSandbox's Credential Vault, a different model with
 *   different bindings, and request-level matching has no equivalent at all.
 *
 * An allow-list denies by default. That is eve's rule ("an allow-list, which
 * denies everything it does not name") and it is why an empty or absent `allow`
 * is the same as `deny-all` rather than the same as no policy: the caller asked
 * for a restriction either way.
 */
export function toOpenSandboxNetworkPolicy(policy: unknown): OpenSandboxNetworkPolicy {
  if (policy === "allow-all") return { defaultAction: "allow" };
  if (policy === "deny-all") return { defaultAction: "deny", egress: [] };

  if (typeof policy !== "object" || policy === null) {
    throw unsupported(`unrecognised policy ${JSON.stringify(policy)}.`);
  }

  const { allow, subnets } = policy as {
    allow?: unknown;
    subnets?: unknown;
  };

  if (subnets !== undefined) {
    throw unsupported("`subnets` (CIDR allow/deny) has no OpenSandbox equivalent.");
  }

  const domains: string[] = [];
  if (Array.isArray(allow)) {
    for (const domain of allow) {
      if (typeof domain !== "string") {
        throw unsupported(`\`allow\` contained a non-string entry ${JSON.stringify(domain)}.`);
      }
      domains.push(domain);
    }
  } else if (typeof allow === "object" && allow !== null) {
    for (const [domain, rules] of Object.entries(allow as Record<string, unknown>)) {
      if (Array.isArray(rules) && rules.length > 0) {
        throw unsupported(
          `\`allow["${domain}"]\` carries ${rules.length} per-domain rule` +
            `${rules.length === 1 ? "" : "s"} (transform / forwardURL / match).`,
        );
      }
      domains.push(domain);
    }
  } else if (allow !== undefined) {
    throw unsupported(`\`allow\` must be an array or an object, got ${typeof allow}.`);
  }

  return {
    defaultAction: "deny",
    egress: domains.map((target) => ({ action: "allow" as const, target })),
  };
}

/**
 * A stable string for one translated policy, persisted with the sandbox id.
 *
 * OpenSandbox fixes `defaultAction` when the sandbox is created and its
 * run-time egress API preserves it (which is the whole reason
 * `setNetworkPolicy()` rejects). So reattaching to a sandbox created under a
 * different policy would hand back the OLD egress rules while the operator
 * reads the new ones in their source — the exact silent-downgrade this option
 * exists to prevent. `create()` compares this key before reusing a sandbox.
 *
 * `"unset"` for no policy, so a session persisted before this option existed
 * keeps reattaching instead of failing on upgrade.
 */
export function networkPolicyKey(policy: OpenSandboxNetworkPolicy | undefined): string {
  if (policy === undefined) return "unset";
  const rules = (policy.egress ?? []).map((rule) => `${rule.action}:${rule.target}`).join(",");
  return `${policy.defaultAction}|${rules}`;
}

/**
 * The keys that describe an unrestricted sandbox, which is more than one string.
 *
 * `"unset"` is what a backend with no `networkPolicy` records: nothing is sent
 * to `Sandbox.create`, so the sandbox comes up under the server's startup
 * default. `"allow|"` is what an explicit `networkPolicy: "allow-all"` records:
 * `{defaultAction: "allow"}` with no rules. Those are the SAME egress. The SDK's
 * own schema says so — "passing an empty object or null results in allow-all
 * behavior at startup" (@alibaba-group/opensandbox src/api/lifecycle.ts, the
 * `NetworkPolicy` description) — so a sandbox created with no policy and one
 * created with an allow-all policy are both wide open.
 */
const UNRESTRICTED_POLICY_KEYS: ReadonlySet<string> = new Set(["unset", "allow|"]);

/**
 * Whether two persisted policy keys describe the same egress.
 *
 * This exists because `create()` compared the raw strings, and the raw strings
 * distinguish two spellings of "no restriction" (see `UNRESTRICTED_POLICY_KEYS`).
 * The consequence was not theoretical: adding `networkPolicy: "allow-all"` — a
 * semantic no-op, the state every session was already in — made the comparison
 * in index.ts read `"unset" !== "allow|"` and REFUSED to reattach to any live
 * session. Reproduced against the previous build with a stubbed SDK: a session
 * whose metadata said `networkPolicyKey: "unset"` threw
 * `was created with network policy [unset], and opensandbox() now asks for
 * [allow|]`, and so did the reverse. Every existing session was bricked by an
 * edit that changed nothing about the sandbox.
 *
 * Only the unrestricted spellings collapse. `deny|` and `deny|allow:github.com`
 * stay distinct from each other and from both of those, because those really are
 * different egress and a sandbox cannot be moved between them.
 */
export function sameNetworkPolicyKey(a: string, b: string): boolean {
  const canonical = (key: string): string => (UNRESTRICTED_POLICY_KEYS.has(key) ? "unset" : key);
  return canonical(a) === canonical(b);
}
