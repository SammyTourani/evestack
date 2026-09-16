import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTarget } from './npm-release.mjs';
import { readFileSync } from 'node:fs';

test('release tags resolve manifest names and enforce exact versions', () => {
  const pkg = JSON.parse(readFileSync('packages/evestack-cli/package.json'));
  const result = releaseTarget(`${pkg.name}@${pkg.version}`);
  assert.equal(result.directory, 'packages/evestack-cli');
  assert.ok(result.required['create-evestack']);
  assert.throws(() => releaseTarget(`${pkg.name}@999.0.0`), /differs/);
});
test('reject private packages, malformed versions and shell payloads', () => {
  for (const tag of ['@evestack/dashboard@0.4.0', 'missing@1.0.0', 'evestack@1.0.0;echo bad', 'evestack@01.0.0', 'evestack@1.0.0-beta.1', '../evestack@1.0.0']) {
    assert.throws(() => releaseTarget(tag));
  }
});
test('scaffolder release requires every shipped workspace library', () => {
  const pkg = JSON.parse(readFileSync('packages/create-evestack/package.json'));
  assert.deepEqual(Object.keys(releaseTarget(`${pkg.name}@${pkg.version}`).required).sort(), ['@evestack/budget', '@evestack/composio', '@evestack/schedules']);
});
