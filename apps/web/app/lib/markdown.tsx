"use client";

import { isValidElement, type ReactNode, useEffect, useId, useState } from "react";
import type { Components } from "react-markdown";

type MermaidConfig = {
  startOnLoad: boolean;
  securityLevel: "strict";
  theme: "base" | "dark";
  themeVariables?: Record<string, string>;
};

export type MermaidAPI = {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }> | { svg: string };
};

declare global {
  interface Window {
    mermaid?: MermaidAPI;
  }
}

// Hast nodes carry source position; we use it to anchor preview blocks and
// inline text back to markdown source offsets.
export type MdNode = {
  type?: string;
  value?: string;
  tagName?: string;
  children?: MdNode[];
  properties?: Record<string, unknown>;
  position?: { start: { line: number; offset?: number }; end?: { offset?: number } };
};

export const dl = (node: unknown) => (node as MdNode).position?.start.line;
const ds = (node: unknown) => (node as MdNode).position?.start.offset;
const de = (node: unknown) => (node as MdNode).position?.end?.offset;

export function useDarkClass() {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function markPreviewSourceText(node: MdNode) {
  if (node.type === "text" && typeof node.value === "string") {
    const start = ds(node);
    const end = de(node);
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return {
        type: "element",
        tagName: "span",
        properties: {
          "data-source-start": String(start),
          "data-source-end": String(end),
          "data-source-text": node.value,
        },
        children: [node],
      } satisfies MdNode;
    }
    return node;
  }
  if (Array.isArray(node.children)) {
    node.children = node.children.map((child) => markPreviewSourceText(child));
  }
  return node;
}

export function rehypeSourceTextSpans() {
  return (tree: MdNode) => {
    markPreviewSourceText(tree);
  };
}

let mermaidLoad: Promise<MermaidAPI> | null = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoad) return mermaidLoad;

  mermaidLoad = new Promise<MermaidAPI>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-syncscribe-mermaid]");
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error("mermaid unavailable"));
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error("mermaid load failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.async = true;
    script.dataset.syncscribeMermaid = "true";
    script.onload = () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error("mermaid unavailable"));
    };
    script.onerror = () => reject(new Error("mermaid load failed"));
    document.head.appendChild(script);
  });

  return mermaidLoad;
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const isDark = useDarkClass();
  const renderKey = `${isDark ? "dark" : "light"}\n${source}`;
  const [rendered, setRendered] = useState<{ key: string; svg: string; failed: boolean }>({
    key: "",
    svg: "",
    failed: false,
  });
  const svg = rendered.key === renderKey ? rendered.svg : "";
  const failed = rendered.key === renderKey && rendered.failed;

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "base",
          themeVariables: isDark
            ? {
                lineColor: "#d4d4d8",
                primaryTextColor: "#f5f5f5",
                primaryBorderColor: "#a3a3a3",
                edgeLabelBackground: "#171717",
                actorLineColor: "#d4d4d8",
                signalColor: "#d4d4d8",
                signalTextColor: "#f5f5f5",
              }
            : undefined,
        });
        const result = await mermaid.render(`mermaid-${id}`, source);
        if (alive) setRendered({ key: renderKey, svg: result.svg, failed: false });
      } catch {
        if (alive) setRendered({ key: renderKey, svg: "", failed: true });
      }
    })();

    return () => {
      alive = false;
    };
  }, [id, isDark, renderKey, source]);

  if (failed) {
    return <pre className="mermaid-fallback"><code>{source}</code></pre>;
  }
  if (!svg) {
    return <div className="mermaid-loading">Rendering diagram…</div>;
  }
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function isMermaidCodeChild(children: ReactNode) {
  if (!isValidElement(children)) return false;
  const props = children.props as { className?: unknown };
  return typeof props.className === "string" && /\blanguage-mermaid\b/.test(props.className);
}

export const markdownComponents: Components = {
  pre({ node, children, ...props }) {
    if (isMermaidCodeChild(children)) return <>{children}</>;
    return <pre data-line={dl(node)} {...props}>{children}</pre>;
  },
  code({ node: _node, className, children, ...props }) {
    const source = String(children).replace(/\n$/, "");
    if (/\blanguage-mermaid\b/.test(className ?? "")) {
      return <MermaidDiagram source={source} />;
    }
    return <code className={className} {...props}>{children}</code>;
  },
  p({ node, children, ...props }) { return <p data-line={dl(node)} {...props}>{children}</p>; },
  h1({ node, children, ...props }) { return <h1 data-line={dl(node)} {...props}>{children}</h1>; },
  h2({ node, children, ...props }) { return <h2 data-line={dl(node)} {...props}>{children}</h2>; },
  h3({ node, children, ...props }) { return <h3 data-line={dl(node)} {...props}>{children}</h3>; },
  h4({ node, children, ...props }) { return <h4 data-line={dl(node)} {...props}>{children}</h4>; },
  h5({ node, children, ...props }) { return <h5 data-line={dl(node)} {...props}>{children}</h5>; },
  h6({ node, children, ...props }) { return <h6 data-line={dl(node)} {...props}>{children}</h6>; },
  blockquote({ node, children, ...props }) { return <blockquote data-line={dl(node)} {...props}>{children}</blockquote>; },
  ul({ node, children, ...props }) { return <ul data-line={dl(node)} {...props}>{children}</ul>; },
  ol({ node, children, ...props }) { return <ol data-line={dl(node)} {...props}>{children}</ol>; },
  table({ node, children, ...props }) { return <table data-line={dl(node)} {...props}>{children}</table>; },
};
