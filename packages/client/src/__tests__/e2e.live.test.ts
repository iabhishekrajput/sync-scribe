// Live end-to-end check against a running SyncScribe API. Skipped unless
// SYNCSCRIBE_E2E_SHARE_URL is set to a full share-token sync URL, e.g.
//   ws://localhost:8080/api/sync/<docId>?share_token=<token>
import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { SyncClient } from "../sync-client";
import type { SaveState } from "../types";

// Read via globalThis so this browser-typed package doesn't need @types/node.
const shareUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.SYNCSCRIBE_E2E_SHARE_URL;

describe.skipIf(!shareUrl)("live server e2e", () => {
  it("two clients converge through the server", { timeout: 15_000 }, async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const saveStates: SaveState[] = [];

    const live = (doc: Y.Doc, onSave?: (s: SaveState) => void) =>
      new Promise<SyncClient>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("never went live")), 10_000);
        const client: SyncClient = new SyncClient({
          url: shareUrl!,
          doc,
          onSaveState: onSave,
          onStateChange: (s) => {
            if (s === "live") {
              clearTimeout(timer);
              resolve(client);
            }
          },
        });
      });

    const a = await live(docA, (s) => saveStates.push(s));
    const marker = `sdk-e2e-${Date.now()}`;
    docA.getText("content").insert(0, `${marker} `);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("never saved")), 10_000);
      const check = setInterval(() => {
        if (saveStates[saveStates.length - 1] === "saved") {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const b = await live(docB);
    expect(docB.getText("content").toString()).toContain(marker);

    a.destroy();
    b.destroy();
    docA.destroy();
    docB.destroy();
  });
});
