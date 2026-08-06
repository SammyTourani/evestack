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
# ci.yml's `dashboard-build` job compiles the app on every commit and the
# publish workflow builds this file for real on every release tag, so that
# particular silence is over.
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
    PORT=4000 \
    HOSTNAME=0.0.0.0

# HOSTNAME is NOT decoration and NOT the container's name. Next's standalone
# server.js binds whatever `process.env.HOSTNAME` says, and Docker sets that to
# the container id — so without this line the server listens on the container
# IP alone. Measured: 127.0.0.1:4000 inside the container is ECONNREFUSED while
# the published port answers fine from the host, so the app looks healthy from
# outside and the HEALTHCHECK, which has only loopback to work with, fails
# forever. That marks the container unhealthy permanently and, worse, means
# `depends_on: condition: service_healthy` in the compose file never releases.
# The old `next start --hostname 0.0.0.0` passed this on the command line; the
# standalone server takes it only from the environment.
WORKDIR /repo

# `image.source` is the one that does real work: GitHub reads it to attach the
# package to this repository, which is what gives the GHCR page a README, a
# source link, and inherited access settings. The publish workflow sets the same
# labels (plus `version`) through docker/metadata-action; these are here so an
# image built by hand — the escape hatch in the header — is identified too.
LABEL org.opencontainers.image.source="https://github.com/SammyTourani/evestack" \
      org.opencontainers.image.description="Self-hosted observability and control plane for eve agents" \
      org.opencontainers.image.licenses="Apache-2.0"

# `output: "standalone"` emits a tree containing only the modules the tracer
# proves are reachable, plus a server.js that needs no `next` CLI. Measured on
# this app: 39 MB against the 448 MB a `--prod` install produced, and
# node_modules was 448 MB of the 462 MB image. Same three-stage shape, roughly a
# tenth of the payload.
#
# The header used to argue against this, on the grounds that the tracer cannot
# see `sql/*.sql` read at request time. That objection does not survive being
# checked: Next copies the package's own non-JS files into the standalone tree,
# and sql/, fixtures/ and the bundled skills all arrive without being asked for.
# They are still copied explicitly below, because "the tracer happened to
# include it" is a weaker guarantee than a COPY line, and these three are the
# ones that 500 at request time rather than failing the build.
COPY --from=build --chown=node:node /repo/packages/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/packages/dashboard/.next/static ./packages/dashboard/.next/static
COPY --from=build --chown=node:node /repo/packages/dashboard/public ./packages/dashboard/public

# The three that are read off disk at REQUEST time, not build time, and so 500
# the first time a page needs them rather than failing the build:
# lib/approvals.ts, lib/memories.ts and lib/traces.ts each readFileSync a
# sql/*.sql walking up from process.cwd(); the Skills page reads the malicious
# fixture for `?selftest=1`; and lib/skills.ts falls back to the bundled
# template skills when a deployment has none of its own.
COPY --from=build --chown=node:node /repo/packages/dashboard/sql ./packages/dashboard/sql
COPY --from=build --chown=node:node /repo/packages/dashboard/fixtures ./packages/dashboard/fixtures
COPY --from=build --chown=node:node /repo/templates/default/agent/skills ./templates/default/agent/skills

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
WORKDIR /repo/packages/dashboard
CMD ["node", "server.js"]
