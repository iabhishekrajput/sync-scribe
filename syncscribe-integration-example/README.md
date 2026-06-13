# SyncScribe Integration Example

This is the standalone non-web client example for Phase 3.1. It uses the workspace `@syncscribe/client` package from Node instead of the Next.js editor.

## Env

```bash
export SYNCSCRIBE_API_BASE_URL=http://localhost:8080
export SYNCSCRIBE_WS_BASE_URL=ws://localhost:8080
export SYNCSCRIBE_DOC_ID=<document-id>
export SYNCSCRIBE_ACCESS_TOKEN=<oidc-access-token>
```

## Run

```bash
pnpm install
pnpm build
pnpm start
```

The script connects over WebSocket (single `syncscribe.yjs.v1` subprotocol, stock y-protocols framing), authenticates with a `getToken` callback, appends a line, waits for the server to durably persist it via the `onSaveState` "saved" signal, then fetches attribution data over HTTP and prints the first few blame spans. It demonstrates the SDK options a non-web consumer cares about: `getToken` (re-evaluated per reconnect), `onSaveState`, and `onDisconnectReason`.
