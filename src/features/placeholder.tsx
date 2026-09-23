/** 未实现页面的占位：明确说明尚未实现，不显示假功能。 */
export function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-card-border bg-card p-4">
        <h2 className="text-ui-base font-medium">{title}</h2>
        <p className="mt-2 text-ui-base text-foreground-subtle">{description}</p>
      </div>
    </div>
  )
}
