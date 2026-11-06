FROM node:24.22.2-alpine3.23@sha256:9b69af715c7f9d038150b54ccccbaeffa9064bbc93e2904c29591ca097316af1

RUN apk add --no-cache git openssh-client \
    && npm install --global pnpm@9.15.0 @openai/codex@0.166.0

WORKDIR /app
COPY . .
RUN --mount=type=cache,id=tw-worker-pnpm,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile \
    && mkdir -p /home/node/.codex /home/node/.task-weaver \
    && chown -R node:node /home/node

USER node
WORKDIR /app/apps/cli
ENTRYPOINT ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs", "src/index.ts", "worker", "start"]
