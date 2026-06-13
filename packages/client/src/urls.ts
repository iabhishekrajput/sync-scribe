import { SUBPROTOCOL_YJS } from "@syncscribe/proto";

export function buildSyncUrl(baseUrl: string, documentId: string): string {
  return `${trimTrailingSlash(baseUrl)}/api/sync/${documentId}`;
}

export function buildShareSyncUrl(baseUrl: string, documentId: string, shareToken: string): string {
  return `${trimTrailingSlash(baseUrl)}/api/sync/${documentId}?share_token=${encodeURIComponent(shareToken)}`;
}

// The bearer token rides as a second subprotocol entry — browsers refuse
// Authorization headers on WS upgrades; the server's auth pulls it out of
// Sec-WebSocket-Protocol.
export function buildSyncProtocols(bearerToken?: string): string[] {
  return bearerToken ? [SUBPROTOCOL_YJS, bearerToken] : [SUBPROTOCOL_YJS];
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
