import type { Readable, Writable } from "node:stream";

/**
 * MCP's stdio transport: one JSON message per line on stdin/stdout, UTF-8.
 *
 * Two rules from the transport spec that are easy to get wrong and impossible
 * to debug afterwards:
 *
 *  1. **Messages must not contain embedded newlines.** `JSON.stringify` escapes
 *     them inside strings, so a single `stringify` + "\n" is safe — but only if
 *     nothing else ever writes to fd 1.
 *  2. **stdout belongs to the protocol.** A stray `console.log` anywhere in this
 *     process corrupts the stream and the client reports a parse error with no
 *     hint where it came from. Everything human-facing goes to stderr, which the
 *     spec explicitly reserves for logging.
 */

/** Refuse a line longer than this rather than growing the buffer without bound. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface StdioTransport {
  /** Resolves when the input stream ends. */
  readonly closed: Promise<void>;
  send(message: unknown): void;
}

export function createStdioTransport(
  input: Readable,
  output: Writable,
  handlers: {
    onLine(line: string): void;
    onOverflow(bytes: number): void;
  },
): StdioTransport {
  let buffered = "";
  input.setEncoding("utf8");

  input.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      // Tolerate CRLF: a Windows client, or a shell pipeline in between, can
      // leave the carriage return attached and JSON.parse will not eat it.
      const line = buffered.slice(0, newline).replace(/\r$/, "").trim();
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) handlers.onLine(line);
      newline = buffered.indexOf("\n");
    }
    if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
      const bytes = Buffer.byteLength(buffered, "utf8");
      buffered = "";
      handlers.onOverflow(bytes);
    }
  });

  const closed = new Promise<void>((resolve) => {
    input.once("end", () => resolve());
    input.once("close", () => resolve());
  });

  return {
    closed,
    send(message: unknown): void {
      output.write(`${JSON.stringify(message)}\n`);
    },
  };
}

/** The only place in this package allowed to produce human-readable output. */
export function log(message: string): void {
  process.stderr.write(`[evestack-mcp] ${message}\n`);
}
