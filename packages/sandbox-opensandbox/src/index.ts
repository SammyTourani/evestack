import { Sandbox } from "@alibaba-group/opensandbox";
import type {
  SandboxBackendCreateInput,
  SandboxBackendSessionState,
} from "eve/sandbox";

/**
 * An eve `SandboxBackend` backed by Alibaba OpenSandbox.
 *
 * eve ships four backends: `vercel()` (hosted, metered), `docker()`,
 * `microsandbox()`, and `justbash()`. This adds a fifth for people who want
 * gVisor-grade isolation without paying Vercel — OpenSandbox intercepts syscalls
 * at the kernel boundary rather than relying on container namespaces, and is
 * Apache-2.0 like the rest of this stack.
 *
 * Reach for it when the agent runs code you do not trust. Docker is the right
 * default for everything else and needs no server.
 */

/** Shape eve requires of a backend. Structural, so eve stays a peer dependency. */
interface SandboxBackendLike {
  readonly name: string;
  create(input: CreateInput): Promise<BackendHandle>;
  prewarm(input: PrewarmInput): Promise<{ reused: boolean }>;
}

interface CreateInput {
  readonly templateKey: string | null;
  readonly sessionKey: string;
  readonly existingMetadata?: Record<string, unknown>;
}

interface PrewarmInput {
  readonly templateKey: string;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<{ path: string; content: string | Uint8Array }>;
}

interface BackendHandle {
  readonly session: SandboxSessionLike;
  readonly useSessionFn: () => SandboxSessionLike;
  captureState(): Promise<{
    backendName: string;
    metadata: Record<string, unknown>;
    sessionKey: string;
  }>;
  shutdown(): Promise<void>;
}

/**
 * The interfaces above stay structural on purpose: eve remains a peer
 * dependency and nothing here imports it at run time.
 *
 * But a hand-copied interface agrees with itself by construction, so it drifts
 * silently — and this one did. `captureState` shipped through 0.2.0 without
 * `sessionKey`, which eve requires to match a persisted handle back to its
 * durable session. It never matched, so every turn built a fresh sandbox and
 * left the previous one paused on the OpenSandbox host. Nothing failed; the
 * reconnect metadata was written correctly and then never consulted.
 *
 * These two assertions are type-only and erase completely, and they hand the
 * authority back to eve's own declarations: add a required field upstream and
 * `pnpm typecheck` fails here, in CI, instead of on someone's sandbox bill.
 */
type Conforms<Actual extends Expected, Expected> = Actual;

/** What we hand back must satisfy what eve persists. */
type _SessionStateConforms = Conforms<
  Awaited<ReturnType<BackendHandle["captureState"]>>,
  SandboxBackendSessionState
>;

/** What eve hands us must fit what `create` destructures. */
type _CreateInputConforms = Conforms<SandboxBackendCreateInput, CreateInput>;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SandboxSessionLike {
  readonly id: string;
  resolvePath(path: string): string;
  run(options: { command: string; cwd?: string; env?: Record<string, string> }): Promise<RunResult>;
  readTextFile(options: { path: string }): Promise<string>;
  writeTextFile(options: { path: string; content: string }): Promise<void>;
  readBinaryFile(options: { path: string }): Promise<Uint8Array>;
  writeBinaryFile(options: { path: string; content: Uint8Array }): Promise<void>;
  readFile(options: { path: string }): Promise<Uint8Array>;
  writeFile(options: { path: string; content: Uint8Array }): Promise<void>;
}

export interface OpenSandboxOptions {
  /** Container image. Must contain bash — eve verifies that during setup. */
  readonly image?: string;
  /** OpenSandbox server, e.g. `https://sandbox.internal:8080`. */
  readonly domain?: string;
  readonly apiKey?: string;
  /** Idle lifetime. eve reattaches by id, so a short value is safe and cheap. */
  readonly timeoutSeconds?: number;
  readonly workingDirectory?: string;
}

const WORKSPACE = "/workspace";

/**
 * `/workspace` is one namespace across every eve backend, so a relative path
 * must resolve the same way here as it does on Docker or Vercel.
 */
function resolvePath(path: string): string {
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
 * Re-adding the separators makes this backend agree with eve's Docker backend,
 * which hands back raw stdout including its trailing newline. A tool result has
 * to look the same whichever sandbox produced it.
 */
function joinOutput(messages: readonly unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  const lines = messages.map((m) => {
    if (typeof m === "string") return m;
    const record = m as Record<string, unknown>;
    const value = record.text ?? record.content ?? record.line ?? record.data;
    return typeof value === "string" ? value : "";
  });
  return `${lines.join("\n")}\n`;
}

function wrapSession(sandbox: Sandbox): SandboxSessionLike {
  const readBytes = async (path: string): Promise<Uint8Array> => {
    const bytes = await sandbox.files.readBytes(resolvePath(path));
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
  };

  const write = async (path: string, data: string | Uint8Array): Promise<void> => {
    await sandbox.files.writeFiles([{ path: resolvePath(path), data }]);
  };

  return {
    id: String(sandbox.id),
    resolvePath,

    async run({ command, cwd, env }) {
      const execution = await sandbox.commands.run(command, {
        workingDirectory: cwd ? resolvePath(cwd) : WORKSPACE,
        ...(env ? { envs: env } : {}),
      });
      return {
        stdout: joinOutput(execution.logs?.stdout),
        stderr: joinOutput(execution.logs?.stderr),
        // A null exitCode means the process was killed rather than exiting.
        // Reporting 0 there would tell the model a failed command succeeded.
        exitCode: execution.exitCode ?? (execution.error ? 1 : 0),
      };
    },

    readTextFile: ({ path }) => sandbox.files.readFile(resolvePath(path)),
    writeTextFile: ({ path, content }) => write(path, content),
    readBinaryFile: ({ path }) => readBytes(path),
    writeBinaryFile: ({ path, content }) => write(path, content),
    readFile: ({ path }) => readBytes(path),
    writeFile: ({ path, content }) => write(path, content),
  };
}

export function opensandbox(options: OpenSandboxOptions = {}): SandboxBackendLike {
  const connectionConfig =
    options.domain || options.apiKey
      ? {
          ...(options.domain ? { domain: options.domain } : {}),
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        }
      : undefined;

  return {
    // Participates in eve's cache-key derivation and reconnect state, so it
    // must not collide with the built-in "vercel" or "local".
    name: "opensandbox",

    async create({ existingMetadata, sessionKey }) {
      const previousId = existingMetadata?.sandboxId;

      // Reattach before creating. eve keys sandboxes to durable sessions, so a
      // server restart must land back in the same filesystem rather than
      // silently handing the agent an empty one.
      //
      // `connect` alone is not enough, and getting this wrong is silent. Our
      // shutdown() pauses the sandbox, and connect() on a paused sandbox fails
      // — so the original version fell straight through to Sandbox.create and
      // handed the session a brand new, empty filesystem while reporting
      // success. Measured: the reattached id never matched the captured one.
      // `resume` is what wakes a paused sandbox, so it is the fallback.
      const reconnect: Array<(id: string) => Promise<Sandbox>> = [
        (id) =>
          Sandbox.connect({ sandboxId: id, ...(connectionConfig ? { connectionConfig } : {}) }),
        (id) =>
          Sandbox.resume({ sandboxId: id, ...(connectionConfig ? { connectionConfig } : {}) }),
      ];

      let sandbox: Sandbox | null = null;
      if (typeof previousId === "string" && previousId.length > 0) {
        for (const attempt of reconnect) {
          try {
            sandbox = await attempt(previousId);
            break;
          } catch {
            // Try the next strategy; only a genuinely gone sandbox falls all
            // the way through to create().
            sandbox = null;
          }
        }
      }

      sandbox ??= await Sandbox.create({
        image: options.image ?? "ubuntu",
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(connectionConfig ? { connectionConfig } : {}),
      });

      const live = sandbox;
      await live.files.createDirectories([{ path: options.workingDirectory ?? WORKSPACE }]);
      const session = wrapSession(live);

      return {
        session,
        useSessionFn: () => session,
        captureState: async () => ({
          backendName: "opensandbox",
          // The id is the whole reconnect story; without persisting it every
          // restart would orphan a running sandbox and start a fresh one.
          metadata: { sandboxId: String(live.id) },
          // eve keys captured state to the durable session it came from, and
          // omitting this is silent in exactly the way the reconnect ladder
          // above was: `SandboxBackendSessionState` requires it (eve
          // dist/src/shared/sandbox-backend.d.ts), so a handle without it never
          // matches on the next start. The metadata was persisted correctly and
          // then never consulted — every turn built a fresh sandbox and left the
          // previous one paused on the OpenSandbox host, which is a leak the
          // caller pays for. Fixing connect() was only half of it.
          sessionKey,
        }),
        shutdown: async () => {
          // pause(), not kill(): eve reattaches by id on the next turn, and
          // killing here would discard /workspace that the session still owns.
          await live.pause().catch(() => live.kill().catch(() => {}));
        },
      };
    },

    async prewarm({ log }) {
      // OpenSandbox has snapshots, but eve only needs prewarm to be idempotent
      // and honest. Reporting `reused: false` costs a cold start on first use
      // and never lies to the build log about state that was not captured.
      log?.("[opensandbox] no template snapshot captured; sessions start cold");
      return { reused: false };
    },
  };
}
