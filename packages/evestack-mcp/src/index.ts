#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { PARSE_ERROR, RpcError, failure, parseRequest, result } from "./jsonrpc.js";
import { McpServer } from "./server.js";
import { createStdioTransport, log } from "./stdio.js";

/**
 * `evestack-mcp` — evestack's control plane, spoken as MCP over stdio.
 *
 * Launched by an MCP client with no arguments; configuration is the environment
 * block in the client's config file. See README.md.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer(config);

  log(
    `serving ${server.advertisedTools.length} tools against ${config.dashboardUrl} ` +
      `(control ${config.allowControl ? "ENABLED" : "disabled — read-only"})`,
  );

  const transport = createStdioTransport(process.stdin, process.stdout, {
    onLine(line) {
      // Not awaited: a slow tool call must not block the next message off the
      // wire. JSON-RPC ids exist precisely so responses may come back out of
      // order, and a client that pipelines two calls would otherwise deadlock
      // behind the first one's HTTP round trip.
      void dispatch(line);
    },
    onOverflow(bytes) {
      log(`discarded ${bytes} bytes of input with no newline — the peer is not speaking line-delimited JSON.`);
    },
  });

  async function dispatch(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      transport.send(failure(null, { code: PARSE_ERROR, message: "Invalid JSON." }));
      return;
    }

    const envelope = parseRequest(parsed);
    if ("error" in envelope) {
      // A malformed *notification* is unanswerable — there is no id to answer
      // at, and inventing `id: null` would look like a response to a request the
      // client never made. Anything that is not a plain object without an `id`
      // still gets answered at `id: null`, which is what JSON-RPC prescribes for
      // an invalid Request: an array (the batch form MCP forbids) is not a
      // notification and swallowing it would leave the peer waiting forever.
      if (looksLikeNotification(parsed)) return;
      transport.send(failure(envelope.id, envelope.error));
      return;
    }

    const request = envelope.request;
    try {
      const outcome = await server.handle(request);
      if (request.id !== undefined) transport.send(result(request.id, outcome.response ?? {}));
    } catch (error) {
      if (request.id === undefined) return;
      const rpcError =
        error instanceof RpcError
          ? error.toErrorObject()
          : { code: -32603, message: "Internal error." };
      if (!(error instanceof RpcError)) {
        log(`unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      transport.send(failure(request.id, rpcError));
    }
  }

  await transport.closed;
  log("stdin closed, exiting.");
}

function looksLikeNotification(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !("id" in (value as Record<string, unknown>))
  );
}

main().catch((error: unknown) => {
  // A config error has to be visible: the client shows the user a server that
  // died, and stderr is the only place the reason can appear.
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
