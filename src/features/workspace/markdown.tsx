import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Raw HTML is ignored; only HTTP(S) links are navigable. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="answer-markdown min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : '')}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-sm text-brand underline decoration-brand/40 underline-offset-2 outline-none transition-colors hover:decoration-brand focus-visible:ring-2 focus-visible:ring-ring"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>[图片：{alt ?? '未加载'}]</span>,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
