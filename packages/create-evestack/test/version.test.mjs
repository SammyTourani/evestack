import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions } from "../attach.mjs";

/**
 * `create-evestack`'s test script was three `node --check` calls — syntax only.
 * That is how a comparator shipped returning "0.30.1-beta.1 is newer than
 * 0.30.2" and suppressed a security warning for every user on a 0.30.x
 * prerelease.
 *
 * The floor these versions are compared against is real: below eve 0.30.2,
 * `localDev()` matched an unanchored /^127\./ against the Host header, so
 * `127.evil.com` resolved to an unauthenticated principal. `attach` reads the
 * installed version verbatim out of node_modules/eve/package.json, which is
 * where prereleases come from.
 */

const MIN_EVE = "0.30.2";
const sign = (n) => Math.sign(n);

test("a prerelease sorts below the release it precedes", () => {
  // The exact regression: NaN from "1-beta" made this return 1.
  assert.equal(sign(compareVersions("0.30.1-beta.1", MIN_EVE)), -1);
  assert.equal(sign(compareVersions("0.30.2-beta.1", MIN_EVE)), -1);
  assert.equal(sign(compareVersions("0.30.2-rc.1", "0.30.2")), -1);
});

test("a release sorts above its own prereleases", () => {
  assert.equal(sign(compareVersions("0.30.2", "0.30.2-rc.1")), 1);
  assert.equal(sign(compareVersions("1.0.0", "1.0.0-alpha")), 1);
});

test("plain releases order numerically, not lexically", () => {
  assert.equal(sign(compareVersions("0.30.1", MIN_EVE)), -1);
  assert.equal(sign(compareVersions("0.30.3", MIN_EVE)), 1);
  assert.equal(sign(compareVersions("0.30.2", MIN_EVE)), 0);
  // "9" > "10" lexically; 9 < 10 numerically.
  assert.equal(sign(compareVersions("0.9.0", "0.10.0")), -1);
  assert.equal(sign(compareVersions("0.30.10", "0.30.9")), 1);
});

test("every prerelease below the floor is reported as below it", () => {
  for (const tag of ["alpha", "alpha.1", "beta.7", "rc.1", "canary.20260805"]) {
    assert.equal(
      sign(compareVersions(`0.30.1-${tag}`, MIN_EVE)),
      -1,
      `0.30.1-${tag} must warn`,
    );
  }
});

test("two prereleases of the same release order against each other", () => {
  assert.equal(sign(compareVersions("0.30.2-alpha", "0.30.2-beta")), -1);
  assert.equal(sign(compareVersions("0.30.2-beta", "0.30.2-alpha")), 1);
  assert.equal(sign(compareVersions("0.30.2-rc.1", "0.30.2-rc.1")), 0);
});

test("a leading v or range operator does not change the answer", () => {
  assert.equal(sign(compareVersions("v0.30.1", MIN_EVE)), -1);
  assert.equal(sign(compareVersions("^0.30.3", MIN_EVE)), 1);
});

test("unparseable input claims no ordering rather than guessing", () => {
  // The call site prints "could not read a version number out of that range"
  // for this case; returning 1 here would have silently skipped the warning.
  assert.equal(compareVersions("not-a-version", MIN_EVE), 0);
  assert.equal(compareVersions(undefined, MIN_EVE), 0);
  assert.equal(compareVersions(null, MIN_EVE), 0);
});
