"use client";

// Barrel over the domain-partitioned API modules in app/lib/api/. Existing
// import sites keep working; new code may import a domain module directly.
import { ApiError } from "./errors";
import { accessApi } from "./api/access";
import { activityApi } from "./api/activity";
import { assetsApi } from "./api/assets";
import { commentsApi } from "./api/comments";
import { documentsApi } from "./api/documents";
import { shareApi } from "./api/share";
import { snapshotsApi } from "./api/snapshots";

export { ApiError };
export type * from "./api/types";

export const api = {
  ...documentsApi,
  ...accessApi,
  ...snapshotsApi,
  ...assetsApi,
  ...shareApi,
  ...commentsApi,
  ...activityApi,
};
