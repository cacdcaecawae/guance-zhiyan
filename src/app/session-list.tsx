import * as DialogPrimitive from '@radix-ui/react-dialog'
import { CircleIcon, EllipsisIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { NavLink, useMatch, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { deleteSession, updateSession, useResearch } from '@/services/research'
import type { SessionSummary } from '@/types'

const reason = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback
const actions = (id: string) => `[data-actions="${id}"]`

/** 侧栏研究记录：置顶的单独成组；每条可置顶、重命名和删除。 */
export function SessionList({ onNavigate }: { onNavigate?: () => void }) {
  const { sessions } = useResearch()
  const [error, setError] = useState<string | null>(null)
  // 关闭后保留目标：关闭过程中的文字与焦点交还都还要用到它
  const [target, setTarget] = useState<{ session: SessionSummary; neighbor?: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deleted = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const current = useMatch('/workspace/:id')?.params.id
  // 删除等待期间用户可能已导航到别处；删完时按最新路由判断，不用点击时的闭包
  const latest = useRef(current)
  useEffect(() => {
    latest.current = current
  })
  const focus = (selector: string) => list.current?.querySelector<HTMLElement>(selector)?.focus()

  const pin = async (session: SessionSummary) => {
    setError(null)
    try {
      await updateSession(session.id, { pinned: !session.pinned })
      // 换组会重新挂载这一行，焦点掉回页面；提交更新后还给它的操作按钮
      flushSync(() => {})
      if (document.activeElement === document.body) focus(actions(session.id))
    } catch (failure) {
      setError(reason(failure, '置顶失败，请重试。'))
    }
  }
  const rename = (session: SessionSummary, title: string) => {
    setError(null)
    updateSession(session.id, { title }).catch((failure: unknown) =>
      setError(reason(failure, '重命名失败，请重试。')),
    )
  }
  const confirm = (session: SessionSummary) => {
    const index = sessions.findIndex((s) => s.id === session.id)
    deleted.current = false
    setDeleteError(null)
    setTarget({ session, neighbor: (sessions[index + 1] ?? sessions[index - 1])?.id })
    setOpen(true)
  }
  const remove = async () => {
    if (!target || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // 已删除但未能完全清理时同样离开该会话，提示改放到侧栏
      const warning = await deleteSession(target.session.id)
      deleted.current = true
      if (latest.current === target.session.id) navigate('/workspace')
      setOpen(false)
      if (warning) setError(warning)
    } catch (failure) {
      setDeleteError(reason(failure, '删除失败，请重试。'))
    } finally {
      setDeleting(false)
    }
  }

  const groups = [
    { label: '置顶', items: sessions.filter((s) => s.pinned) },
    { label: '研究记录', items: sessions.filter((s) => !s.pinned) },
  ].filter((group) => group.items.length || group.label === '研究记录')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {error && (
        <p role="alert" className="px-2 text-ui-caption text-destructive">
          {error}
        </p>
      )}
      <div ref={list} className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {groups.map(({ label, items }) => (
          <div key={label} className="flex flex-col gap-1">
            <div className="px-2 text-ui-sm tracking-widest text-foreground-subtlest">{label}</div>
            <ul aria-label={label} className="flex flex-col gap-0.5">
              {items.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  onNavigate={onNavigate}
                  onPin={pin}
                  onRename={rename}
                  onDelete={confirm}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!next && !deleting) setOpen(false)
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
          <DialogPrimitive.Content
            role="alertdialog"
            onCloseAutoFocus={(e) => {
              // 取消时回到这一行的操作按钮；删除后交给相邻的一行，没有相邻的一行时交给“新建研究”
              e.preventDefault()
              const next = deleted.current ? target?.neighbor : target?.session.id
              if (next) focus(deleted.current ? `a[href="/workspace/${next}"]` : actions(next))
              else
                list.current
                  ?.closest('nav')
                  ?.querySelector<HTMLElement>('a[href="/workspace"]')
                  ?.focus()
            }}
            className="fixed top-1/2 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border border-popover-border bg-popover p-5 shadow-md"
          >
            <DialogPrimitive.Title className="text-ui-base font-semibold">
              删除研究记录？
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-ui-base text-foreground-subtle">
              「{target?.session.title}」的问答和会话文件将永久删除，无法恢复。
            </DialogPrimitive.Description>
            {deleteError && (
              <p role="alert" className="text-ui-caption text-destructive">
                {deleteError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <DialogPrimitive.Close asChild>
                <Button variant="outline" className="rounded-md">
                  取消
                </Button>
              </DialogPrimitive.Close>
              <Button className="rounded-md" aria-disabled={deleting} onClick={remove}>
                {deleting ? '删除中…' : '删除'}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  )
}

function SessionItem({
  session,
  onNavigate,
  onPin,
  onRename,
  onDelete,
}: {
  session: SessionSummary
  onNavigate?: () => void
  onPin: (session: SessionSummary) => void
  onRename: (session: SessionSummary, title: string) => void
  onDelete: (session: SessionSummary) => void
}) {
  const [editing, setEditing] = useState(false)
  const link = useRef<HTMLAnchorElement>(null)
  // 选了重命名或删除，焦点交给输入框或确认框，菜单关闭时不还给操作按钮
  const handoff = useRef(false)
  const done = (value: string | null, refocus: boolean) => {
    flushSync(() => setEditing(false))
    if (refocus) link.current?.focus()
    const title = value?.trim()
    if (title && title !== session.title) onRename(session, title)
  }

  return (
    <li className="group relative">
      {editing ? (
        <RenameInput title={session.title} onDone={done} />
      ) : (
        <NavLink
          ref={link}
          to={`/workspace/${session.id}`}
          className={({ isActive }) =>
            cn(
              'flex h-8 min-w-0 items-center gap-2 rounded-md pr-8 pl-2 text-ui-base outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-selected font-medium text-foreground'
                : 'text-foreground-subtle group-hover:bg-hover',
            )
          }
          title={session.title}
          onClick={onNavigate}
        >
          {({ isActive }) => (
            <>
              {/* 与导航图标同列：置顶为图钉，其余为圆圈；当前会话用朱红标记 */}
              <span
                aria-hidden
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center',
                  isActive ? 'text-seal' : 'text-foreground-subtlest',
                )}
              >
                {session.pinned ? (
                  <PinIcon className="size-3.5" />
                ) : (
                  <CircleIcon
                    strokeWidth={3}
                    className={cn('size-2.5', isActive && 'fill-current')}
                  />
                )}
              </span>
              <span className="truncate">{session.title}</span>
            </>
          )}
        </NavLink>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-actions={session.id}
            aria-label="更多操作"
            className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-hover data-[state=open]:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
          >
            <EllipsisIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            onCloseAutoFocus={(e) => {
              if (handoff.current) e.preventDefault()
              handoff.current = false
            }}
          >
            <DropdownMenuItem onSelect={() => onPin(session)}>
              {session.pinned ? <PinOffIcon /> : <PinIcon />}
              {session.pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                handoff.current = true
                setEditing(true)
              }}
            >
              <PencilIcon />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                handoff.current = true
                onDelete(session)
              }}
            >
              <Trash2Icon />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}

/** 回车保存，Esc 取消，失焦保存；只结算一次（卸载时可能再触发失焦）。 */
function RenameInput({
  title,
  onDone,
}: {
  title: string
  onDone: (title: string | null, refocus: boolean) => void
}) {
  const settled = useRef(false)
  const settle = (value: string | null, refocus: boolean) => {
    if (settled.current) return
    settled.current = true
    onDone(value, refocus)
  }
  return (
    <input
      autoFocus
      defaultValue={title}
      maxLength={80}
      aria-label="重命名研究记录"
      data-own-escape
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          settle(e.currentTarget.value, true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          settle(null, true)
        }
      }}
      onBlur={(e) => settle(e.currentTarget.value, false)}
      className="h-8 w-full min-w-0 rounded-md border border-input-border-focused bg-input px-2 text-ui-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  )
}
