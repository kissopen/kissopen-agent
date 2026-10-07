# syntax=docker/dockerfile:1

# Monty's Linux ARM64 addon requires glibc 2.39 or newer. Keep build and runtime
# on Trixie (glibc 2.41) so the deployed daemon can load its native dependencies.
FROM node:24-trixie-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY patches patches
COPY docs docs
COPY packages/gym/package.json packages/gym/package.json
COPY packages/gym-tests/package.json packages/gym-tests/package.json
COPY packages/ghostty-web/package.json packages/ghostty-web/package.json
COPY packages/kissopen-agent-gym/package.json packages/kissopen-agent-gym/package.json
COPY packages/kissopen-providers/package.json packages/kissopen-providers/package.json
COPY packages/kissopen-agent-base/package.json packages/kissopen-agent-base/package.json
COPY packages/kissopen-agent-client/package.json packages/kissopen-agent-client/package.json
COPY packages/kissopen-agent-compute/package.json packages/kissopen-agent-compute/package.json
COPY packages/kissopen-agent-supervisor/package.json packages/kissopen-agent-supervisor/package.json
COPY packages/kissopen-agent-modules/package.json packages/kissopen-agent-modules/package.json
COPY packages/kissopen-agent/package.json packages/kissopen-agent/package.json
COPY packages/kissopen-terminal/package.json packages/kissopen-terminal/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

COPY packages/ghostty-web packages/ghostty-web
COPY packages/kissopen-agent-gym packages/kissopen-agent-gym
COPY packages/kissopen-providers packages/kissopen-providers
COPY packages/kissopen-agent-base packages/kissopen-agent-base
COPY packages/kissopen-agent-client packages/kissopen-agent-client
COPY packages/kissopen-agent-compute packages/kissopen-agent-compute
COPY packages/kissopen-agent-supervisor packages/kissopen-agent-supervisor
COPY packages/kissopen-agent-modules packages/kissopen-agent-modules
COPY packages/kissopen-agent packages/kissopen-agent
COPY packages/kissopen-terminal packages/kissopen-terminal
RUN pnpm --filter @slopus/ghostty-web build
RUN pnpm --filter @kissopen/kissopen-providers build
RUN pnpm --filter @kissopen/kissopen-agent-supervisor build
RUN pnpm --filter @kissopen/kissopen-agent-client build
RUN pnpm --filter @kissopen/kissopen-agent-base build
RUN pnpm --filter @kissopen/kissopen-agent-compute build
RUN pnpm --filter @kissopen/kissopen-agent-modules build
RUN pnpm --filter @kissopen/kissopen-agent build
RUN pnpm --filter @kissopen/kissopen-terminal build
RUN pnpm --filter @kissopen/kissopen-terminal deploy --legacy /prod/kissopen-terminal
# The Gym is a development build. Give Kissopen Terminal the daemon built from this checkout so an isolated
# fixture never downloads a production release from GitHub.
RUN pnpm --filter @kissopen/kissopen-agent deploy --prod --legacy /prod/kissopen-agent
# Every deployed @slopus/ghostty-web copy ships only its build output, so point its exports at the
# build instead of the TypeScript sources it normally resolves to inside the workspace. pnpm may
# install both a published copy and a workspace-file copy at different physical paths.
RUN find /prod/kissopen-terminal/node_modules /prod/kissopen-agent/node_modules \
    -path '*/@slopus/ghostty-web/package.json' \
    -exec node --input-type=module --eval "import { readFileSync, writeFileSync } from 'node:fs'; const path = process.argv[1]; const manifest = JSON.parse(readFileSync(path, 'utf8')); manifest.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.js' }; writeFileSync(path, JSON.stringify(manifest, null, 2) + '\\n')" {} \;
RUN pnpm --filter @kissopen/kissopen-terminal-gym-tests deploy --prod --legacy /prod/gym

FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        git \
        procps \
        ripgrep \
        socat \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory /workspace

WORKDIR /app
COPY --from=build /prod/kissopen-terminal packages/kissopen-terminal
COPY --from=build /prod/kissopen-agent kissopen-agent
COPY --from=build /prod/gym gym

# Import the deployed daemon in the final image, not just in the build stage.
# This catches missing assets and incompatible native libraries before any Gym starts.
RUN node --input-type=module --eval "await import('./kissopen-agent/dist/index.js')"

ENV HOME=/home/kissopen-terminal
ENV KISSOPEN_TERMINAL_GYM_KISSOPEN_AGENT_COMMAND="[\"node\",\"/app/kissopen-agent/dist/cli.js\"]"
ENV TERM=xterm-256color
RUN mkdir -p /home/kissopen-terminal /workspace && chown -R node:node /home/kissopen-terminal /workspace

USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/kissopen-terminal/dist/main.js"]
