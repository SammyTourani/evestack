/**
 * The one failure of the dashboard step that leaves nothing to read.
 *
 * `docker compose --profile dashboard up -d --wait` failed with one message for
 * every cause: "did not start — `docker compose logs dashboard` has the reason".
 * That is true of a container that started and died. It is FALSE of a pull that
 * was refused, because a refused pull creates no container at all, so the
 * command it sends you to prints nothing and the actual error — one line from
 * the daemon — has already scrolled past.
 *
 * It is not a rare branch either. The tree pins a dashboard tag that is
 * published separately from this package, so a scaffold taken from a tree whose
 * tag has not been pushed yet gets exactly this: `manifest unknown`, then an
 * instruction that leads nowhere.
 *
 * The repository's own docker-compose.yml survives an unpublished tag by
 * carrying `build:` beside `image:`. A scaffolded project cannot copy that —
 * it ships no dashboard source and no Dockerfile — so the fix here is not a
 * build stanza but a legible failure, and the third option it offers is the
 * closest real equivalent: build it once in a clone, where the repository's
 * `build:` tags the result with the same name this project asks for.
 *
 * Everything below drives the real exported function against real daemon
 * output, and the second half is the half that matters: the other ways this
 * step fails must NOT get this explanation, because replacing a vague sentence
 * with a confidently wrong one is worse than leaving it alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dashboardPullFailure } from "../create.mjs";
import { DASHBOARD_IMAGE, REPO } from "../shared.mjs";

/* -------------------------------------------------------------------------- */
/* the refusals, in the registry's own words                                   */
/* -------------------------------------------------------------------------- */

/**
 * Real shapes, not invented ones. A registry refuses in more than one
 * vocabulary depending on whether the repository is absent, the tag is absent,
 * or the repository is private — and GHCR in particular answers an anonymous
 * request for a tag it does not have with `denied` rather than `manifest
 * unknown`, so matching only the obvious phrase would miss the case this was
 * written for.
 */
const REFUSALS = {
  "an unpublished tag": [
    " dashboard Pulling ",
    "Error response from daemon: manifest unknown",
  ].join("\n"),
  "the tag missing from a repository that exists": [
    " dashboard Pulling ",
    "Error response from daemon: manifest for ghcr.io/sammytourani/evestack-dashboard:0.4.0 not found: manifest unknown: manifest unknown",
  ].join("\n"),
  "an anonymous pull GHCR treats as private": [
    " dashboard Pulling ",
    "Error response from daemon: denied: denied",
  ].join("\n"),
  "a repository that is not there": [
    "Error response from daemon: pull access denied for ghcr.io/sammytourani/evestack-dashboard, repository does not exist or may require 'docker login'",
  ].join("\n"),
  "an expired credential": [
    "Error response from daemon: unauthorized: authentication required",
  ].join("\n"),
};

for (const [what, output] of Object.entries(REFUSALS)) {
  test(`${what} is explained rather than pointed at empty logs`, () => {
    const explained = dashboardPullFailure(output);
    assert.ok(explained, `not recognised as a registry refusal:\n${output}`);

    // The headline replaces the generic one, and names the image — the reader
    // has to know WHICH tag was refused to act on any of the three options.
    assert.ok(
      explained.headline.includes(DASHBOARD_IMAGE),
      `the headline does not name the image:\n${explained.headline}`,
    );

    const detail = explained.detail.join("\n");
    // The correction. Without this line the reader goes to `logs` and finds
    // nothing, which reads as a second broken thing rather than as the answer.
    assert.match(detail, /docker compose logs dashboard` has nothing to show/);
    assert.match(detail, /no\ncontainer was ever created/);

    // Three ways out, each one a command that can be run as printed.
    assert.ok(detail.includes(`docker manifest inspect ${DASHBOARD_IMAGE}`), detail);
    assert.ok(detail.includes("EVESTACK_DASHBOARD_IMAGE="), detail);
    assert.ok(detail.includes(`git clone ${REPO}`), detail);
    assert.ok(detail.includes("docker compose build dashboard"), detail);

    // .env, not .env.local — Compose interpolates from the first and never the
    // second, and putting it in the wrong one is a silent no-op.
    assert.match(detail, /NOT \.env\.local/);
  });
}

test("the override it suggests is a tag on the same repository", () => {
  const detail = dashboardPullFailure("Error response from daemon: manifest unknown").detail.join("\n");
  const suggested = /EVESTACK_DASHBOARD_IMAGE=(\S+)/.exec(detail)?.[1];
  assert.ok(suggested, detail);
  // A suggestion that changes the repository as well as the tag would send the
  // reader somewhere this project has never been tested against.
  const repository = (name) => name.slice(0, name.lastIndexOf(":"));
  assert.equal(repository(suggested), repository(DASHBOARD_IMAGE));
  assert.notEqual(suggested, DASHBOARD_IMAGE, "it suggests the tag that just failed");
});

/* -------------------------------------------------------------------------- */
/* and the failures this must stay quiet about                                 */
/* -------------------------------------------------------------------------- */

/**
 * The same step fails for reasons that have nothing to do with a registry, and
 * every one of them would be actively misdirected by the explanation above. A
 * confident wrong answer costs more than the vague right one it replaced, so
 * the match is deliberately narrow and this is what holds it there.
 */
const NOT_A_REGISTRY_PROBLEM = {
  "a port already taken":
    "Error response from daemon: driver failed programming external connectivity on endpoint " +
    "demo-dashboard-1: Bind for 127.0.0.1:4001 failed: port is already allocated",
  "a daemon that is not running":
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  "a container that came up and failed its healthcheck":
    "container demo-dashboard-1 is unhealthy\ndependency failed to start",
  "a full disk":
    "write /var/lib/docker/tmp/GetImageBlob123456: no space left on device",
  "a compose file that will not parse":
    "validating docker-compose.yml: services.dashboard.image must be a string",
  "nothing at all":
    "",
};

for (const [what, output] of Object.entries(NOT_A_REGISTRY_PROBLEM)) {
  test(`${what} keeps the generic message, not the registry one`, () => {
    assert.equal(
      dashboardPullFailure(output),
      null,
      `a registry explanation was offered for something else:\n${output}`,
    );
  });
}

test("no output at all is not evidence of anything", () => {
  assert.equal(dashboardPullFailure(undefined), null);
  assert.equal(dashboardPullFailure(null), null);
});
