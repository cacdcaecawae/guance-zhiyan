import { useState, type CSSProperties } from 'react'
import { wordmark } from './logo-glyphs'

// 标志：一束竹简，抽出的一枚为朱红（“策”本义为竹简，也指运筹的筹策）。颜色取 seal 与 foreground-subtlest，随主题切换。
// 动效写在 globals.css 的 .slips。public/favicon.svg 是同一束竹简按 16px 像素网格画的版本。

const SLIPS = [0, 1, 2, 3, 4, 5, 6]
const MIDDLE = 3

type Fx = 'hit' | 'bob' | 'drop' | 'wave'

/**
 * 把 48×48 的设计几何（竹简宽 4、缝 2、顶边 10、高 34、抽出 6）按显示尺寸取整到像素，宽至少 2px、缝至少 1px，整束居中。
 * 按比例缩放会落在小数像素上，小尺寸在 1 倍屏上粗细不均、缝被抹掉。
 */
function geometry(size: number) {
  const unit = size / 48
  const width = Math.max(2, Math.round(4 * unit))
  const gap = Math.max(1, Math.round(2 * unit))
  return {
    width,
    step: width + gap,
    left: Math.floor((size - SLIPS.length * width - (SLIPS.length - 1) * gap) / 2),
    top: Math.round(10 * unit),
    height: Math.round(34 * unit),
    lift: Math.max(2, Math.round(6 * unit)),
  }
}

/**
 * 竹简标志，对读屏隐藏。点哪一枚就抽出哪一枚（只响应指针，不进 Tab 顺序，刷新后回到居中一枚）；
 * loading 时不响应点击，竹简自右向左依次抽出，作生成中的指示。
 */
export function SlipsMark({ size, loading = false }: { size: number; loading?: boolean }) {
  // clicks 作动效层的 key：每次点击换新元素，同一段动画才能重播；首屏为 0，不播放
  const [{ picked, prev, clicks }, setState] = useState({ picked: MIDDLE, prev: MIDDLE, clicks: 0 })
  const fx = (i: number): Fx | undefined => {
    if (loading || clicks === 0) return undefined
    if (i === picked) return i === prev ? 'bob' : 'hit'
    return i === prev ? 'drop' : 'wave'
  }
  const g = geometry(size)
  return (
    <span
      aria-hidden
      className="slips"
      data-loading={loading || undefined}
      style={
        { width: size, height: size, '--size': size, '--lift': `${g.lift}px` } as CSSProperties
      }
    >
      {SLIPS.map((i) => (
        <span
          key={i}
          className="slip"
          data-on={(!loading && i === picked) || undefined}
          style={
            {
              left: g.left + i * g.step,
              top: g.top,
              width: g.width,
              height: g.height,
              '--distance': Math.abs(i - picked),
              '--order': SLIPS.length - 1 - i,
            } as CSSProperties
          }
          onClick={
            loading ? undefined : () => setState({ picked: i, prev: picked, clicks: clicks + 1 })
          }
        >
          <span key={clicks} className="slip-fx" data-fx={fx(i)} />
        </span>
      ))}
    </span>
  )
}

/** 字标“管策智研”右接 LENS 铭牌（墨色实底、侧栏底色字），只用于侧栏顶部。 */
export function Wordmark({ height }: { height: number }) {
  return (
    <svg
      viewBox={`0 0 ${wordmark.width} 1000`}
      width={(height * wordmark.width) / 1000}
      height={height}
      role="img"
      aria-label="管策智研 LENS"
      className="shrink-0"
    >
      <path d={wordmark.text} className="fill-foreground" />
      <rect {...wordmark.plate} className="fill-foreground" />
      <path d={wordmark.lens} className="fill-sidebar" />
    </svg>
  )
}
