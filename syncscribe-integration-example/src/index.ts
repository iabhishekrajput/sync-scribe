import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  SyncClient,
  SyncScribeApiClient,
  buildSyncProtocols,
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
const sync = new SyncClient({
  url: buildSyncUrl(wsBaseUrl, documentId),
  protocols: buildSyncProtocols(accessToken),
  doc,
  awareness,
  onStateChange(state) {
    console.log("state:", state);
    if (state === "live") ready.resolve();
  },
});

await ready.promise;

const text = doc.getText("content");
text.insert(text.length, `\nIntegration example touched this doc at ${new Date().toISOString()}\n`);

await delay(1500);

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
