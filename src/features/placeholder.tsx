import { Seal } from '@/app/logo'

/** 未上线页面的占位：写“敬请期待”并说明将提供什么，不显示假功能。 */
export function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span aria-hidden>
          <Seal size={44} />
        </span>
        <h2 className="font-serif text-ui-xl font-semibold tracking-widest">{title}</h2>
        <p className="text-ui-base text-foreground-subtle">{description}</p>
      </div>
    </div>
  )
}
