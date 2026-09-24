/** 品牌标志：直角引号「」框住一段原文，表示回答可追溯到原文片段。与 public/favicon.svg 保持同一图形。 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`text-brand ${className ?? ''}`}>
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <g
        className="stroke-card"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 14V9h5M23 18v5h-5" />
        <path d="M12.5 16h7" strokeWidth="3" />
      </g>
    </svg>
  )
}
