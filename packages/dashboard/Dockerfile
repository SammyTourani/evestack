# syntax=docker/dockerfile:1
#
# evestack dashboard.
#
# MOST PEOPLE SHOULD NEVER RUN THIS FILE. The image it produces is published to
# ghcr.io/sammytourani/evestack-dashboard by .github/workflows/publish-dashboard.yml,
# and a scaffolded project pulls it — `docker compose --profile dashboard up -d`,
# no clone, no build. This is the contributor's path and the escape hatch.
#
# `@evestack/dashboard` stays `private: true` in package.json and that is not
# what stops anyone installing it. A Next.js application is not something npm
# can usefully carry — the deliverable is this OCI image, and `private` is what
# keeps `pnpm -r publish` from trying to push 10k lines of app to a registry
# that has no way to run it. The `version` field is not dead either: it is the
# image tag, checked against the release tag and against the scaffolder's pin
# by the publish workflow.
#
# THE BUILD CONTEXT IS THE REPOSITORY ROOT, NOT THIS DIRECTORY:
#
#   docker build -f packages/dashboard/Dockerfile -t evestack-dashboard .
#   docker compose --profile dashboard up -d     # does exactly that for you
#
# ---------------------------------------------------------------------------
# Why the root, and not this directory
# ---------------------------------------------------------------------------
#
# This file used to be `COPY package.json ./` + `RUN npm install`, with a
# comment explaining that the lockfile was deliberately left behind. But
# package.json declares `"@evestack/schedules": "workspace:*"`, and `workspace:`
# is a pnpm protocol npm does not implement — so every build of this image, by
# anyone, ended at `EUNSUPPORTEDPROTOCOL`. No CI job built it, which is why that
# went unnoticed: `docker compose --profile full up -d` had never once worked.
# .github/workflows/dashboard-image.yml now builds this file on every PR that
# touches anything inside the image and then starts the container, so that
# particular silence is over.
#
# Note what that job covers and this comment used to imply the others did.
# `dashboard-build` in ci.yml compiles the Next application — a different
# artifact, which does not read this file. The publish workflow's "prove it
# pulls" step inspects a registry manifest and never creates a container. Both
# are green for an image that starts and 500s, which is exactly the failure the
# three COPY lines at the bottom of this file were written to prevent.
#
# Three ways out were weighed:
#
#   1. `npm pack` the workspace dependency and substitute a `file:` reference —
#      the house pattern, from the `scaffolder` job in .github/workflows/ci.yml.
#      It works there because the runner has already run `pnpm install` and
#      `pnpm -r run build`, so there is a built workspace to pack FROM. A
#      container built from a cold clone has no such tree, so this would need a
#      host-side pre-step; `docker compose up` cannot run one, and "one command"
#      is the whole promise.
#   2. Next's `output: "standalone"`. Smaller image, but it moves correctness
#      onto Next's file tracer — and this app reads `sql/*.sql` off disk at
#      request time (see the runtime stage), which the tracer has no way to
#      know about. Worth revisiting once the image is verified in CI.
#   3. Build the workspace the way the workspace is built everywhere else:
#      pnpm, at the repo root, against the real lockfile. Chosen.
#
# So: root context, and `--filter @evestack/dashboard...` narrows the install to
# the dashboard plus exactly its workspace dependencies — not the website's
# Playwright, not the template's eve. `workspace:*` then resolves the way it
# does in every other job in this repo. Cold clone in, image out.
#
# The pnpm version is NOT pinned here. corepack reads `packageManager` from the
# root package.json, so the pin lives in exactly one place — same reasoning as
# the missing `version:` on pnpm/action-setup in CI.

FROM node:24-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# deps — production node_modules, and nothing else
# ---------------------------------------------------------------------------
# A separate stage rather than a `pnpm prune` of the build stage: a fresh
# `--prod` install is an ordinary pnpm operation, whereas pruning a tree that
# has already been built through is the kind of step that works until it
# doesn't. The store is a cache mount, so this second resolve costs almost
# nothing after the first.
FROM base AS deps
COPY . .
RUN --mount=type=cache,id=evestack-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter "@evestack/dashboard..." \
      --store-dir /pnpm/store

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=evestack-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
      --filter "@evestack/dashboard..." \
      --store-dir /pnpm/store

# Workspace packages publish their types and their runtime from dist/, which is
# gitignored — so a cold clone has none, and `next build` dies on
# "Module not found: @evestack/schedules/cron" before it compiles a line of the
# dashboard. Same cold-checkout rule every job in CI has to obey.
#
# `^...` is "the dependencies of the dashboard, not the dashboard itself",
# discovered from the workspace graph rather than named. The previous version of
# this pattern in CI named a package explicitly and broke the moment a second
# one was added.
RUN pnpm -r --if-present --filter "@evestack/dashboard^..." run build
RUN pnpm --filter "@evestack/dashboard" run build

# The compiler cache is a build artifact, not a runtime one. Nothing `next start`
# serves comes out of it — prerendered output lives in .next/server — and Next
# recreates the directory if the image optimizer ever wants it.
RUN rm -rf /repo/packages/dashboard/.next/cache

# ---------------------------------------------------------------------------
# runtime — no toolchain, no source, no dev dependencies
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000
WORKDIR /repo/packages/dashboard

# `image.source` is the one that does real work: GitHub reads it to attach the
# package to this repository, which is what gives the GHCR page a README, a
# source link, and inherited access settings. The publish workflow sets the same
# labels (plus `version`) through docker/metadata-action; these are here so an
# image built by hand — the escape hatch in the header — is identified too.
LABEL org.opencontainers.image.source="https://github.com/SammyTourani/evestack" \
      org.opencontainers.image.description="Self-hosted observability and control plane for eve agents" \
      org.opencontainers.image.licenses="Apache-2.0"

# pnpm's layout is a symlink farm: packages/*/node_modules/<dep> points into
# /repo/node_modules/.pnpm. Both halves have to travel together or every import
# resolves to a dangling link, which is why this copies the root store as well
# as the per-package directories.
COPY --from=deps --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=deps --chown=node:node /repo/packages/dashboard/node_modules /repo/packages/dashboard/node_modules
COPY --from=deps --chown=node:node /repo/packages/evestack-schedules/node_modules /repo/packages/evestack-schedules/node_modules

# @evestack/schedules is a `workspace:*` symlink target, so the real directory
# has to exist — with the dist/ the build stage produced, not the empty one a
# cold clone has.
COPY --from=build --chown=node:node /repo/packages/evestack-schedules/package.json /repo/packages/evestack-schedules/package.json
COPY --from=build --chown=node:node /repo/packages/evestack-schedules/dist /repo/packages/evestack-schedules/dist

COPY --from=build --chown=node:node /repo/packages/dashboard/.next ./.next
COPY --from=build --chown=node:node /repo/packages/dashboard/public ./public
COPY --from=build --chown=node:node /repo/packages/dashboard/package.json /repo/packages/dashboard/next.config.ts ./

# NOT optional, and the reason the previous runtime stage would have failed on
# first use even if it had built. `lib/approvals.ts`, `lib/memories.ts` and
# `lib/traces.ts` each `readFileSync(join(dir, "sql", "<name>.sql"))` at REQUEST
# time — these schemas are created on demand, not by a migration — walking up
# from `process.cwd()` and throwing "Could not find sql/<name>.sql above <cwd>"
# when the walk runs out. Approvals, the memory-deletion audit log and trace
# ingest each 500 on first use without their file. The old runtime stage copied
# node_modules, .next, public, package.json and next.config.ts, and nothing else.
COPY --from=build --chown=node:node /repo/packages/dashboard/sql ./sql

# The malicious skill the scanner self-test scans, read from
# `<cwd>/fixtures/skills/…` by `readFixtureSkill()`. Absent, the Skills page
# degrades to "cannot be self-tested here" — and the scanner's proof-of-life is
# the one thing you want working in the image, not only in a source checkout.
#
# 12 KB, and it cannot be loaded as a skill by anything: `listSkills()` searches
# `agent/skills` / EVESTACK_SKILLS_DIR and never `fixtures/`, and the only reader
# is `?selftest=1` passing a hard-coded name. The specimen itself is inert by
# construction — see fixtures/README.md. So the cost is 12 KB and the benefit is
# that `curl '.../api/skills?selftest=1'` answers truthfully in production.
COPY --from=build --chown=node:node /repo/packages/dashboard/fixtures ./fixtures

# `lib/skills.ts` falls back to `<cwd>/../../templates/default/agent/skills`
# when the deployment has no `agent/skills` of its own, which a container never
# does. 8 KB, and it is what makes the Skills page show something real out of
# the box. Point EVESTACK_SKILLS_DIR at a mounted volume to scan your own.
COPY --from=build --chown=node:node /repo/templates/default/agent/skills /repo/templates/default/agent/skills

# Never run as root: this container holds a database URL and can start and
# cancel agent runs.
USER node
EXPOSE 4000

# Unauthenticated on purpose — /api/health is the one route in the `liveness`
# tier (see lib/auth.ts `tierFor()`), because Docker's HEALTHCHECK has no
# credential to present. It reports unhealthy when EVESTACK_AUTH_PASSWORD is
# unset, which is exactly the signal you want: a dashboard that fails closed
# looks broken in `docker ps` rather than looking fine and 503ing every request.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --hostname 0.0.0.0 stays. A container that binds loopback is a container
# nothing can reach — the port mapping is where exposure is actually decided,
# and docker-compose.yml publishes this on `127.0.0.1:4000:4000`. Running the
# image by hand with `-p 4000:4000` puts it on every interface instead; every
# route needs the credential either way, but see docs/self-hosting.mdx for what
# that does and does not buy you.
CMD ["node_modules/.bin/next", "start", "--port", "4000", "--hostname", "0.0.0.0"]
