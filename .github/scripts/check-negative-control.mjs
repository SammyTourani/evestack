import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A failed CLI command can mean a dead server, invalid credentials, or a model
// that never called the tool. None proves that removing approval broke the
// approval assertion. Read Eve's structured report and require that evidence.
export function checkNegativeControl(report, exitCode) {
  if (exitCode !== 1 || report.results?.length !== 1) {
    throw new Error('Expected one failed deny-survives evaluation.');
  }
  const run = report.results[0];
  if (run.id !== 'deny-survives' || run.verdict !== 'failed') {
    throw new Error('The sabotaged deny-survives eval did not fail.');
  }
  const expectedError = 'respondAll() requires at least one pending input request.';
  if (run.error && run.error !== expectedError) {
    throw new Error('Negative control failed with an unrelated execution error.');
  }
  if (run.result?.status === 'failed' || run.result?.events?.some(event =>
    event.type === 'session.failed' || event.type === 'turn.failed')) {
    throw new Error('The agent failed before the approval control was established.');
  }
  const missedApproval = run.assertions?.some(assertion =>
    assertion.name === 'parked' && assertion.passed === false && assertion.score === 0 &&
    assertion.message?.includes('with no pending requests'));
  const executedForget = run.result?.derived?.toolCalls?.some(call =>
    call.name === 'forget' && call.turnIndex === 0 &&
    (call.status === 'completed' || call.status === 'failed'));
  if (!missedApproval || !executedForget) {
    throw new Error('Control is inconclusive: require an executed forget call and a failed parked assertion.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkNegativeControl(JSON.parse(readFileSync(process.argv[2], 'utf8')), Number(process.argv[3]));
  console.log('Negative control verified: forget executed without approval and the parked assertion failed.');
}
