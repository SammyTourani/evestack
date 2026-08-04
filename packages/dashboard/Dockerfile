# evestack dashboard.
#
# Multi-stage so the runtime image carries no toolchain and no source. Node 24
# to match what eve itself requires.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json ./
# No lockfile is copied on purpose: this package lives in a pnpm workspace whose
# lockfile covers the whole monorepo and would not resolve standalone here.
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./

# Never run as root: this container holds a database URL and can start and
# cancel agent runs.
USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "next", "start", "--port", "4000", "--hostname", "0.0.0.0"]
