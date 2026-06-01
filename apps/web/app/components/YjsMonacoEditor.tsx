"use client";

import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

type Props = {
  docPath: string;
  ytext: Y.Text;
  awareness: Awareness;
  dark: boolean;
  readOnly: boolean;
  lineNumbers: "on" | "off";
  onMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  onContextMenu?: (event: { clientX: number; clientY: number; offset: number }) => void;
  onFilesInput?: (files: File[], offset?: number) => void;
  onDragState?: (active: boolean) => void;
};

export function YjsMonacoEditor({
  docPath,
  ytext,
  awareness,
  dark,
  readOnly,
  lineNumbers,
  onMount,
  onContextMenu,
  onFilesInput,
  onDragState,
}: Props) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly, lineNumbers });
  }, [lineNumbers, readOnly]);

  useEffect(() => {
    const styleId = `syncscribe-monaco-remote-${docPath}`;
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const updateStyles = () => {
      const rules = [
        ".yRemoteSelection{background:rgba(99,102,241,0.14);border-radius:2px;}",
        ".yRemoteSelectionHead{position:relative;border-left:2px solid #6366f1;margin-left:-1px;box-sizing:border-box;}",
      ];
      awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.clientID) return;
        const user = state.user as { color?: string; name?: string } | undefined;
        const color = user?.color ?? "#6366f1";
        const name = (user?.name ?? "Someone").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const rgba = hexToRgba(color, dark ? 0.22 : 0.16);
        rules.push(
          `.yRemoteSelection-${clientID}{background:${rgba};border-radius:2px;}`,
          `.yRemoteSelectionHead-${clientID}{position:relative;border-left:2px solid ${color};margin-left:-1px;box-sizing:border-box;}`,
          `.yRemoteSelectionHead-${clientID}::before{content:"";position:absolute;left:-4px;top:-3px;width:6px;height:6px;border-radius:50%;background:${color};pointer-events:none;}`,
          `.yRemoteSelectionHead-${clientID}::after{content:"${name}";position:absolute;left:-2px;bottom:100%;margin-bottom:4px;padding:1px 6px;font-size:10px;font-weight:600;line-height:1.4;color:#fff;background:${color};border-radius:3px;white-space:nowrap;pointer-events:none;opacity:0;transform:translateY(3px);transition:opacity 120ms ease,transform 120ms ease;z-index:30;box-shadow:0 1px 2px rgba(0,0,0,0.18);}`,
          `.view-line:hover .yRemoteSelectionHead-${clientID}::after,.yRemoteSelectionHead-${clientID}:hover::after{opacity:1;transform:translateY(0);}`,
        );
      });
      style!.textContent = rules.join("\n");
    };
    awareness.on("change", updateStyles);
    updateStyles();
    return () => {
      awareness.off("change", updateStyles);
      style?.remove();
    };
  }, [awareness, dark, docPath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.getDomNode();
    const model = editor.getModel();
    if (!node || !model) return;

    const resolveOffset = (clientX?: number, clientY?: number) => {
      if (typeof clientX === "number" && typeof clientY === "number") {
        const target = editor.getTargetAtClientPoint(clientX, clientY);
        if (target?.position) return model.getOffsetAt(target.position);
      }
      const sel = editor.getSelection();
      return model.getOffsetAt(sel?.getStartPosition() ?? editor.getPosition() ?? new monacoRef.current!.Position(1, 1));
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!onContextMenu) return;
      event.preventDefault();
      onContextMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        offset: resolveOffset(event.clientX, event.clientY),
      });
    };
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0 || !onFilesInput) return;
      event.preventDefault();
      onFilesInput(files, resolveOffset());
    };
    let dragDepth = 0;
    const handleDragEnter = (event: DragEvent) => {
      if (!onFilesInput) return;
      if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
        dragDepth += 1;
        onDragState?.(true);
      }
    };
    const handleDragLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) onDragState?.(false);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!onFilesInput) return;
      if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
        event.preventDefault();
      }
    };
    const handleDrop = (event: DragEvent) => {
      dragDepth = 0;
      onDragState?.(false);
      const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0 || !onFilesInput) return;
      event.preventDefault();
      onFilesInput(files, resolveOffset(event.clientX, event.clientY));
    };

    node.addEventListener("contextmenu", handleContextMenu);
    node.addEventListener("paste", handlePaste);
    node.addEventListener("dragenter", handleDragEnter);
    node.addEventListener("dragleave", handleDragLeave);
    node.addEventListener("dragover", handleDragOver);
    node.addEventListener("drop", handleDrop);
    return () => {
      node.removeEventListener("contextmenu", handleContextMenu);
      node.removeEventListener("paste", handlePaste);
      node.removeEventListener("dragenter", handleDragEnter);
      node.removeEventListener("dragleave", handleDragLeave);
      node.removeEventListener("dragover", handleDragOver);
      node.removeEventListener("drop", handleDrop);
    };
  }, [onContextMenu, onDragState, onFilesInput]);

  useEffect(() => () => bindingRef.current?.destroy(), []);

  return (
    <Editor
      path={docPath}
      defaultLanguage="markdown"
      defaultValue={ytext.toString()}
      theme={dark ? "vs-dark" : "vs"}
      options={{
        automaticLayout: true,
        lineNumbers,
        minimap: { enabled: false },
        readOnly,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        glyphMargin: false,
        folding: false,
        renderLineHighlight: "none",
        overviewRulerBorder: false,
        contextmenu: false,
        fontFamily:
          'ui-monospace, "JetBrains Mono", "Fira Code", "SF Mono", monospace',
        fontSize: 13,
      }}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        const model = editor.getModel();
        if (!model) return;
        bindingRef.current?.destroy();
        bindingRef.current = new MonacoBinding(ytext, model, new Set([editor]), awareness);
        onMount?.(editor, monaco);
      }}
    />
  );
}

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((char) => char + char).join("")
    : clean;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return `rgba(99,102,241,${alpha})`;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
