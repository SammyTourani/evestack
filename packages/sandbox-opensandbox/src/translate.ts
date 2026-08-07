/**
 * The two pure translations between eve's conventions and OpenSandbox's wire
 * shapes: where a path lands, and how a command's output is reassembled.
 *
 * They live in their own module for one reason. Everything in index.ts needs a
 * live OpenSandbox server to run at all, so nothing there can be pinned by a
 * test; these two need nothing, and both shipped with a bug — `joinOutput`
 * first mashed multi-line stdout into one word, then over-corrected into
 * inventing a trailing newline. Both were module-private, which is precisely
 * why neither was ever caught by a test.
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
