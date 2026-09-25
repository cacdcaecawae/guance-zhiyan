import type { KeyboardEvent, PointerEvent } from 'react'
import { cn } from '@/lib/cn'

interface ResizeHandleProps {
  /** vertical：分隔左右两栏，沿 x 拖动；horizontal：分隔上下，沿 y 拖动 */
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  /** 向左 / 向上拖动时变大（如贴底输入框顶部的把手） */
  invert?: boolean
  label: string
  className?: string
  /** 元素实际显示的尺寸；布局可能把它压得小于 value，拖动与方向键从实际尺寸起算，避免无反应的一段 */
  measure?: () => number
}

/** 可拖动的分隔条：指针拖动与方向键都能调整尺寸，Home / End 到最小 / 最大。 */
export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  onChange,
  invert = false,
  label,
  className,
  measure,
}: ResizeHandleProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)))
  const sign = invert ? -1 : 1
  const current = () => (measure ? Math.round(measure()) : value)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const axis = (e: { clientX: number; clientY: number }) =>
      orientation === 'vertical' ? e.clientX : e.clientY
    const start = axis(event)
    const from = current()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (e: globalThis.PointerEvent) => onChange(clamp(from + sign * (axis(e) - start)))
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowRight: 16,
      ArrowDown: 16,
      ArrowLeft: -16,
      ArrowUp: -16,
    }
    const step = steps[event.key]
    const next =
      event.key === 'Home' ? min : event.key === 'End' ? max : step && current() + sign * step
    if (next === undefined) return
    event.preventDefault()
    onChange(clamp(next))
  }
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
        orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
        className,
      )}
    />
  )
}
