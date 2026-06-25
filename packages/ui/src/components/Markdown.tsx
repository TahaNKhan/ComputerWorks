// packages/ui/src/components/Markdown.tsx
// T7.7 — GFM Markdown renderer with syntax highlighting (shiki), raw
// HTML sanitization (rehype-sanitize), and inline-code copy-on-click.
//
// We render react-markdown with remark-gfm for tables/task lists/
// strikethrough/autolinks. Code blocks are highlighted asynchronously
// by shiki via a small custom `code` component; the result is cached
// per (lang, code) pair so we don't re-highlight on every render.

import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { codeToHtml } from "shiki";

interface Props {
  source: string;
}

// Languages we ask shiki to highlight. Kept short on purpose — each
// language costs a few hundred KB the first time it's used.
const SHIKI_LANGS = new Set<string>([
  "bash",
  "json",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "python",
  "diff",
  "markdown",
  "yaml",
]);

// Module-level cache so the same (lang, code) pair is only
// highlighted once across the whole app.
const highlightCache = new Map<string, string>();

// ─── Code-block component (with shiki highlight) ────────────────────────

interface CodeProps extends React.HTMLAttributes<HTMLElement> {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

function CodeBlock(props: CodeProps): JSX.Element {
  const { inline, className, children } = props;
  const raw = extractText(children).replace(/\n$/, "");
  const lang = typeof className === "string" && className.startsWith("language-")
    ? className.slice("language-".length)
    : undefined;

  if (inline) {
    return (
      <code
        className="cw-inline-code"
        onClick={() => {
          void copyToClipboard(raw);
        }}
        title="Click to copy"
      >
        {children}
      </code>
    );
  }

  return <FencedCode code={raw} lang={lang ?? "text"} />;
}

function FencedCode({ code, lang }: { code: string; lang: string }): JSX.Element {
  const [html, setHtml] = useState<string | null>(() => highlightCache.get(`${lang}:${code}`) ?? null);
  const cancelled = useRef(false);

  useEffect(() => {
    const key = `${lang}:${code}`;
    const cached = highlightCache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    cancelled.current = false;
    const effectiveLang = SHIKI_LANGS.has(lang) ? lang : "text";
    void codeToHtml(code, { lang: effectiveLang as never, theme: "github-dark" })
      .then((out) => {
        if (cancelled.current) return;
        highlightCache.set(key, out);
        setHtml(out);
      })
      .catch(() => {
        if (cancelled.current) return;
        const fallback = `<pre>${escapeHtml(code)}</pre>`;
        highlightCache.set(key, fallback);
        setHtml(fallback);
      });
    return () => {
      cancelled.current = true;
    };
  }, [code, lang]);

  const body = html ?? `<pre>${escapeHtml(code)}</pre>`;
  return (
    <div className="cw-code-block">
      <div className="cw-code-lang">{lang}</div>
      <div
        className="cw-code-body"
        // shiki output contains only span elements with token classes —
        // safe to inject. Raw source content is escaped.
        dangerouslySetInnerHTML={{ __html: body }}
      />
      <button
        type="button"
        className="cw-code-copy"
        onClick={() => {
          void copyToClipboard(code);
        }}
        aria-label="Copy code"
      >
        Copy
      </button>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return "";
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore — clipboard might be unavailable */
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Main component ─────────────────────────────────────────────────────

export function Markdown({ source }: Props): JSX.Element {
  // Allow extra attributes shiki needs: `className` and inline `style`
  // on span, plus `className` on code/pre.
  const schema = useMemo(() => ({
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      code: [...(defaultSchema.attributes?.code ?? []), "className", "dataLanguage"],
      span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
      pre: [...(defaultSchema.attributes?.pre ?? []), "className", "dataLanguage"],
      div: [...(defaultSchema.attributes?.div ?? []), "className", "dataLanguage"],
    },
  }), []);

  return (
    <div className="cw-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={{
          code: CodeBlock as React.ComponentType<CodeProps>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}