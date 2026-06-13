import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  SyncClient,
  SyncScribeApiClient,
  buildSyncUrl,
  compressBlame,
  computeBlame,
} from "@syncscribe/client";

const apiBaseUrl = required("SYNCSCRIBE_API_BASE_URL");
const wsBaseUrl = required("SYNCSCRIBE_WS_BASE_URL");
const documentId = required("SYNCSCRIBE_DOC_ID");
const accessToken = required("SYNCSCRIBE_ACCESS_TOKEN");

const doc = new Y.Doc();
const awareness = new Awareness(doc);
awareness.setLocalStateField("user", {
  name: "Integration Example",
  color: "#0ea5e9",
  actor: "human",
});

const ready = deferred<void>();
const saved = deferred<void>();
const sync = new SyncClient({
  url: buildSyncUrl(wsBaseUrl, documentId),
  // getToken is re-evaluated on every (re)connect, so a refreshed bearer is
  // picked up automatically on reconnect. A static token works too.
  getToken: async () => accessToken,
  doc,
  awareness,
  onStateChange(state) {
    console.log("state:", state);
    if (state === "live") ready.resolve();
  },
  // SaveState collapses the ACK stream into saved / saving / offline — the
  // same signal the web app drives its "Saving…/Saved" indicator from.
  onSaveState(state) {
    console.log("save:", state);
    if (state === "saved") saved.resolve();
  },
  onDisconnectReason(reason, level) {
    console.log(`disconnect (${level}):`, reason);
  },
});

await ready.promise;

const text = doc.getText("content");
text.insert(text.length, `\nIntegration example touched this doc at ${new Date().toISOString()}\n`);

// Wait for the server to durably persist the edit (Ack -> SaveState "saved")
// instead of a blind sleep.
await Promise.race([saved.promise, delay(5000)]);

const api = new SyncScribeApiClient(apiBaseUrl, accessToken);
const attribution = await api.getAttribution(documentId, { sinceUpdateId: 0, limit: 20 });
const blame = computeBlame(attribution.updates);
const spans = compressBlame(blame).slice(0, 5);

console.log("doc length:", text.length);
console.log("next cursor:", attribution.cursor.next_since_update_id);
console.log("first spans:", spans.map((span) => ({
  start: span.start,
  end: span.end,
  userId: span.mark.userId,
  name: span.mark.name,
})));

sync.destroy();
doc.destroy();

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
