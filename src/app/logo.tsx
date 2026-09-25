import { useId } from 'react'
import { glyphs } from './logo-glyphs'

// 标志是图形资产，颜色固定（朱漆、鎏金），不随主题变化；深浅两色背景上都已核对。与 public/favicon.svg 同形。

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-lacquer`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#c7222b" />
        <stop offset="0.55" stopColor="#a3131c" />
        <stop offset="1" stopColor="#7c0c13" />
      </linearGradient>
      <linearGradient id={`${id}-gold`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff1c4" />
        <stop offset="0.3" stopColor="#e8c465" />
        <stop offset="0.52" stopColor="#b8892c" />
        <stop offset="0.7" stopColor="#f0d27c" />
        <stop offset="1" stopColor="#a0741f" />
      </linearGradient>
      <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
        <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#fff8dc" stopOpacity="0" />
        <stop offset="0.5" stopColor="#fff8dc" stopOpacity="0.55" />
        <stop offset="1" stopColor="#fff8dc" stopOpacity="0" />
      </linearGradient>
    </defs>
  )
}

/** 铸字：暗红压影在下、鎏金在上，看起来是凸起的金字。 */
function Glyph({
  char,
  x,
  y,
  size,
  id,
}: {
  char: keyof typeof glyphs
  x: number
  y: number
  size: number
  id: string
}) {
  const scale = size / 1000
  return (
    <>
      <path
        d={glyphs[char]}
        transform={`translate(${x} ${y + size * 0.023}) scale(${scale})`}
        fill="#4d070c"
        opacity="0.55"
      />
      <path
        d={glyphs[char]}
        transform={`translate(${x} ${y}) scale(${scale})`}
        fill={`url(#${id}-gold)`}
      />
    </>
  )
}

/**
 * 铭牌：朱漆底、鎏金双线框，左上与右下的「」角饰寓意引文可溯源。
 * 鎏光（一道光带扫过）由 globals.css 的 .nameplate-sheen 控制：悬停时扫一次，减少动效时不播放。
 */
export function Nameplate({ width, className }: { width: number; className?: string }) {
  const id = useId()
  const chars = ['管', '策', '智', '研'] as const
  const start = (520 - (4 * 64 + 3 * 22)) / 2
  return (
    <svg
      width={width}
      height={Math.round((width * 136) / 520)}
      viewBox="0 0 520 136"
      role="img"
      aria-label="管策智研"
      className={`group/nameplate shrink-0 ${className ?? ''}`}
    >
      <Defs id={id} />
      <clipPath id={`${id}-clip`}>
        <rect width="520" height="136" rx="10" />
      </clipPath>
      <rect width="520" height="136" rx="10" fill={`url(#${id}-lacquer)`} />
      <rect width="520" height="136" rx="10" fill={`url(#${id}-gloss)`} />
      <rect
        x="6"
        y="6"
        width="508"
        height="124"
        rx="7"
        fill="none"
        stroke={`url(#${id}-gold)`}
        strokeWidth="3"
      />
      <rect
        x="13"
        y="13"
        width="494"
        height="110"
        rx="4"
        fill="none"
        stroke={`url(#${id}-gold)`}
        strokeWidth="1.2"
      />
      <path
        d="M24 42V24h18M496 94v18h-18"
        fill="none"
        stroke={`url(#${id}-gold)`}
        strokeWidth="3"
      />
      {chars.map((char, i) => (
        <Glyph key={char} char={char} x={start + i * 86} y={36} size={64} id={id} />
      ))}
      <g clipPath={`url(#${id}-clip)`}>
        <g className="nameplate-sheen">
          <rect
            x="-40"
            y="-20"
            width="110"
            height="176"
            fill={`url(#${id}-sheen)`}
            transform="skewX(-22)"
          />
        </g>
      </g>
    </svg>
  )
}

/** “策”字方印：网站图标、欢迎页与连接页使用；小于 40px 时去掉内框以保持清晰。 */
export function Seal({ size, className }: { size: number; className?: string }) {
  const id = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 136 136"
      role="img"
      aria-label="管策智研"
      className={`shrink-0 ${className ?? ''}`}
    >
      <Defs id={id} />
      <rect width="136" height="136" rx="12" fill={`url(#${id}-lacquer)`} />
      <rect width="136" height="136" rx="12" fill={`url(#${id}-gloss)`} />
      <rect
        x="6"
        y="6"
        width="124"
        height="124"
        rx="9"
        fill="none"
        stroke={`url(#${id}-gold)`}
        strokeWidth={size >= 40 ? 4 : 8}
      />
      {size >= 40 && (
        <rect
          x="14"
          y="14"
          width="108"
          height="108"
          rx="5"
          fill="none"
          stroke={`url(#${id}-gold)`}
          strokeWidth="1.5"
        />
      )}
      <Glyph char="策" x={23} y={23} size={90} id={id} />
    </svg>
  )
}
