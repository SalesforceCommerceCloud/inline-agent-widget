import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

/**
 * Renders agent text as markdown. `rehype-sanitize` strips unsafe HTML and
 * `javascript:` URLs — we deliberately do NOT use `rehype-raw`, which would
 * pass raw HTML through unsanitized.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
