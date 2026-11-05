import type { SlidePlan, SlideSeg } from '@/types'

/** 一段文字；引用编号为朱红上标。链接只显示文字（内容来自模型，不可信） */
function Segs({ segs }: { segs: SlideSeg[] }) {
  return segs.map((seg, i) =>
    seg.sup ? (
      <sup key={i} className="text-seal">
        {seg.text}
      </sup>
    ) : (
      <span
        key={i}
        className={`${seg.bold ? 'font-bold' : ''} ${seg.italics ? 'italic' : ''} ${seg.strike ? 'line-through' : ''}`}
      >
        {seg.text}
      </span>
    ),
  )
}

const COLUMNS = ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4']

/** 一页正文，版式与导出的演示文稿一致（DESIGN.md“生成文件版式”） */
function Body({ page }: { page: Exclude<SlidePlan, { layout: 'cover' }> }) {
  if (page.layout === 'rows' && page.rows.length === 1)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-ui-sm font-bold text-seal">
          <Segs segs={page.rows[0].label} />
        </p>
        <p className="text-ui-lg">
          <Segs segs={page.rows[0].body} />
        </p>
      </div>
    )
  if (page.layout === 'rows')
    return (
      <dl className="grid grid-cols-[minmax(4rem,auto)_1fr] gap-x-4 text-ui-sm">
        {page.rows.map((row, i) => (
          <div
            key={i}
            className={`col-span-2 grid grid-cols-subgrid py-2 ${i ? 'border-t border-border' : ''}`}
          >
            <dt className="font-bold">
              <Segs segs={row.label} />
            </dt>
            <dd className="text-foreground-subtle">
              <Segs segs={row.body} />
            </dd>
          </div>
        ))}
      </dl>
    )
  if (page.layout === 'cards')
    return (
      <ol className={`grid gap-2 ${COLUMNS[page.rows.length]}`}>
        {page.rows.map((row, i) => (
          <li key={i} className="flex flex-col gap-1.5 rounded-sm bg-tag p-3">
            <span className="flex size-5 items-center justify-center rounded-full bg-seal text-ui-xs font-bold text-seal-foreground">
              {i + 1}
            </span>
            <span className="text-ui-sm font-bold">
              <Segs segs={row.label} />
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              <Segs segs={row.body} />
            </span>
          </li>
        ))}
      </ol>
    )
  if (page.layout === 'table')
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-ui-xs">
          <thead>
            <tr>
              {page.rows[0].map((cell, j) => (
                <th key={j} className="border border-border bg-seal px-2 py-1 text-seal-foreground">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.slice(1).map((row, r) => (
              <tr key={r}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={`border border-border px-2 py-1 whitespace-pre-line ${page.rows[0].length >= 3 && !j ? 'bg-tag font-bold' : ''}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  return (
    <ul
      className={`flex flex-col gap-1 ${page.layout === 'sources' ? 'text-ui-xs' : 'text-ui-sm'}`}
    >
      {page.lines.map((line, i) => (
        <li
          key={i}
          className="flex gap-1.5"
          style={{ paddingInlineStart: `${line.level * 1.25}em` }}
        >
          {line.bullet !== undefined && (
            <span className="shrink-0 text-foreground-subtle">
              {line.bullet === true ? '•' : `${line.bullet}.`}
            </span>
          )}
          <span>
            <Segs segs={line.segs} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** 演示文稿预览：与导出文件同一份分页，按页画成 16:9 幻灯片纵向排列；内容多时幻灯片随内容加高 */
export function Slides({ text }: { text: string }) {
  let slides: SlidePlan[]
  try {
    slides = (JSON.parse(text) as { slides: SlidePlan[] }).slides
  } catch {
    return <p className="text-ui-caption text-destructive">预览内容无法读取，请下载文件查看。</p>
  }
  return (
    <ol aria-label="幻灯片" className="mx-auto flex max-w-3xl flex-col gap-4">
      {slides.map((page, n) => (
        <li key={n} aria-label={`第 ${n + 1} 页`}>
          {page.layout === 'cover' ? (
            <div className="flex aspect-video flex-col justify-center gap-2 rounded-sm bg-foreground px-[8%] text-background shadow-sm">
              <span className="text-ui-xs tracking-widest text-seal">汇报材料</span>
              <h2 className="text-ui-xl font-bold">{page.title}</h2>
              {page.subtitle && <p className="text-ui-base opacity-80">{page.subtitle}</p>}
              {page.lines.map((line, i) => (
                <p key={i} className="text-ui-xs opacity-60">
                  <Segs segs={line} />
                </p>
              ))}
            </div>
          ) : (
            <div className="flex aspect-video flex-col gap-3 rounded-sm bg-card px-[5%] py-[3.5%] shadow-sm">
              <div>
                {page.kicker && <p className="text-ui-xs text-seal">{page.kicker}</p>}
                <h2 className="text-ui-lg font-bold">{page.title}</h2>
              </div>
              <div className="min-h-0 flex-1">
                <Body page={page} />
              </div>
              {page.notes.map((line, i) => (
                <p key={i} className="text-ui-xs text-foreground-subtle">
                  <Segs segs={line} />
                </p>
              ))}
              <div className="flex items-end justify-between gap-4 text-ui-xs text-foreground-subtlest">
                <span>{page.foot}</span>
                <span className="shrink-0">{n + 1}</span>
              </div>
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}
