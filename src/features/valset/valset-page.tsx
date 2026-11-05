import {
  CircleAlertIcon,
  DownloadIcon,
  Loader2Icon,
  PlayIcon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { TopBar } from '@/app/shell'
import { Button } from '@/components/ui/button'
import { LoadStatus } from '@/components/ui/load-status'
import { Tooltip } from '@/components/ui/tooltip'
import { FormatBlock } from '@/features/workspace/file-preview'
import { cn } from '@/lib/cn'
import { useRequest, type Loaded } from '@/lib/use-request'
import {
  cancelValsetJob,
  deleteValsetJob,
  listValsetJobs,
  readValsetJob,
  startValsetJob,
  VALSET_TEMPLATE_URL,
  valsetExportUrl,
} from '@/services/valset'
import type { ValsetJob, ValsetJobSummary, ValsetRow, ValsetStatus } from '@/types/valset'

const message = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback

/**
 * 验证集测试：上传“问题 | 预期答案”两列的 Excel，每题在独立会话中作答，完成后按组委会模板导出结果。
 * 任务保存在服务端，地址里的 job 指定查看哪个任务，默认最近一个。
 */
export function ValsetPage() {
  const [params, setParams] = useSearchParams()
  const [list, reloadList] = useRequest('valset-jobs', listValsetJobs)
  const jobId = params.get('job') ?? (list.status === 'done' ? list.value[0]?.id : undefined)
  return (
    <>
      <TopBar title="验证集测试" />
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex max-w-[52rem] flex-col gap-8 py-6">
          <Upload
            onStarted={(job) => {
              setParams({ job: job.id })
              reloadList()
            }}
          />
          {jobId && (
            <JobView
              key={jobId}
              id={jobId}
              onDeleted={() => {
                setParams({})
                reloadList()
                // 任务连同按钮消失，焦点交给上传区
                document.getElementById('valset-file')?.focus()
              }}
            />
          )}
          <History list={list} current={jobId} onRetry={reloadList} />
        </div>
      </div>
    </>
  )
}

const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified

/** 上传区：可选多个文件，列在下方，选中其中一个开始测试。列表只在页面内存里，离开页面即清空。 */
function Upload({ onStarted }: { onStarted: (job: ValsetJob) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [selected, setSelected] = useState<File>()
  const [error, setError] = useState<string>()
  const [starting, setStarting] = useState(false)
  const [dragging, setDragging] = useState(false)
  // 选中的文件被移除（含开始成功后移除）时落到第一个，选中状态只由列表推出
  const chosen = selected && files.includes(selected) ? selected : files[0]
  const add = (list: FileList | null | undefined) => {
    const picked = [...(list ?? [])]
    if (!picked.length) return
    const rejected = picked.filter((item) => !/\.xlsx$/i.test(item.name))
    const fresh = picked.filter(
      (item) => /\.xlsx$/i.test(item.name) && !files.some((old) => sameFile(old, item)),
    )
    setFiles([...files, ...fresh])
    if (fresh.length) setSelected(fresh.at(-1))
    setError(
      rejected.length
        ? `只能选择 .xlsx 格式的 Excel 文件（.xls 请先另存为 .xlsx），未加入：${rejected.map((item) => item.name).join('、')}`
        : undefined,
    )
  }
  const remove = (file: File) => {
    setFiles((current) => current.filter((item) => item !== file))
    // 移除按钮随行消失，焦点交给上传区
    document.getElementById('valset-file')?.focus()
  }
  const start = () => {
    const file = chosen
    if (!file || starting) return
    setStarting(true)
    setError(undefined)
    startValsetJob(file)
      .then(
        (job) => {
          setFiles((current) => current.filter((item) => item !== file))
          onStarted(job)
        },
        (failure: unknown) => setError(message(failure, '上传失败，请重试。')),
      )
      .finally(() => setStarting(false))
  }
  return (
    <section aria-labelledby="valset-upload" className="flex flex-col gap-3">
      <h2 id="valset-upload" className="text-ui-base font-semibold">
        上传验证集
      </h2>
      <label
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          add(event.dataTransfer.files)
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center transition-colors hover:border-border-hover hover:bg-hover has-focus-visible:ring-2 has-focus-visible:ring-ring',
          dragging && 'border-brand bg-accent',
        )}
      >
        <input
          id="valset-file"
          type="file"
          multiple
          aria-label="选择验证集文件"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(event) => {
            add(event.target.files)
            // 同一文件改过后可再次选择
            event.target.value = ''
          }}
        />
        <UploadIcon className="mb-1 size-5 text-foreground-subtle" aria-hidden />
        <span className="text-ui-base">拖入验证集文件，或点击选择（可多选）</span>
        <span className="text-ui-sm text-balance text-foreground-subtle">
          Excel（.xlsx），第一行为表头“问题”“预期答案”，最多 1000 条
        </span>
      </label>
      {files.length > 0 && (
        <ul aria-label="待测试的文件" className="flex flex-col gap-2">
          {files.map((file) => (
            <li
              key={`${file.name}\n${file.size}\n${file.lastModified}`}
              className="flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-card p-3 transition-colors hover:border-border-hover hover:bg-surface-hover has-checked:border-brand has-checked:bg-accent has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="radio"
                  name="valset-choice"
                  checked={file === chosen}
                  onChange={() => setSelected(file)}
                  className="size-4 shrink-0 accent-brand"
                />
                <FormatBlock format="xlsx" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-ui-base font-medium">{file.name}</span>
                  <span className="text-ui-sm text-foreground-subtlest">
                    {Math.ceil(file.size / 1024)} KB
                  </span>
                </span>
              </label>
              <Tooltip label="移除">
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => remove(file)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-4" />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-ui-caption text-destructive">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!chosen} aria-disabled={starting || undefined} onClick={start}>
          {starting ? <Loader2Icon className="animate-spin" aria-hidden /> : <PlayIcon />}
          开始测试
        </Button>
        <Button variant="outline" asChild>
          <a href={VALSET_TEMPLATE_URL} download>
            <DownloadIcon />
            下载模板
          </a>
        </Button>
      </div>
    </section>
  )
}

const STATE = { running: '执行中', done: '已完成', cancelled: '已取消' }
const STATUSES: ValsetStatus[] = ['正常', '超时', '失败', '已取消']

/** 一个任务的进度与逐题结果；执行中每 2 秒刷新。 */
function JobView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [job, setJob] = useState<ValsetJob>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const deleted = useRef(false)
  // 取消按钮随任务结束消失，焦点交给导出按钮
  const focusExport = useRef(false)
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      readValsetJob(id, abort.signal).then(
        (value) => {
          setJob(value)
          setError(undefined)
          if (value.state === 'running' || value.rows.some((row) => row.running))
            timer = setTimeout(load, 2000)
        },
        (failure: unknown) => {
          if (!abort.signal.aborted) setError(message(failure, '读取失败，请重试。'))
        },
      )
    void load()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [id, attempt])
  const retry = () => setAttempt((value) => value + 1)
  if (!job) return <LoadStatus loadingText="正在读取任务…" error={error} onRetry={retry} />
  const busy = job.state === 'running' || job.rows.some((row) => row.running)
  const cancel = () => {
    if (cancelling) return
    setCancelling(true)
    focusExport.current = true
    // 取消结果由刷新读取，进度只有一条写入路径
    cancelValsetJob(id)
      .then(retry, (failure: unknown) => {
        focusExport.current = false
        setError(message(failure, '取消失败，请重试。'))
      })
      .finally(() => setCancelling(false))
  }
  const remove = () => {
    if (deleting) return
    setDeleting(true)
    setDeleteError(undefined)
    deleteValsetJob(id)
      .then(
        () => {
          deleted.current = true
          setConfirming(false)
        },
        (failure: unknown) => setDeleteError(message(failure, '删除失败，请重试。')),
      )
      .finally(() => setDeleting(false))
  }
  const sessions = job.rows.filter((row) => row.sessionId).length
  const counts = STATUSES.map((status) => [
    status,
    job.rows.filter((row) => row.status === status).length,
  ])
  return (
    <section aria-labelledby="valset-job" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="valset-job" className="text-ui-base font-semibold wrap-anywhere">
            {job.name}
          </h2>
          <p className="text-ui-sm text-foreground-subtle wrap-anywhere">
            {new Date(job.createdAt).toLocaleString('zh-CN')} · 模型 {job.model} ·{' '}
            {STATE[job.state]}
          </p>
        </div>
        <div className="flex gap-2">
          {job.state === 'running' && (
            <Button variant="outline" aria-disabled={cancelling || undefined} onClick={cancel}>
              取消
            </Button>
          )}
          {!busy && (
            <Button
              variant="outline"
              onClick={() => {
                setDeleteError(undefined)
                setConfirming(true)
              }}
            >
              删除任务
            </Button>
          )}
          {busy ? (
            <Button disabled>
              <DownloadIcon />
              导出结果 Excel
            </Button>
          ) : (
            <Button asChild>
              <a
                href={valsetExportUrl(job.id)}
                download
                ref={(element) => {
                  if (element && focusExport.current) {
                    focusExport.current = false
                    element.focus()
                  }
                }}
              >
                <DownloadIcon />
                导出结果 Excel
              </a>
            </Button>
          )}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="验证集进度"
        aria-valuemin={0}
        aria-valuemax={job.total}
        aria-valuenow={job.finished}
        className="h-1 overflow-hidden rounded-full bg-tag"
      >
        <div
          className="h-full bg-primary transition-[width]"
          style={{ width: `${(job.finished / job.total) * 100}%` }}
        />
      </div>
      <p role="status" className="text-ui-caption text-foreground-subtle">
        已完成 {job.finished} / {job.total} 题
        {counts.map(([status, count]) => (count ? ` · ${status} ${count}` : ''))}
      </p>
      {error && <LoadStatus loadingText="" error={error} onRetry={retry} />}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[32rem] text-ui-caption">
          <thead className="border-b border-border text-left whitespace-nowrap text-foreground-subtle">
            <tr>
              <th scope="col" className="w-12 px-3 py-2 font-medium">
                序号
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                问题
              </th>
              <th scope="col" className="w-24 px-3 py-2 font-medium">
                状态
              </th>
              <th scope="col" className="w-20 px-3 py-2 text-right font-medium">
                耗时(秒)
              </th>
              <th scope="col" className="w-16 px-3 py-2 font-medium">
                会话
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {job.rows.map((row, index) => (
              <tr key={index} className="align-top">
                <td className="px-3 py-2 text-foreground-subtlest">{index + 1}</td>
                <td className="px-3 py-2">
                  <p className="line-clamp-2 wrap-anywhere" title={row.question}>
                    {row.question}
                  </p>
                  {row.error && (
                    <p className="text-ui-sm text-destructive wrap-anywhere">{row.error}</p>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <RowStatus row={row} />
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {row.seconds?.toFixed(1)}
                </td>
                <td className="px-3 py-2">
                  {row.sessionId && (
                    <Link
                      to={`/workspace/${row.sessionId}`}
                      aria-label={`查看第 ${index + 1} 题的会话`}
                      className="rounded-sm text-brand underline decoration-brand/40 underline-offset-2 outline-none hover:decoration-brand focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      查看
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DialogPrimitive.Root
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !deleting) setConfirming(false)
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
          <DialogPrimitive.Content
            role="alertdialog"
            onCloseAutoFocus={(event) => {
              // 删除后任务连同按钮消失，由页面安排焦点；取消时回到“删除任务”
              if (!deleted.current) return
              event.preventDefault()
              onDeleted()
            }}
            className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-popover-border bg-popover p-6 shadow-md"
          >
            <DialogPrimitive.Title className="text-ui-base font-semibold">
              删除验证集任务？
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-ui-base text-foreground-subtle wrap-anywhere">
              「{job.name}」的逐题结果和 {sessions} 个题目会话将永久删除，无法恢复。
            </DialogPrimitive.Description>
            {deleteError && (
              <p role="alert" className="text-ui-caption text-destructive">
                {deleteError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <DialogPrimitive.Close asChild>
                <Button variant="outline">取消</Button>
              </DialogPrimitive.Close>
              <Button aria-disabled={deleting || undefined} onClick={remove}>
                {deleting ? '删除中…' : '删除'}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </section>
  )
}

function RowStatus({ row }: { row: ValsetRow }) {
  if (row.running)
    return (
      <span className="flex items-center gap-1.5 text-foreground-subtle">
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        执行中
      </span>
    )
  if (!row.status) return <span className="text-foreground-subtlest">待执行</span>
  if (row.status === '超时' || row.status === '失败')
    return (
      <span className="flex items-center gap-1.5 text-destructive">
        <CircleAlertIcon className="size-3.5" aria-hidden />
        {row.status}
      </span>
    )
  return (
    <span className={row.status === '正常' ? undefined : 'text-foreground-subtle'}>
      {row.status}
    </span>
  )
}

function History({
  list,
  current,
  onRetry,
}: {
  list: Loaded<ValsetJobSummary[]>
  current?: string
  onRetry: () => void
}) {
  if (list.status !== 'done')
    return (
      <LoadStatus
        loadingText="正在读取历史任务…"
        error={list.status === 'error' ? list.message : undefined}
        onRetry={onRetry}
      />
    )
  if (list.value.length < 2) return null
  return (
    <section aria-labelledby="valset-history" className="flex flex-col gap-2">
      <h2 id="valset-history" className="text-ui-base font-semibold">
        历史任务
      </h2>
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {list.value.map((job) => (
          <li key={job.id}>
            <Link
              to={`?job=${job.id}`}
              aria-current={job.id === current ? 'page' : undefined}
              className="flex flex-col gap-0.5 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-selected"
            >
              <span className="text-ui-base font-medium wrap-anywhere">{job.name}</span>
              <span className="text-ui-sm text-foreground-subtlest">
                {new Date(job.createdAt).toLocaleString('zh-CN')} · {job.total} 题
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
