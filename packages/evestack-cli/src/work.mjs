import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import {
  findProjectEnv,
  notAProject,
  projectEnv,
  wantsHelp,
} from "./project.mjs";

const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_MESSAGE = 64 * 1024;
const line = (value) =>
  String(value ?? "unknown")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 500);

export class WorkApiError extends Error {
  constructor(message, delivery = "not_sent") {
    super(message);
    this.delivery = delivery;
  }
}

export function dashboardSettings(value) {
  const raw =
    value("EVESTACK_PUBLIC_URL") ||
    value("EVESTACK_DASHBOARD_URL") ||
    "http://127.0.0.1:4000";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkApiError(
      "The dashboard URL is invalid. Check EVESTACK_PUBLIC_URL or EVESTACK_DASHBOARD_URL.",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new WorkApiError(
      "The dashboard URL must be http(s) without embedded credentials.",
    );
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "http:" && !loopback)
    throw new WorkApiError(
      "Use HTTPS for a remote dashboard before sending its credentials. Loopback HTTP is supported.",
    );
  const user = value("EVESTACK_AUTH_USER") || "evestack",
    password = value("EVESTACK_AUTH_PASSWORD");
  if (!password || user.includes(":"))
    throw new WorkApiError(
      "Configure the installation's dashboard username and password in the project environment.",
    );
  return {
    base: url.origin,
    password,
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
  };
}

export function routeSegment(id) {
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 300 ||
    /[\x00-\x1f\x7f]/.test(id)
  )
    throw new WorkApiError("Use a valid task or routine id from the list.");
  const encoded = encodeURIComponent(id),
    probe = `/a/${encoded}/b`;
  if (new URL(probe, "https://route.invalid").pathname !== probe)
    throw new WorkApiError(
      "The id would change the API route. Use an id from the list.",
    );
  return encoded;
}

export async function dashboardRequest(
  settings,
  path,
  { method = "GET", body, timeoutMs = 15000 } = {},
) {
  const target = new URL(path, settings.base);
  if (target.origin !== settings.base || !target.pathname.startsWith("/api/"))
    throw new WorkApiError(
      "Only this dashboard’s API can receive installation credentials.",
    );
  const uncertain = method === "GET" ? "not_sent" : "unknown";
  const sanitize = (text) =>
    String(text)
      .replaceAll(settings.authorization, "[redacted]")
      .replaceAll(settings.password, "[redacted]")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .slice(0, 600);
  let response;
  try {
    response = await fetch(target, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: settings.authorization,
        accept: "application/json",
        "content-type": "application/json",
        origin: settings.base,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 300 && response.status < 400)
      throw new WorkApiError(
        "The dashboard redirected the request. Check its configured URL; credentials were not forwarded.",
        uncertain,
      );
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE)
      throw new WorkApiError(
        "Dashboard response exceeds the 2 MiB read limit.",
        uncertain,
      );
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE) {
          await reader.cancel();
          throw new WorkApiError(
            "Dashboard response exceeds the 2 MiB read limit.",
            uncertain,
          );
        }
        chunks.push(Buffer.from(part.value));
      }
    }
    let result;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new WorkApiError(
        "The dashboard returned an unreadable response. Check that the URL points to this version of Eve Stack.",
        uncertain,
      );
    }
    if (!response.ok || result?.ok !== true) {
      const delivery = result?.startedSessionId
        ? "unknown"
        : response.status >= 400 && response.status < 500
          ? "rejected"
          : uncertain;
      throw new WorkApiError(
        `Dashboard HTTP ${response.status}: ${sanitize(result?.error ?? "the request was not accepted")}`,
        delivery,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof WorkApiError) throw error;
    throw new WorkApiError(
      method === "GET"
        ? "The dashboard could not be read. Check its URL, credentials and service status."
        : "The task response was not received. Delivery is unknown; inspect Tasks before trying again.",
      uncertain,
    );
  } finally {
    try {
      await response?.body?.cancel();
    } catch {}
  }
}

function messageFile(path, cwd) {
  let fd;
  try {
    fd = openSync(
      resolve(cwd, path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_MESSAGE)
      throw new WorkApiError(
        "The message must be a regular text file no larger than 64 KiB.",
      );
    const buffer = Buffer.alloc(MAX_MESSAGE + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > MAX_MESSAGE)
      throw new WorkApiError("The message grew beyond 64 KiB.");
    const bytes = buffer.subarray(0, used);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new WorkApiError("The message file must be valid UTF-8.");
    }
    if (!text.trim()) throw new WorkApiError("The message file is empty.");
    return text;
  } catch (error) {
    if (error instanceof WorkApiError) throw error;
    throw new WorkApiError(
      "Could not read the message file. No request was sent.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const WORK_USAGE = `evestack tasks / routines / readiness — use the dashboard's authenticated API

  evestack tasks [--search=TEXT] [--limit=30] [--cursor=CURSOR] [--json]
  evestack tasks TASK_ID [--json]
  evestack tasks recovery TASK_ID [--json]
  evestack tasks start --message-file=PATH [--json]
  evestack tasks reply TASK_ID --message-file=PATH [--json]
  evestack tasks stop TASK_ID [--json]
  evestack routines [ROUTINE_ID] [--json]
  evestack readiness [--check=agent] [--json]

Lists and recovery are read-only. Start/reply can call models and tools; stop is a
cooperative cancellation request. These commands never retry a mutation or answer
approvals. Open the printed task link to inspect its live result and decisions.

Uses EVESTACK_PUBLIC_URL, then the origin of EVESTACK_DASHBOARD_URL, then loopback
port 4000, with the installation's EVESTACK_AUTH_USER/PASSWORD. Credentials are not
printed or sent through redirects. Remote dashboards require HTTPS. Message files
are limited to 64 KiB; replies are limited to 2 MiB. Use --json for coverage, saved
revisions, request status and opaque pagination cursors. Readiness reports checks;
a successful read does not certify that a model or source works.

Exit 0 means the API accepted the request/read, not that an agent task succeeded.
Exit 1 means refusal or uncertain delivery; exit 2 means no project was found.
`;

function parse(argv) {
  const result = {
    positionals: [],
    limit: 30,
    search: "",
    json: false,
    flags: new Set(),
  };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const flag = arg.split("=", 1)[0];
      if (result.flags.has(flag))
        throw new WorkApiError("Pass each option only once.");
      result.flags.add(flag);
    }
    if (arg === "--json") result.json = true;
    else if (arg.startsWith("--limit=")) result.limit = Number(arg.slice(8));
    else if (arg.startsWith("--search=")) result.search = arg.slice(9);
    else if (arg.startsWith("--cursor=")) result.cursor = arg.slice(9);
    else if (arg.startsWith("--message-file="))
      result.messageFile = arg.slice(15);
    else if (arg.startsWith("--check=")) result.check = arg.slice(8);
    else if (arg.startsWith("-"))
      throw new WorkApiError("Unknown work option. Run evestack tasks --help.");
    else result.positionals.push(arg);
  }
  if (
    !Number.isInteger(result.limit) ||
    result.limit < 1 ||
    result.limit > 100 ||
    result.search.length > 200 ||
    (result.cursor?.length ?? 0) > 1000
  )
    throw new WorkApiError(
      "Use a limit from 1 to 100, search up to 200 characters and the returned page cursor.",
    );
  return result;
}

async function run(
  kind,
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
  } = {},
) {
  if (wantsHelp(argv)) {
    stdout.write(WORK_USAGE);
    return 0;
  }
  let options = { json: argv.includes("--json") },
    settings;
  try {
    options = parse(argv);
    const found = findProjectEnv(cwd);
    if (!found) return notAProject(stderr);
    settings = dashboardSettings(projectEnv(found));
    const [action, id] = options.positionals;
    let path,
      body,
      method = "GET",
      view = kind;
    const allowed = new Set(["--json"]);
    if (kind === "tasks" && !action)
      for (const flag of ["--limit", "--search", "--cursor"]) allowed.add(flag);
    if (kind === "tasks" && ["start", "reply"].includes(action))
      allowed.add("--message-file");
    if (kind === "readiness") allowed.add("--check");
    if ([...options.flags].some((flag) => !allowed.has(flag)))
      throw new WorkApiError(
        "This option does not apply to the selected command. Run evestack tasks --help.",
      );
    if (kind === "tasks") {
      if (["start", "reply", "stop", "recovery"].includes(action)) {
        const count = action === "start" ? 1 : 2;
        if (options.positionals.length !== count)
          throw new WorkApiError(
            `Use evestack tasks ${action}${count === 2 ? " TASK_ID" : ""}.`,
          );
        if (action === "start" || action === "reply") {
          if (!options.messageFile)
            throw new WorkApiError(
              "Pass --message-file=PATH; no request was sent.",
            );
          body = { message: messageFile(options.messageFile, cwd) };
          method = "POST";
          path =
            action === "start"
              ? "/api/control/sessions"
              : `/api/control/sessions/${routeSegment(id)}/message`;
          view = "mutation";
        } else if (action === "stop") {
          method = "POST";
          body = {};
          path = `/api/control/sessions/${routeSegment(id)}/cancel`;
          view = "mutation";
        } else {
          path = `/api/tasks/${routeSegment(id)}/recovery`;
          view = "recovery";
        }
      } else if (action) {
        if (options.positionals.length !== 1)
          throw new WorkApiError(
            "Use one task id, or a documented task action.",
          );
        path = `/api/tasks/${routeSegment(action)}`;
        view = "task";
      } else {
        const params = new URLSearchParams({
          limit: String(options.limit),
          q: options.search,
        });
        if (options.cursor) params.set("cursor", options.cursor);
        path = "/api/tasks?" + params;
      }
    } else if (kind === "routines") {
      if (options.positionals.length > 1)
        throw new WorkApiError(
          "Use one routine id, or no id to list routines.",
        );
      path = action ? `/api/routines/${routeSegment(action)}` : "/api/routines";
      view = action ? "routine" : "routines";
    } else {
      if (options.positionals.length)
        throw new WorkApiError(
          "Use readiness --check=NAME to check one component.",
        );
      if (
        options.check &&
        ![
          "database",
          "agent",
          "model",
          "embeddings",
          "connections",
          "notifications",
        ].includes(options.check)
      )
        throw new WorkApiError("Unknown readiness check.");
      path =
        "/api/readiness" + (options.check ? "?check=" + options.check : "");
    }
    if (
      options.messageFile &&
      !(kind === "tasks" && ["start", "reply"].includes(action))
    )
      throw new WorkApiError(
        "--message-file is only valid for tasks start or reply.",
      );
    const result = await dashboardRequest(settings, path, {
      method,
      body,
      timeoutMs: method === "POST" ? 30000 : 15000,
    });
    if (
      view === "mutation" &&
      (!result.sessionId || typeof result.sessionId !== "string")
    )
      throw new WorkApiError(
        "The dashboard accepted a response without a task id. Check its version and inspect Tasks before retrying.",
        "unknown",
      );
    if (options.json) stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (view === "tasks") {
      if (!Array.isArray(result.tasks))
        throw new WorkApiError(
          "This dashboard did not return a task list. Check its version.",
        );
      for (const task of result.tasks)
        stdout.write(
          `${line(task.id)}  ${line(task.outcome)}  ${line(task.title ?? "Untitled task")}\n  ${settings.base}/chat?session=${encodeURIComponent(task.id)}\n`,
        );
      if (!result.tasks.length) stdout.write("No tasks matched this page.\n");
      if (result.nextCursor)
        stdout.write("Next cursor: " + line(result.nextCursor) + "\n");
    } else if (view === "task") {
      if (!result.task?.session)
        throw new WorkApiError(
          "This dashboard did not return task detail. Check its version.",
        );
      stdout.write(
        `${line(result.task.session.title ?? "Task")} (${line(result.task.session.id)})\nRuntime state: ${line(result.task.session.status)}\n${result.task.runs?.length ?? 0} recorded runs${result.task.runsTruncated ? " in the latest window; older runs omitted" : ""}\n${settings.base}/chat?session=${encodeURIComponent(result.task.session.id)}\n`,
      );
    } else if (view === "routines") {
      if (!Array.isArray(result.routines))
        throw new WorkApiError(
          "This dashboard did not return routines. Check its version.",
        );
      for (const routine of result.routines)
        stdout.write(
          `${line(routine.id)}  ${routine.enabled ? "enabled" : "paused"}  ${line(routine.name)}\n`,
        );
      stdout.write(`${settings.base}/routines\n`);
      stdout.write(
        `${result.routines.length} routines shown (dashboard limit: 200). Inspect the dashboard for clock and delivery state.\n`,
      );
    } else if (view === "readiness") {
      if (!Array.isArray(result.checks))
        throw new WorkApiError(
          "This dashboard did not return setup checks. Check its version.",
        );
      for (const check of result.checks)
        stdout.write(
          `${line(check.name)}: ${line(check.status)}\n  ${line(check.detail)}\n`,
        );
    } else if (view === "mutation") {
      const taskId = result.sessionId ?? id;
      stdout.write(
        `Request accepted${result.status ? ": " + line(result.status) : ""}. This does not confirm task completion or cancellation.\n`,
      );
      if (taskId)
        stdout.write(
          `${settings.base}/chat?session=${encodeURIComponent(taskId)}\n`,
        );
    } else stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (error) {
    const delivery =
      error instanceof WorkApiError ? error.delivery : "not_sent";
    const message =
      error instanceof Error
        ? error.message
        : "The operation could not be completed.";
    const suffix =
      delivery === "unknown"
        ? " Delivery is unknown. Inspect Tasks before retrying; this command did not retry."
        : "";
    if (options?.json)
      stdout.write(
        JSON.stringify({ ok: false, error: message + suffix, delivery }) + "\n",
      );
    else stderr.write(message + suffix + "\n");
    return 1;
  }
}
export const tasks = (argv, options) => run("tasks", argv, options);
export const routines = (argv, options) => run("routines", argv, options);
export const readiness = (argv, options) => run("readiness", argv, options);
