import { randomUUID } from "node:crypto";
import { Sandbox } from "@alibaba-group/opensandbox";
import type { FileInfo } from "@alibaba-group/opensandbox";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendSessionState,
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxTemplateNotProvisionedError,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "eve/sandbox";
import type { SandboxCommandResult } from "eve/sandbox";
import type { OpenSandboxNetworkPolicy } from "./translate.js";
import {
  KILLED_EXIT_CODE,
  WORKSPACE,
  exitCodeOf,
  joinOutput,
  killProcessTreeCommand,
  networkPolicyKey,
  resolvePath,
  sameNetworkPolicyKey,
  spawnPidFilePath,
  spawnWrapperCommand,
  toOpenSandboxNetworkPolicy,
} from "./translate.js";

/**
 * An eve `SandboxBackend` backed by Alibaba OpenSandbox.
 *
 * eve ships four backends: `vercel()` (hosted, metered), `docker()`,
 * `microsandbox()`, and `justbash()`. This adds a fifth for people who want to
 * self-host their sandbox host on Apache-2.0 software instead of paying Vercel.
 *
 * On isolation, precisely: OpenSandbox *can* be deployed on a secure runtime
 * (gVisor, Kata, Firecracker), and that is the reason to prefer it over plain
 * Docker for untrusted code — but which runtime a sandbox lands on is decided by
 * the SERVER's configuration, not by anything this adapter sends. The client SDK
 * (v0.1.11) exposes no runtime selector: `SandboxCreateOptions` carries `image`,
 * `platform` (os/arch), `secureAccess` (endpoint auth headers, not isolation),
 * resources, volumes, network policy and an opaque `extensions` map, and none of
 * them names a runtime. So this backend inherits whatever isolation the server
 * was configured with, and cannot verify or request it. Do not choose it on the
 * strength of a property it does not select — see README.md.
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
  /**
   * Declared because eve declares it. It was absent here, which is how the
   * destructure below could ignore it without anyone noticing — see `prewarm`.
   */
  readonly bootstrap?: (input: never) => void | Promise<void>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<{ path: string; content: string | Uint8Array }>;
}

interface BackendHandle {
  readonly session: SandboxSessionLike;
  readonly useSessionFn: () => Promise<SandboxSessionLike>;
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
 * silently — and this one did, twice.
 *
 * First `captureState` shipped through 0.2.0 without `sessionKey`, which eve
 * requires to match a persisted handle back to its durable session. It never
 * matched, so every turn built a fresh sandbox and left the previous one paused
 * on the OpenSandbox host. Nothing failed; the reconnect metadata was written
 * correctly and then never consulted.
 *
 * Then the SESSION drifted the same way, and the assertions added for the first
 * bug did not cover it: they pinned `captureState`'s return and `create`'s
 * input, and stopped there. eve's `SandboxSession` requires `spawn`,
 * `setNetworkPolicy` and `removePath` — all non-optional — and the wrapper
 * shipped none of them, so a tool deleting a sandbox file got
 * "session.removePath is not a function". The same hand-copy also declared
 * `run({ cwd })` where eve passes `workingDirectory`, and typed `readFile` as
 * returning bytes where eve's contract is a byte stream.
 *
 * So the session's signatures are now taken from eve's own exported option types
 * (`SandboxRunOptions`, `SandboxReadTextFileOptions`, and the rest) instead of
 * being retyped here. That is the only thing that would have caught
 * `run({ cwd })`: a hand-written parameter declaring FEWER fields than eve
 * passes is legal TypeScript whichever variance applies — checked, it compiles
 * clean — so no assertion can catch it and the option type has to come from eve
 * or not exist at all.
 *
 * The assertions below then cover what assertions can cover: a missing member, a
 * wrong return type, and (because these are declared as properties rather than
 * methods, so the parameter check is contravariant rather than bivariant) an
 * implementation that demands more of its options than eve promises to pass. All
 * of it is type-only and erases completely: add a required member upstream and
 * `pnpm typecheck` fails here, in CI, instead of on someone's sandbox bill.
 */
type Conforms<Actual extends Expected, Expected> = Actual;

/** What we hand back must satisfy what eve persists. */
type _SessionStateConforms = Conforms<
  Awaited<ReturnType<BackendHandle["captureState"]>>,
  SandboxBackendSessionState
>;

/** The session eve hands to authored hooks. The assertion that was missing. */
type _SessionConforms = Conforms<SandboxSessionLike, SandboxSession>;

/** ...and the handle that carries it, so `useSessionFn` cannot drift either. */
type _HandleConforms = Conforms<BackendHandle, SandboxBackendHandle>;

/** ...and the backend itself, which closes `create` and `prewarm`. */
type _BackendConforms = Conforms<SandboxBackendLike, SandboxBackend>;

/** What eve hands us must fit what `create` destructures. */
type _CreateInputConforms = Conforms<SandboxBackendCreateInput, CreateInput>;

/** And the error below must still be the one eve's `is()` narrows. */
type _TemplateErrorConforms = Conforms<TemplateNotProvisioned, SandboxTemplateNotProvisionedError>;

/** Options for `removePath`; eve exports the session but not this shape. */
type RemovePathOptions = Parameters<SandboxSession["removePath"]>[0];

interface SandboxSessionLike {
  readonly id: string;
  resolvePath(path: string): string;
  readonly run: (options: SandboxRunOptions) => Promise<SandboxCommandResult>;
  readonly spawn: (options: SandboxSpawnOptions) => Promise<SandboxProcess>;
  readonly setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
  readonly removePath: (options: RemovePathOptions) => Promise<void>;
  readonly readFile: (options: SandboxReadFileOptions) => Promise<ReadableStream<Uint8Array> | null>;
  readonly readBinaryFile: (options: SandboxReadBinaryFileOptions) => Promise<Uint8Array | null>;
  readonly readTextFile: (options: SandboxReadTextFileOptions) => Promise<string | null>;
  readonly writeFile: (options: SandboxWriteFileOptions) => Promise<void>;
  readonly writeBinaryFile: (options: SandboxWriteBinaryFileOptions) => Promise<void>;
  readonly writeTextFile: (options: SandboxWriteTextFileOptions) => Promise<void>;
}

const BACKEND_NAME = "opensandbox";

/**
 * eve's `SandboxTemplateNotProvisionedError`, reconstructed structurally.
 *
 * eve stays out of the run-time import graph (see the note above), and eve's own
 * `SandboxTemplateNotProvisionedError.is()` accepts a structural match — the
 * `name` plus string `backendName` and `templateKey` — precisely so an error
 * raised across a package boundary still narrows. The `Conforms` assertion above
 * is what keeps that promise: add a field to eve's class and this stops
 * compiling.
 *
 * The message is deliberately NOT eve's. eve's says "Run `eve build` or invoke
 * `prewarmAppSandboxes()`", and for this backend that advice is false — no
 * amount of prewarming will provision a template it cannot capture. eve's
 * runtime re-runs prewarm and retries `create` exactly once on this error, so
 * the operator would otherwise read "run eve build" after eve already did.
 */
class TemplateNotProvisioned extends Error {
  readonly backendName: string;
  readonly templateKey: string;

  constructor(input: { backendName: string; templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is not provisioned for backend ` +
        `"${input.backendName}", and this backend cannot provision one: it does not implement ` +
        `OpenSandbox snapshots, so a bootstrap() hook and seedFiles cannot be applied. eve only ` +
        `asks for a template when the sandbox declares one of those, so either remove them, or ` +
        `use docker() / vercel(), which capture template state. Refusing the session is ` +
        `deliberate — the previous release started it from a bare image instead, so the sandbox ` +
        `came up without the tools bootstrap() installed and without any seed file, and nothing ` +
        `said so.`,
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.backendName = input.backendName;
    this.templateKey = input.templateKey;
  }
}

export interface OpenSandboxOptions {
  /** Container image. Must contain bash — eve verifies that during setup. */
  readonly image?: string;
  /** OpenSandbox server, e.g. `https://sandbox.internal:8080`. */
  readonly domain?: string;
  readonly apiKey?: string;
  /** Idle lifetime. eve reattaches by id, so a short value is safe and cheap. */
  readonly timeoutSeconds?: number;
  /**
   * Egress policy applied when the sandbox is CREATED, and fixed for its life.
   *
   * `"deny-all"`, or an allow-list which denies everything it does not name.
   * OpenSandbox fixes a sandbox's `defaultAction` at creation — that is why
   * `session.setNetworkPolicy()` rejects on this backend (see below) — so this
   * is the only place a policy can be honoured, and it is honoured completely
   * or not at all: `subnets` and per-domain `transform` / `forwardURL` rules
   * have no OpenSandbox equivalent and throw here rather than being dropped.
   *
   * Passing it also pins the sandbox: `create()` refuses to reattach to a
   * sandbox that was created under a different policy, because the reattached
   * sandbox would keep the old egress rules while the operator reads the new
   * ones in their source.
   */
  readonly networkPolicy?: SandboxNetworkPolicy;
  /**
   * There is deliberately no `workingDirectory` here.
   *
   * 0.2.0 accepted one and it did nothing measurable: it was passed to
   * `createDirectories` and then ignored, because `run()` and `resolvePath()`
   * both hardcoded `/workspace`. `opensandbox({ workingDirectory: "/srv/app" })`
   * created the directory and ran everything in `/workspace` anyway.
   *
   * It is removed rather than honoured because eve pins the anchor: `/workspace`
   * is "the live working directory for every backend" and relative paths resolve
   * from it on every one of them (eve's `SandboxSession` docs). Making this
   * backend anchor somewhere else would break the one guarantee that lets the
   * same authored tool run on Docker, Vercel and here. A per-command working
   * directory is already reachable — `run({ workingDirectory })`, which eve
   * passes through and this backend now actually reads.
   */
}

// ---------------------------------------------------------------------------
// Session plumbing
// ---------------------------------------------------------------------------

/**
 * Duck-typed rather than `instanceof SandboxApiException`: the SDK keeps its own
 * state off the public instance shape specifically because two copies of it can
 * coexist in one dependency graph, and an `instanceof` across those two copies
 * is false.
 *
 * Narrow on purpose. Every other failure propagates, because answering "the file
 * is not there" for a connection reset is how `readTextFile` would hand a model
 * an empty file, and how `removePath({ force: true })` would report a successful
 * delete of something still on disk.
 */
function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  return status === 404;
}

/** eve's own decoder, reproduced: utf-8 is fatal, everything else is Buffer's. */
function decodeBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf-8" || encoding === "utf8") {
    // Fatal, matching eve: substituting U+FFFD for a malformed byte hands the
    // model text the file does not contain.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    encoding as BufferEncoding,
  );
}

function encodeString(content: string, encoding: string): string | Uint8Array {
  // The default path stays a plain string, which is the write this backend was
  // verified with; only a non-default encoding needs bytes.
  if (encoding === "utf-8" || encoding === "utf8") return content;
  return Buffer.from(content, encoding as BufferEncoding);
}

function validateReadTextFileOptions(options: SandboxReadTextFileOptions): void {
  const { startLine, endLine } = options;
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new Error("startLine must be a positive integer (1-based).");
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new Error("endLine must be a positive integer (1-based).");
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("startLine must not be greater than endLine.");
  }
}

/**
 * Line endings stay attached to their line, so a range slices bytes out of the
 * file rather than re-punctuating it. Copied from eve's own implementation
 * deliberately: `readTextFile({ startLine })` has to return the same string on
 * every backend or an authored tool is reading a different file here.
 */
function splitLinesPreservingEndings(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\r") {
      if (index + 1 < text.length && text[index + 1] === "\n") {
        lines.push(text.slice(start, index + 2));
        start = index + 2;
        index++;
      } else {
        lines.push(text.slice(start, index + 1));
        start = index + 1;
      }
    } else if (text[index] === "\n") {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function applyLineRange(text: string, options: SandboxReadTextFileOptions): string {
  if (options.startLine === undefined && options.endLine === undefined) return text;
  const lines = splitLinesPreservingEndings(text);
  const count = lines.length;
  const start = options.startLine ?? 1;
  // `endLine` past the file's line count reads through EOF without error, which
  // eve documents; clamping is what implements that.
  const end = Math.min(options.endLine ?? count, count);
  if (start > count) return "";
  return lines.slice(start - 1, end).join("");
}

/** One output channel of a spawned process, guarded against a cancelled reader. */
interface ByteSink {
  readonly stream: ReadableStream<Uint8Array>;
  write(text: string): void;
  close(): void;
  error(reason: unknown): void;
}

function byteSink(): ByteSink {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let done = false;
  let wroteAny = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // A consumer that stops reading must not turn the next log line into a
      // throw inside the SSE handler.
      done = true;
    },
  });

  return {
    stream,
    write(text) {
      if (done) return;
      // Same separator rule as `joinOutput`: OpenSandbox strips the newline from
      // every message, so it is re-inserted BEFORE each line after the first.
      // Appending one after each line instead would put a trailing byte on the
      // stream that the command never wrote, and `run()` and `spawn()` have to
      // hand back the same bytes for the same command.
      controller?.enqueue(encoder.encode(wroteAny ? `\n${text}` : text));
      wroteAny = true;
    },
    close() {
      if (done) return;
      done = true;
      controller?.close();
    },
    error(reason) {
      if (done) return;
      done = true;
      controller?.error(reason);
    },
  };
}

function wrapSession(sandbox: Sandbox): SandboxSessionLike {
  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    try {
      const bytes = await sandbox.files.readBytes(path);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
    } catch (error) {
      // eve's read surface resolves to null for a file that does not exist, on
      // every backend, so authored code can branch on it instead of catching.
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const write = async (path: string, data: string | Uint8Array): Promise<void> => {
    await sandbox.files.writeFiles([{ path, data }]);
  };

  const statPath = async (path: string): Promise<FileInfo | null> => {
    try {
      const info = await sandbox.files.getFileInfo([path]);
      // The map is keyed by path, but whether the server echoes the key exactly
      // (trailing slash, symlink resolution) was not exercised against a live
      // server — and exactly one path was asked for, so the single value is the
      // answer either way.
      return info[path] ?? Object.values(info)[0] ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const runOptions = (options: SandboxRunOptions) => ({
    workingDirectory: options.workingDirectory ? resolvePath(options.workingDirectory) : WORKSPACE,
    ...(options.env ? { envs: options.env } : {}),
  });

  return {
    id: String(sandbox.id),
    resolvePath,

    async run(options) {
      options.abortSignal?.throwIfAborted();
      const execution = await sandbox.commands.run(
        options.command,
        runOptions(options),
        undefined,
        options.abortSignal,
      );
      return {
        stdout: joinOutput(execution.logs?.stdout),
        stderr: joinOutput(execution.logs?.stderr),
        exitCode: exitCodeOf(execution),
      };
    },

    /**
     * eve requires `spawn` and this backend shipped without it, so every
     * documented long-running-process call was a TypeError.
     *
     * OpenSandbox has no detached-process handle with independent streams, but it
     * does stream: `commands.run` delivers stdout and stderr to handlers as the
     * server sends them. So the process handle is that stream pair plus the
     * command promise, with `skipAccumulation` so a long-running process does not
     * also buffer its whole output in the SDK — the streams are the output. Shape
     * mirrors eve's own `adaptMultiplexedCommandToSandboxProcess`.
     *
     * `kill()` is the part that did not work. It called `AbortController.abort()`
     * and nothing else, which closes OUR SSE connection to execd; whether execd
     * then reaps the command is a server-side detail the SDK does not promise,
     * and the SDK ships a separate termination API precisely because hanging up
     * is not a kill. Measured against the previous build with a stubbed SDK:
     * `kill()` made zero further calls to the sandbox, and `wait()` afterwards
     * rejected with `AbortError` rather than reporting a terminated process.
     *
     * So the process is now killed from inside the sandbox, by pid, the same way
     * eve's own `docker()` backend does it (`DOCKER_KILL_TREE_SCRIPT`): the
     * command is wrapped to record its pid, and `kill()` runs a second command
     * that walks /proc and SIGKILLs that pid and every descendant. See
     * `spawnWrapperCommand` / `killProcessTreeCommand` in translate.ts.
     *
     * Not `commands.interrupt()`, which is the SDK's own termination call, on
     * purpose: it is `DELETE /command?id=<sessionId>` and its OpenAPI parameter
     * is documented as the "Session ID of the execution context" — a bash
     * session from `createSession()`, which this backend does not use. Whether a
     * server accepts an id from a plain `POST /command` there is untested and
     * unstated, and a termination call aimed at the wrong id is a kill that
     * silently does nothing. Killing by pid needs nothing from the server beyond
     * running a command, which is the one thing already verified to work.
     */
    async spawn(options) {
      options.abortSignal?.throwIfAborted();

      const stdout = byteSink();
      const stderr = byteSink();
      const pidFile = spawnPidFilePath(randomUUID());
      const killTree = async (): Promise<void> => {
        await sandbox.commands.run(killProcessTreeCommand(pidFile), {
          workingDirectory: WORKSPACE,
        });
      };

      // `kill()` has to work without a caller-supplied signal, and an external
      // abort has to reach the same place, so both funnel through one controller.
      const controller = new AbortController();
      options.abortSignal?.addEventListener(
        "abort",
        () => {
          // eve documents an aborted signal as killing the running process, and
          // does exactly this in its docker backend: fire-and-forget, because an
          // abort handler has nowhere to report to.
          void killTree().catch(() => undefined);
          controller.abort(options.abortSignal?.reason);
        },
        { once: true },
      );

      // Set by kill() BEFORE IT AWAITS ANYTHING, so the rejection handler below
      // can tell "we terminated this on purpose" from "the stream broke".
      //
      // "Before it aborts" is what the previous version said and it was not
      // enough — see the ordering bug called out in kill() at the bottom of this
      // method.
      // A count, not a flag. Two concurrent kill() calls where the first
      // succeeds and the second fails would, with a boolean, have the failing
      // one set it back to false underneath the succeeding one — reviving the
      // exact bug the intent-before-await ordering below exists to fix. No
      // in-repo caller kills concurrently, so this is closing the door rather
      // than reporting a fire, but the whole point of the flag is that it
      // survives a race.
      let killIntents = 0;

      const execution = sandbox.commands.run(
        spawnWrapperCommand(options.command, pidFile),
        runOptions(options),
        {
          skipAccumulation: true,
          onStdout: (message) => stdout.write(message.text),
          onStderr: (message) => stderr.write(message.text),
        },
        controller.signal,
      );

      const finished = execution.then(
        (result) => {
          stdout.close();
          stderr.close();
          return { exitCode: exitCodeOf(result) };
        },
        (error: unknown) => {
          if (killIntents > 0) {
            // The process is already dead inside the sandbox; this rejection is
            // just our own abort landing afterwards. eve's contract for `wait()`
            // is that it RESOLVES with the process's exit code (only the
            // abortSignal path is documented as rejecting), and reporting a
            // termination is the whole point of the fix above — so the streams
            // end cleanly and the code says killed, never 0.
            stdout.close();
            stderr.close();
            return { exitCode: KILLED_EXIT_CODE };
          }
          // A reader blocked on stdout must fail rather than hang, and eve
          // documents `wait()` rejecting with the abort reason.
          stdout.error(error);
          stderr.error(error);
          throw error;
        },
      );
      // Nobody is obliged to call wait(), and an uncalled rejection would take
      // the process down.
      finished.catch(() => undefined);

      return {
        stdout: stdout.stream,
        stderr: stderr.stream,
        wait: () => finished,
        kill: async () => {
          // The intent is recorded BEFORE the round trip, and that ordering is
          // the whole point.
          //
          // The previous version was `await killTree(); killedByCaller = true;`
          // (src/index.ts:561-562 before this change), which left the flag false
          // for the entire duration of the kill request — and that window is
          // exactly when the target's SSE stream dies, because the kill it is
          // waiting on is what kills the process. `killTree()` returns only
          // after the server has answered, and the server kills the process
          // before it answers. So `finished` took the "the stream broke
          // unexpectedly" branch below for a kill that WORKED: it errored both
          // byte sinks and rethrew, and `wait()` rejected. Reproduced against
          // that build with a stubbed SDK whose kill command ends the spawned
          // command's stream before its own response lands:
          //   wait() REJECTED: Error: stream closed: process terminated
          //   stdout stream ERRORED: Error: stream closed: process terminated
          // README.md meanwhile stated the opposite as fact ("`wait()` after a
          // successful `kill()` resolves with `137`").
          killIntents += 1;
          try {
            // Let a failure propagate. If the kill request never reached the
            // sandbox the process may still be running, and reporting a
            // successful kill there is the bug this method already had. Nothing
            // is aborted on that path either: our stream is the only remaining
            // way to observe a process we failed to stop — which is also why
            // this intent is withdrawn. A stream that breaks after a kill we know
            // did not land is not explained by that kill, and answering 137 for
            // it would be the same lie in a different place. (If the stream had
            // already broken while the request was in flight, `finished` has
            // settled as killed and this cannot un-settle it: the request went
            // out and the stream died with it, so "killed" is the better of the
            // two available answers, and kill() still throws so the caller is
            // told the acknowledgement never came.)
            await killTree();
          } catch (error) {
            killIntents -= 1;
            throw error;
          }
          controller.abort();
          await finished.catch(() => undefined);
        },
      };
    },

    /**
     * eve requires `setNetworkPolicy` and this backend shipped without it, so a
     * mid-turn policy change was a TypeError instead of the documented
     * per-backend rejection.
     *
     * It rejects, in the shape eve's own just-bash backend uses, because
     * OpenSandbox cannot honour this call at run time and half-honouring it is
     * the one outcome worse than refusing. Every eve policy carries a default
     * action — `"deny-all"`, or an allow-list, which denies everything it does
     * not name — and OpenSandbox fixes `defaultAction` when the sandbox is
     * created: the run-time egress API is `patchEgressRules` / `deleteEgressRules`
     * and its own docs say "the current defaultAction is preserved". Patching the
     * allow-list onto a sandbox whose default is still allow would report success
     * having restricted nothing, on the one call whose entire purpose is to
     * restrict. Per-domain `transform` header injection is not expressible either
     * — that is OpenSandbox's Credential Vault, a different model with its own
     * bindings.
     */
    async setNetworkPolicy(_policy) {
      throw new Error(
        `setNetworkPolicy() is not supported on the opensandbox sandbox backend. Every eve network ` +
          `policy implies a default action, and OpenSandbox fixes a sandbox's defaultAction at ` +
          `creation: its run-time egress API can only add or remove per-domain rules and preserves ` +
          `the existing default, so applying an allow-list here would leave egress open while ` +
          `reporting success. A policy fixed for the sandbox's life is supported — pass it as ` +
          `opensandbox({ networkPolicy }); for a policy that changes during a turn use vercel() or ` +
          `microsandbox(), and for coarse egress control use docker().`,
      );
    },

    /**
     * eve requires `removePath` and this backend shipped without it, so a tool
     * deleting a sandbox file got "session.removePath is not a function".
     */
    async removePath({ path, force, recursive, abortSignal }) {
      abortSignal?.throwIfAborted();
      const resolved = resolvePath(path);
      const info = await statPath(resolved);

      if (info === null) {
        if (force) return;
        throw new Error(
          `removePath: ${resolved} does not exist. Pass force: true to ignore a missing path.`,
        );
      }

      if (info.type === "directory") {
        if (!recursive) {
          // `deleteDirectories` has no non-recursive mode, and eve's contract is
          // that `recursive` is what PERMITS removing a non-empty directory. So
          // the emptiness check has to happen here or a plain
          // `removePath({ path })` would silently delete a whole tree. The exact
          // `listDirectory` payload was not exercised against a live server,
          // hence the defensive filter: the directory itself must not count as
          // its own child under either convention.
          const entries = await sandbox.files.listDirectory({ path: resolved, depth: 1 });
          const children = entries.filter(
            (entry) => entry.path !== resolved && entry.path !== `${resolved}/` && entry.path !== ".",
          );
          if (children.length > 0) {
            throw new Error(
              `removePath: ${resolved} is a directory with ${children.length} entr` +
                `${children.length === 1 ? "y" : "ies"}. Pass recursive: true to remove it.`,
            );
          }
        }
        await sandbox.files.deleteDirectories([resolved]);
        return;
      }

      await sandbox.files.deleteFiles([resolved]);
    },

    /**
     * The byte-stream read, which 0.2.0 typed and implemented as returning bytes.
     * eve's contract is a `ReadableStream` — the point of this method is not
     * materializing a large file — so it streams, and peeks one chunk first
     * because "does it exist" has to be answered before the promise resolves.
     */
    async readFile(options) {
      options.abortSignal?.throwIfAborted();
      let iterator: AsyncIterator<Uint8Array>;
      let first: IteratorResult<Uint8Array>;
      try {
        // Inside the try because `readBytesStream` returning an AsyncIterable
        // rather than a promise means it is free to reject on the first `next()`
        // OR to throw where it is called, and a missing file has to answer null
        // either way.
        iterator = sandbox.files.readBytesStream(resolvePath(options.path))[Symbol.asyncIterator]();
        first = await iterator.next();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }

      return new ReadableStream<Uint8Array>({
        start(controller) {
          // An existing but empty file ends here with no chunk, which is not the
          // same as a missing one: that arrives as a 404 from the peek above.
          if (first.done) controller.close();
          else controller.enqueue(first.value);
        },
        async pull(controller) {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel(reason) {
          await iterator.return?.(reason);
        },
      });
    },

    async readBinaryFile(options) {
      options.abortSignal?.throwIfAborted();
      return readBytes(resolvePath(options.path));
    },

    async readTextFile(options) {
      options.abortSignal?.throwIfAborted();
      validateReadTextFileOptions(options);
      const bytes = await readBytes(resolvePath(options.path));
      if (bytes === null) return null;
      return applyLineRange(decodeBytes(bytes, options.encoding ?? "utf-8"), options);
    },

    async writeFile(options) {
      options.abortSignal?.throwIfAborted();
      // `WriteEntry.data` takes a ReadableStream directly, so a stream write
      // stays a stream write instead of being buffered on the way through.
      await sandbox.files.writeFiles([
        { path: resolvePath(options.path), data: options.content },
      ]);
    },

    async writeBinaryFile(options) {
      options.abortSignal?.throwIfAborted();
      await write(resolvePath(options.path), options.content);
    },

    async writeTextFile(options) {
      options.abortSignal?.throwIfAborted();
      await write(resolvePath(options.path), encodeString(options.content, options.encoding ?? "utf-8"));
    },
  };
}

/**
 * Every option this backend reads. Anything else is rejected at construction —
 * see `assertKnownOptions`.
 */
const KNOWN_OPTION_KEYS: ReadonlyArray<keyof OpenSandboxOptions> = [
  "image",
  "domain",
  "apiKey",
  "timeoutSeconds",
  "networkPolicy",
];

/**
 * Refuses an option this backend does not implement, instead of ignoring it.
 *
 * TypeScript's excess-property check already catches `opensandbox({ typo: 1 })`
 * written as a literal, and catches nothing else: a JavaScript caller, a spread
 * (`opensandbox({ ...config })`), or a config loaded from JSON all reach here
 * unchecked. That is fine for a misspelt `image`, which fails loudly on the
 * next line, and it is not fine for a misspelt network policy —
 * `opensandbox({ initialNetworkPolicy: "deny-all" })` used to build a sandbox
 * with wide-open egress and say nothing at all. Verified against the previous
 * build: the option went in and `Sandbox.create` was called with
 * `{"image":"ubuntu"}`.
 *
 * The correct name is called out by name because that is the mistake worth
 * catching: getting a locked-down network wrong in the silent direction is the
 * one failure the caller cannot detect from the outside.
 */
function assertKnownOptions(options: OpenSandboxOptions): void {
  const unknown = Object.keys(options).filter(
    (key) => !(KNOWN_OPTION_KEYS as ReadonlyArray<string>).includes(key),
  );
  if (unknown.length === 0) return;
  const networkish = unknown.filter((key) => /network|egress|firewall/i.test(key));
  throw new Error(
    `opensandbox() was given ${unknown.length} option${unknown.length === 1 ? "" : "s"} it does not ` +
      `implement: ${unknown.map((key) => `\`${key}\``).join(", ")}. Supported options are ` +
      `${KNOWN_OPTION_KEYS.map((key) => `\`${key}\``).join(", ")}.` +
      (networkish.length > 0
        ? ` The egress policy option is named \`networkPolicy\`, and it is rejected rather than ignored ` +
          `because a sandbox that was asked for a restricted network and silently got an open one cannot ` +
          `be told apart from one that was never asked.`
        : ""),
  );
}

export function opensandbox(options: OpenSandboxOptions = {}): SandboxBackendLike {
  assertKnownOptions(options);

  // Translated once, here, so an unrepresentable policy fails when the backend
  // is constructed — at `eve build`, in the operator's face — rather than on the
  // first turn that happens to need a sandbox.
  const networkPolicy: OpenSandboxNetworkPolicy | undefined =
    options.networkPolicy === undefined
      ? undefined
      : toOpenSandboxNetworkPolicy(options.networkPolicy);
  const policyKey = networkPolicyKey(networkPolicy);

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
    name: BACKEND_NAME,

    async create({ existingMetadata, sessionKey, templateKey }) {
      // Before anything is provisioned, because the alternative is what 0.2.0
      // did: build a bare sandbox and hand it over as though the template had
      // been applied. eve passes a non-null templateKey only when the sandbox
      // declares a bootstrap() hook or seed files ("null means eve intentionally
      // skipped template prewarm because the sandbox has no bootstrap() and no
      // seed files" — eve's SandboxBackendCreateInput), so this is exactly the
      // case this backend cannot serve.
      if (templateKey !== null) {
        throw new TemplateNotProvisioned({ backendName: BACKEND_NAME, templateKey });
      }

      const previousId = existingMetadata?.sandboxId;

      // What this session's sandbox was created under. A session persisted
      // before this option existed has no key and reads as "unset", which is
      // also what a backend with no networkPolicy records — see
      // `sameNetworkPolicyKey`, which is what decides whether two of these are
      // the same egress.
      const previousPolicyKey =
        typeof existingMetadata?.networkPolicyKey === "string"
          ? existingMetadata.networkPolicyKey
          : "unset";

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

        // The egress check happens HERE, after the ladder, and only for a
        // sandbox that was actually recovered.
        //
        // A sandbox's egress is fixed when it is created (see `networkPolicy` on
        // OpenSandboxOptions), so handing back one created under a different
        // policy would run the agent under the OLD rules while the operator
        // reads the new ones in their source. That is the same class of silent
        // divergence as the reconnect bug above, pointed at the network instead
        // of the filesystem, so it refuses rather than guessing.
        //
        // It used to refuse BEFORE the ladder ran (src/index.ts:810-826 before
        // this change), on the strength of a persisted id alone, and that turned
        // a recoverable state into a dead session: if the sandbox had been
        // reaped upstream there was nothing to diverge from, nothing to protect,
        // and no sandbox — yet create() threw on every turn, for good, because
        // the metadata that triggered it is the metadata eve keeps handing back.
        // Reproduced against that build with a stubbed SDK whose connect/resume
        // both 404: `create() THREW ... Sandbox.create calls: 0`. The fresh
        // sandbox it refused to build would have been created under the NEW
        // policy, which is what the operator asked for.
        if (sandbox !== null && !sameNetworkPolicyKey(previousPolicyKey, policyKey)) {
          // Put it back the way shutdown() would leave it. We may have just
          // woken it with resume(), and no turn is going to use it now, so
          // resuming and then walking away is a running sandbox nobody owns.
          await sandbox.pause().catch(() => undefined);
          throw new Error(
            `Sandbox "${previousId}" for session "${sessionKey}" was created with network policy ` +
              `[${previousPolicyKey}], and opensandbox() now asks for [${policyKey}]. OpenSandbox fixes a ` +
              `sandbox's egress default action at creation and its run-time egress API preserves it, so ` +
              `this sandbox cannot be changed to match — reattaching would run the agent under the old ` +
              `policy while your source says otherwise. Start a new session to get a sandbox under the new ` +
              `policy, or restore the previous networkPolicy to keep using this one.`,
          );
        }
      }

      sandbox ??= await Sandbox.create({
        image: options.image ?? "ubuntu",
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(connectionConfig ? { connectionConfig } : {}),
        // Creation is the only point at which OpenSandbox accepts one, and it is
        // spread rather than always passed so a backend with no policy keeps
        // sending exactly the request it sent before.
        ...(networkPolicy ? { networkPolicy } : {}),
      });

      const live = sandbox;
      await live.files.createDirectories([{ path: WORKSPACE }]);
      const session = wrapSession(live);

      return {
        session,
        // Async because eve's `SandboxSessionUseFn` returns a Promise, which its
        // own docker backend honours and this did not.
        useSessionFn: async () => session,
        captureState: async () => ({
          backendName: BACKEND_NAME,
          // The id is the whole reconnect story; without persisting it every
          // restart would orphan a running sandbox and start a fresh one. The
          // policy key rides along because a sandbox's egress cannot be changed
          // after creation, so the reattach above has to know what this one was
          // created under before it hands it back.
          metadata: { sandboxId: String(live.id), networkPolicyKey: policyKey },
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

    async prewarm({ templateKey, bootstrap, seedFiles, log }) {
      // This used to destructure `log` alone and report `reused: false`, which
      // read as "you will pay a cold start" and actually meant "your bootstrap()
      // and your seed files have been dropped on the floor". OpenSandbox has
      // snapshots (createSnapshot / listSnapshots, and `snapshotId` on create),
      // so capturing template state is buildable here — it is not built, so the
      // log has to say what was lost by name, and create() refuses the session
      // rather than starting it bare.
      const ignored = [
        bootstrap ? "a bootstrap() hook" : null,
        seedFiles.length > 0
          ? `${seedFiles.length} seed file${seedFiles.length === 1 ? "" : "s"}`
          : null,
      ].filter((part): part is string => part !== null);

      log?.(
        `[opensandbox] cannot capture template "${templateKey}": this backend does not implement ` +
          `OpenSandbox snapshots, so ${ignored.join(" and ") || "the requested template state"} ` +
          `will NOT be applied. Sessions for this sandbox will be refused with ` +
          `SandboxTemplateNotProvisionedError rather than started from a bare image. Remove the ` +
          `bootstrap()/seedFiles, or use docker() / vercel().`,
      );
      // `reused: false` is the less wrong of the two values eve's result type
      // offers — it means "captured fresh template state", and nothing was
      // captured. The log line above is the honest part; there is no third value
      // for "cannot".
      return { reused: false };
    },
  };
}
