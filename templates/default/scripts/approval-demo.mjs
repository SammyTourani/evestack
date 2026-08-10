#!/usr/bin/env node
/**
 * `npm run demo:approval` - see a human-in-the-loop gate park and get answered,
 * on any model, including the free local one.
 *
 * WHY THIS EXISTS AS A COMMAND rather than a sentence in the docs.
 *
 * The dashboard tells a newcomer to try approvals with the `forget` tool, which
 * ships behind `approval: always()`. Nothing about that is broken: the gate
 * works, and `gen_ai.tool.definitions` on the model span proves the tool is
 * offered. But the gate can only fire if the MODEL decides to call the tool, and
 * on the $0 Ollama/qwen3 path this project also recommends, that decision is a
 * coin toss. Measured against qwen3 on this template, one sentence per session,
 * a cold session each time:
 *
 *   "Call the forget tool right now with id=1. Do not reply with text."
 *     8 attempts, 5 parked an approval, 3 answered in prose instead.
 *
 *   the same sentence with a reason supplied
 *     5 attempts, 5 parked.
 *
 * A 5-in-8 demo is not a demo. eve exposes no toolChoice, so nothing can force
 * the call; what can be made reliable is asking again. This does that, with the
 * wording that measured best first, and reports honestly when a model refuses
 * every time rather than leaving someone to conclude the gate is broken.
 *
 * It stops at the park. Answering happens in the dashboard on purpose: eve's
 * protocol carries no identity, so the dashboard is the only thing that records
 * WHO approved, and a script that answered the agent directly would leave the
 * Approvals page as empty as it found it.
 */
import {
  C,
  connectPostgres,
  dashboardTarget,
  envValue,
  findAgent,
  readEnvFile,
} from "./checks.mjs";

/** How many times to ask before reporting that the model will not do it. */
const ATTEMPTS = 3;

/** A local model on a laptop is slow, and a parked turn emits nothing while it
 *  waits. Long enough for the first token, not long enough to hang a terminal. */
const TURN_TIMEOUT_MS = 180_000;

const fileEnv = readEnvFile();
const env = (key) => envValue(fileEnv, key);

function fail(lines) {
  console.error(`\n${C.red}${C.bold}  Cannot run the approval demo.${C.reset}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error();
  process.exit(1);
}

/**
 * Which memory to aim at, and what deleting it would cost.
 *
 * The oldest real row, so approving does what the tool says on the tin. With no
 * memories yet, id 1 still parks: the gate is evaluated BEFORE execute, so a
 * missing row changes what approving DOES, not whether it asks. `forget` has a
 * branch for that and says so in its result.
 */
async function pickTarget() {
  const url = env("WORKFLOW_POSTGRES_URL");
  if (!url) return { id: 1, content: null };
  const probe = await connectPostgres(url, 4000);
  if (!probe.ok) return { id: 1, content: null };
  try {
    const rows = await probe.client.query(
      "SELECT id, content FROM evestack.memories ORDER BY id LIMIT 1",
    );
    if (rows.rowCount === 0) return { id: 1, content: null };
    return { id: Number(rows.rows[0].id), content: String(rows.rows[0].content) };
  } catch {
    // No memories table yet is the ordinary state of a project nobody has talked
    // to. It is not worth a failure: id 1 parks just as well.
    return { id: 1, content: null };
  } finally {
    await probe.client.end().catch(() => {});
  }
}

/**
 * The three sentences, most natural first, bluntest last.
 *
 * Every one supplies BOTH of the tool inputs. That is the whole finding: the
 * attempts that produced prose instead of a tool call were the ones where the
 * model had to invent the required `reason` itself.
 */
function prompts(id) {
  return [
    `Use the forget tool to delete memory id ${id}. Set reason to "trying the approval gate".`,
    `Call the forget tool now. id=${id}, reason="trying the approval gate". Reply with the tool call and nothing else.`,
    `You have a tool called forget. Call it with exactly {"id": ${id}, "reason": "trying the approval gate"}. Do not write any text.`,
  ];
}

/**
 * Drive one session and answer one question: did a tool-approval park?
 *
 * The stream is read from index 0 rather than the tail, because on a fast model
 * the whole turn can be over before this catches up, and a durable stream is
 * exactly the thing that does not need to be watched live to be read.
 */
async function attempt(base, message) {
  const created = await postJson(`${base}/eve/v1/session`, { message, mode: "conversation" });
  const sessionId = created.sessionId;
  if (!sessionId) throw new Error(`The agent accepted the session but named no session id.`);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  const state = { parked: null, said: "" };
  try {
    const stream = await fetch(`${base}/eve/v1/session/${sessionId}/stream?startIndex=0`, {
      signal: abort.signal,
    });
    for await (const event of ndjson(stream.body)) {
      if (event.type === "input.requested") {
        const request = (event.data?.requests ?? []).find((r) => r.kind === "tool-approval");
        if (request) state.parked = request;
      }
      if (event.type === "message.completed") state.said = String(event.data?.message ?? "");
      if (event.type === "turn.completed" || event.type === "turn.failed") break;
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return { ...state, sessionId };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** eve streams NDJSON, not SSE. One object per line, and the last line of a
 *  chunk is usually half of one. */
async function* ndjson(body) {
  const decoder = new TextDecoder();
  const state = { buffer: "" };
  for await (const chunk of body) {
    state.buffer += decoder.decode(chunk, { stream: true });
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // A line this cannot parse is not worth ending the demo over.
      }
    }
  }
}

const agent = await findAgent(env("EVESTACK_AGENT_URL"), env("EVESTACK_AGENT_PORT"));
if (!agent.health) {
  fail([
    `Nothing is answering at ${C.bold}${agent.url}${C.reset}.`,
    "",
    `Start it first: ${C.bold}npm run dev${C.reset}`,
  ]);
}

const target = await pickTarget();
const dashboard = dashboardTarget(env("EVESTACK_DASHBOARD_URL"));

console.log(`\n${C.bold}  Asking the agent to call a gated tool.${C.reset}\n`);
console.log(`  Tool     ${C.bold}forget${C.reset}, which ships behind approval: always().`);
if (target.content === null) {
  console.log(`  Target   memory ${target.id}, which does not exist yet, so approving deletes nothing.`);
} else {
  console.log(`  Target   memory ${target.id}: ${C.dim}${target.content.slice(0, 60)}${C.reset}`);
  console.log(`  ${C.dim}Approving really deletes it. That is the point of the gate.${C.reset}`);
}
console.log();

const messages = prompts(target.id);
const tried = [];
for (const [index, message] of messages.slice(0, ATTEMPTS).entries()) {
  process.stdout.write(`  ${C.dim}attempt ${index + 1} of ${Math.min(ATTEMPTS, messages.length)}...${C.reset}\r`);
  const result = await attempt(agent.url, message);
  tried.push(result);
  if (!result.parked) continue;

  const input = JSON.stringify(result.parked.action?.input ?? {});
  console.log(`  ${C.green}${C.bold}Parked.${C.reset} The turn is waiting on a human.          \n`);
  console.log(`  Tool       ${C.bold}${result.parked.action?.toolName}${C.reset} ${C.dim}${input}${C.reset}`);
  console.log(`  Session    ${C.bold}${result.sessionId}${C.reset}`);
  console.log();
  console.log(`  ${C.bold}Answer it here:${C.reset}`);
  console.log(`    ${dashboard.url}/chat?session=${result.sessionId}`);
  console.log();
  console.log(`  ${C.dim}Approve or deny there rather than from a script: eve carries no identity,${C.reset}`);
  console.log(`  ${C.dim}so the dashboard is the only thing that records who decided. The row${C.reset}`);
  console.log(`  ${C.dim}lands on ${dashboard.url}/approvals the moment you do.${C.reset}`);
  console.log();
  process.exit(0);
}

const model = env("EVESTACK_MODEL") ?? "the configured model";
console.error(`  ${C.yellow}${C.bold}The model would not call the tool.${C.reset}                    \n`);
console.error(`  Asked ${tried.length} times, in three wordings, and got prose back every time.`);
console.error(`  The last thing it said: ${C.dim}${(tried.at(-1)?.said ?? "").slice(0, 120)}${C.reset}`);
console.error();
console.error(`  ${C.bold}This is not a broken gate.${C.reset} The tool is offered on every one of those`);
console.error(`  turns, which you can see for yourself: open the trace for the last session`);
console.error(`  and read gen_ai.tool.definitions on the model call. forget is in the list.`);
console.error(`  ${model} simply chose not to use it.`);
console.error();
console.error(`  Sessions: ${tried.map((t) => t.sessionId).join(", ")}`);
console.error();
console.error(`  A larger model will do it first time. So will typing the same request`);
console.error(`  yourself in ${dashboard.url}/chat, which is worth one try before`);
console.error(`  changing anything.`);
console.error();
process.exit(1);
