import { parseDocumentEvent } from "./events";
import type { AttributionQuery, AttributionResponse, DocumentEvent, EventStreamOptions } from "./types";

export class SyncScribeApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: string,
  ) {}

  async getAttribution(documentId: string, query: AttributionQuery = {}): Promise<AttributionResponse> {
    const search = new URLSearchParams();
    if (query.fromItem) search.set("fromItem", query.fromItem);
    if (query.toItem) search.set("toItem", query.toItem);
    if (query.sinceUpdateId !== undefined) search.set("sinceUpdateId", String(query.sinceUpdateId));
    search.set("limit", String(query.limit ?? 500));
    return this.request<AttributionResponse>(`/api/documents/${documentId}/attribution?${search.toString()}`);
  }

  async *streamEvents(documentId: string, options: EventStreamOptions = {}): AsyncGenerator<DocumentEvent> {
    const search = new URLSearchParams();
    if (options.sinceEventId !== undefined) search.set("sinceEventId", String(options.sinceEventId));
    const qs = search.toString();
    const res = await this.fetchRaw(`/api/documents/${documentId}/events${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("This runtime does not expose a readable response body.");

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = parseDocumentEvent(part);
          if (event) yield event;
        }
      }
      buffer += decoder.decode();
      const event = parseDocumentEvent(buffer);
      if (event) yield event;
    } finally {
      reader.releaseLock();
    }
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchRaw(path, init);
    return res.json() as Promise<T>;
  }

  private async fetchRaw(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new Error((await res.text().catch(() => "")) || res.statusText);
    }
    return res;
  }
}
