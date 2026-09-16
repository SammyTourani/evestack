import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNegativeControl } from './check-negative-control.mjs';

function evidence() {
  return { results: [{ id: 'deny-survives', verdict: 'failed',
    error: 'respondAll() requires at least one pending input request.',
    assertions: [{ name: 'parked', passed: false, score: 0,
      message: 'expected the run to park on HITL input; it ended "waiting" with no pending requests' }],
    result: { status: 'waiting', events: [], derived: {
      toolCalls: [{ name: 'forget', status: 'completed', turnIndex: 0 }],
    } },
  }] };
}

test('accepts an executed ungated tool and the corresponding failed approval assertion', () => {
  assert.doesNotThrow(() => checkNegativeControl(evidence(), 1));
});
test('rejects success, CLI errors, empty selections, and a model that never called forget', () => {
  for (const exit of [0, 2, 137]) assert.throws(() => checkNegativeControl(evidence(), exit));
  assert.throws(() => checkNegativeControl({ results: [] }, 1));
  const report = evidence();
  report.results[0].result.derived.toolCalls = [];
  assert.throws(() => checkNegativeControl(report, 1), /inconclusive/);
});
test('rejects provider errors and approval assertions that did not fail for missing input', () => {
  const report = evidence();
  report.results[0].error = '401 unauthorized';
  assert.throws(() => checkNegativeControl(report, 1), /unrelated/);
  delete report.results[0].error;
  report.results[0].result.events.push({ type: 'turn.failed' });
  assert.throws(() => checkNegativeControl(report, 1), /agent failed/);
  report.results[0].result.events = [];
  report.results[0].assertions[0].passed = true;
  assert.throws(() => checkNegativeControl(report, 1), /inconclusive/);
});
