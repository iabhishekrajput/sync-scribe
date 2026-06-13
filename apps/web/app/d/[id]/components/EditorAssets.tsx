"use client";

import React, { useEffect, useState } from "react";
import type * as Monaco from "monaco-editor";

import { api } from "../../../lib/api";

export type AssetUploadOpts = {
  canUpload: () => boolean;
  onError: (msg: string) => void;
};

const ALLOWED_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const ASSET_MAX_BYTES = 8 * 1024 * 1024;

export async function uploadAndInsertImagesMonaco(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  docId: string,
  rawFiles: File[],
  opts: AssetUploadOpts,
  offset?: number,
) {
  const model = editor.getModel();
  if (!model || !monaco) return;
  if (!opts.canUpload()) {
    opts.onError("You don't have edit access on this document.");
    return;
  }
  const accepted: File[] = [];
  for (const f of rawFiles) {
    if (!ALLOWED_ASSET_TYPES.has(f.type)) {
      opts.onError(`Unsupported file type: ${f.type || f.name}`);
      continue;
    }
    if (f.size > ASSET_MAX_BYTES) {
      opts.onError(`${f.name} is larger than the 8 MiB upload cap.`);
      continue;
    }
    accepted.push(f);
  }
  for (const file of accepted) {
    const placeholder = `\n![uploading ${file.name}…]()\n`;
    const at = offset ?? model.getOffsetAt(editor.getPosition() ?? new monaco.Position(1, 1));
    const start = model.getPositionAt(at);
    editor.executeEdits("syncscribe-asset-upload", [{
      range: new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column),
      text: placeholder,
      forceMoveMarkers: true,
    }]);
    const placeholderStart = at;
    const placeholderEnd = at + placeholder.length;
    editor.setPosition(model.getPositionAt(placeholderEnd));
    try {
      const res = await api.uploadAsset(docId, file);
      const alt = file.name.replace(/[\[\]]/g, "") || "image";
      const md = `![${alt}](${res.url})`;
      replaceEditorText(editor, monaco, placeholderStart, placeholderEnd, md);
    } catch (err) {
      replaceEditorText(editor, monaco, placeholderStart, placeholderEnd, "");
      const msg = err instanceof Error ? err.message : "Upload failed.";
      opts.onError(`${file.name}: ${msg}`);
    }
  }
}

function replaceEditorText(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  from: number,
  to: number,
  text: string,
) {
  const model = editor.getModel();
  if (!model || !monaco) return;
  const start = model.getPositionAt(from);
  const end = model.getPositionAt(to);
  editor.executeEdits("syncscribe-asset-upload", [{
    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
    text,
    forceMoveMarkers: true,
  }]);
}

// AuthedImg renders <img> for markdown URLs that point at our authed asset
// endpoint. The browser cannot send a Bearer token from a plain `src`, so we
// fetch the asset, convert to a blob URL, and swap it in. Non-asset URLs
// (external images) pass through unchanged.
export function AuthedImg({ docId, src, alt, ...rest }: { docId: string; src?: string; alt?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [asset, setAsset] = useState<{ src: string; resolved?: string; failed: boolean }>({
    src: "",
    resolved: undefined,
    failed: false,
  });
  const assetMatch = src?.match(/\/api\/documents\/([^/]+)\/assets\/([^/?#]+)/);
  const shouldFetch = !!assetMatch && assetMatch[1] === docId;
  const resolved = shouldFetch ? (asset.src === src ? asset.resolved : undefined) : src;
  const failed = shouldFetch ? asset.src === src && asset.failed : false;

  useEffect(() => {
    if (!src || !assetMatch || !shouldFetch) return;
    let alive = true;
    let blob: string | null = null;
    const [, , assetId] = assetMatch;
    (async () => {
      try {
        const u = await api.fetchAssetBlobURL(docId, assetId);
        if (!alive) {
          URL.revokeObjectURL(u);
          return;
        }
        blob = u;
        setAsset({ src, resolved: u, failed: false });
      } catch {
        if (alive) setAsset({ src, resolved: undefined, failed: true });
      }
    })();
    return () => {
      alive = false;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [assetMatch, docId, shouldFetch, src]);

  if (failed) return <span className="text-xs opacity-60">[image failed to load]</span>;
  if (!resolved) return <span className="text-xs opacity-60">Loading image…</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} alt={alt ?? ""} {...rest} />;
}
