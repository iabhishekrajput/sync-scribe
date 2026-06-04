# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS web-builder
WORKDIR /repo

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
ARG NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8080
ARG NEXT_PUBLIC_OIDC_PROVIDER_NAME=OIDC

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_WS_BASE_URL=${NEXT_PUBLIC_WS_BASE_URL} \
    NEXT_PUBLIC_OIDC_PROVIDER_NAME=${NEXT_PUBLIC_OIDC_PROVIDER_NAME}

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/proto/package.json packages/proto/package.json
COPY packages/client/package.json packages/client/package.json

RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter web build

FROM golang:1.26-alpine AS api-builder
WORKDIR /src/apps/api

ARG TARGETOS=linux
ARG TARGETARCH=amd64

ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOOS=${TARGETOS} \
    GOARCH=${TARGETARCH}

COPY apps/api/go.mod apps/api/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY apps/api ./

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags="-s -w" -o /out/syncscribe-api ./cmd/api

FROM node:22-alpine AS web
WORKDIR /app

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=web-builder /repo/apps/web/.next/standalone ./
COPY --from=web-builder /repo/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]

FROM gcr.io/distroless/static-debian12:nonroot AS api
WORKDIR /app

COPY --from=api-builder /out/syncscribe-api /app/syncscribe-api

LABEL org.opencontainers.image.title="sync-scribe api" \
      org.opencontainers.image.description="SyncScribe Go API and realtime sync gateway." \
      org.opencontainers.image.vendor="sync-scribe" \
      org.opencontainers.image.source="https://github.com/iabhishekrajput/sync-scribe" \
      org.opencontainers.image.url="https://github.com/iabhishekrajput/sync-scribe" \
      org.opencontainers.image.documentation="https://github.com/iabhishekrajput/sync-scribe#readme"

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app/syncscribe-api"]
