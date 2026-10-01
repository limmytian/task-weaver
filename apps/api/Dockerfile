FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS installer
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
ENV npm_config_store_dir=/pnpm/store
COPY . .
RUN --mount=type=cache,id=tw-public-pnpm,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile
RUN --mount=type=cache,id=tw-public-pnpm,target=/pnpm/store pnpm release:licenses
RUN --mount=type=cache,id=tw-public-pnpm,target=/pnpm/store pnpm --filter @task-weaver/api deploy --prod /runtime

# Production runner
# Workspace packages export TypeScript source, so we use tsx at runtime
FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS runtime-base
USER root
# Retain trust roots, then remove the OS package manager and its unused libraries.
RUN apk add --no-network ca-certificates-bundle && apk del apk-tools
# Runtime does not install packages. Remove unused package managers and their dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

# Copy only the cleaned filesystem, not historical layers containing removed tools.
FROM scratch AS runner
COPY --from=runtime-base / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /app
ARG TW_BUILD_COMMIT
ENV TW_BUILD_COMMIT=$TW_BUILD_COMMIT
ENV NODE_ENV=production
COPY --from=installer /runtime .
COPY --from=installer /app/skills ./skills
COPY --from=installer /app/LICENSE /app/NOTICE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=installer /app/THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=installer /app/release-artifacts ./release-artifacts
COPY --from=installer /app/.release/binary-notice-baseline.json ./release-artifacts/binary-notice-baseline.json
ENV TW_PRESET_SKILLS_DIR=/app/skills
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3001
ENV PORT=3001
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
