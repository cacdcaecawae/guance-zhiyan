import { useState, type CSSProperties } from 'react'
import { wordmark } from './logo-glyphs'

// 标志：一束竹简，抽出的一枚为朱红（“策”本义为竹简，也指运筹的筹策）。颜色取 seal 与 foreground-subtlest，随主题切换。
// 竹简几何以 48×48 为基准、按百分比定位，任意尺寸等比缩放；动效写在 globals.css 的 .slips。与 public/favicon.svg 同形。

const SLIPS = [0, 1, 2, 3, 4, 5, 6]
const MIDDLE = 3

type Fx = 'hit' | 'bob' | 'drop' | 'wave'

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
  return (
    <span
      aria-hidden
      className="slips"
      data-loading={loading || undefined}
      style={{ width: size, height: size, '--size': size } as CSSProperties}
    >
      {SLIPS.map((i) => (
        <span
          key={i}
          className="slip"
          data-on={(!loading && i === picked) || undefined}
          style={
            {
              left: `${((3.5 + 6 * i) / 48) * 100}%`,
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
