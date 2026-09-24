import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import ShellExecutor, {
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellExecution,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import FileSystem, {
  FsError,
  type FsTarget,
  type FsInfo,
  type FsPathInfo,
  type FsDirEntry,
  type FsWriteIntent,
  type FsWriteOutcome,
  type FsEditRequest,
  type FsEditOutcome,
} from '@deepseek-ai/dsh-fs'
import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Sandbox, ExecutionHandlers, RunCommandOpts } from '@alibaba-group/opensandbox'
import { Sandboxes, sandboxError } from './sandboxes.ts'
import { Artifacts } from './artifacts.ts'

/** All paths are Linux paths inside the execution environment, never host paths. */
const cwd = (value?: string) =>
  value?.startsWith('/') ? posix.normalize(value.replaceAll('\\', '/')) : '/workspace'

// execd emits lines without their terminators (including the final partial line).
const outputLine = (text: string) => (text.endsWith('\n') ? text : text + '\n')

export class SessionSandbox {
  mutation = Promise.resolve()
  manager: Sandboxes
  userId: string
  sessionId: string
  legacyCwd?: string
  constructor(manager: Sandboxes, userId: string, sessionId: string, legacyCwd?: string) {
    this.manager = manager
    this.userId = userId
    this.sessionId = sessionId
    this.legacyCwd = legacyCwd
  }
  cwd(path?: string) {
    if (
      this.legacyCwd &&
      path?.startsWith(this.legacyCwd) &&
      (path.length === this.legacyCwd.length || /[/\\]/.test(path[this.legacyCwd.length]))
    )
      return posix.join('/workspace', path.slice(this.legacyCwd.length).replaceAll('\\', '/'))
    return cwd(path)
  }
  use<T>(signal: AbortSignal | undefined, work: (remote: Sandbox) => Promise<T>) {
    return this.manager.use(this.userId, this.sessionId, signal, work)
  }
  stop() {
    return this.manager.stop(this.userId, this.sessionId)
  }
  async command(
    command: string[],
    options: RunCommandOpts,
    handlers: ExecutionHandlers,
    signal?: AbortSignal,
  ) {
    return this.use(signal, async (remote) => {
      let stopping: Promise<void> | undefined
      const stop = () => {
        stopping ??= this.stop()
        void stopping.catch(() => {})
      }
      signal?.addEventListener('abort', stop, { once: true })
      try {
        signal?.throwIfAborted()
        // Destroying this session's container also stops detached process groups.
        const result = await remote.commands.run(
          command,
          { uid: 1000, gid: 1000, ...options },
          handlers,
        )
        if (stopping) await stopping
        signal?.throwIfAborted()
        return result
      } catch (e) {
        if (stopping) await stopping
        else await this.stop()
        if (signal?.aborted) throw signal.reason
        throw e
      } finally {
        signal?.removeEventListener('abort', stop)
      }
    })
  }
  async rpc<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    // Serialize native filesystem mutations across worker processes, as dsh-fs-local does in-process.
    const previous = this.mutation
    const gate = Promise.withResolvers<void>()
    this.mutation = gate.promise
    await previous
    try {
      return await this.use(signal, async (remote) => {
        const request = `/tmp/gczy-${randomUUID()}.json`
        await remote.files.writeFiles([
          {
            path: request,
            data: JSON.stringify({ method, args }),
            // OpenSandbox expects octal digits encoded as a decimal number, not a JS bitmask.
            mode: 600,
            owner: 'node',
            group: 'node',
          },
        ])
        try {
          let output = ''
          const result = await this.command(
            ['node', '/opt/gczy/fs-worker.mjs', request],
            { workingDirectory: '/workspace' },
            {
              skipAccumulation: true,
              onStdout: (message) => {
                output += message.text
                if (Buffer.byteLength(output) > 72 * 1024 * 1024)
                  throw new Error('文件操作返回内容过大。')
              },
            },
            signal,
          )
          if (result.exitCode !== 0) throw sandboxError()
          const response = JSON.parse(output)
          if (response.error) throw new FsError(response.error.message, response.error.code)
          return response.value as T
        } finally {
          await remote.files.deleteFiles([request]).catch(() => {})
        }
      })
    } finally {
      gate.resolve()
    }
  }
  async writeFile(name: string, data: Uint8Array, signal?: AbortSignal) {
    await this.rpc(
      'writeBytes',
      [`/workspace/${name}`, Buffer.from(data).toString('base64')],
      signal,
    )
  }
  async exportFile(path: string, files: Artifacts, signal?: AbortSignal) {
    const target = await this.rpc<FsTarget>('resolve', [path, { cwd: '/workspace' }], signal)
    if (!target.displayPath.startsWith('/workspace/'))
      throw new Error('只能导出当前会话工作区内的文件。')
    const bytes = await this.rpc<string>('readBytes', [target, null, 50 * 1024 * 1024], signal)
    return files.save(
      this.userId,
      this.sessionId,
      posix.basename(target.displayPath),
      Buffer.from(bytes, 'base64'),
      signal,
    )
  }
  async readOffice(data: Uint8Array, format: 'docx' | 'xlsx', signal?: AbortSignal) {
    return this.use(signal, async (remote) => {
      const entry = this.manager.entries.get(this.sessionId)
      const path = `/tmp/gczy-office-${randomUUID()}.${format}`
      await this.rpc('writeBytes', [path, Buffer.from(data).toString('base64')], signal)
      let output = ''
      const code = `import sys
if sys.argv[2] == 'docx':
    from docx import Document
    lines = (p.text for p in Document(sys.argv[1]).paragraphs)
else:
    from openpyxl import load_workbook
    book = load_workbook(sys.argv[1], read_only=True, data_only=True)
    lines = ('\\t'.join(str(c) if c is not None else '' for c in row) for row in book.active.iter_rows(values_only=True))
remaining = 32000
for line in lines:
    text = (line + '\\n')[:remaining]
    sys.stdout.write(text)
    remaining -= len(text)
    if remaining <= 0:
        sys.stdout.write('\\n[内容已截断]')
        break
`
      try {
        const result = await this.command(
          ['python3', '-c', code, path, format],
          { workingDirectory: '/workspace' },
          {
            skipAccumulation: true,
            onStdout: (message) => {
              output = (output + outputLine(message.text)).slice(0, 32100)
            },
          },
          signal,
        )
        if (result.exitCode !== 0)
          throw new Error('沙箱无法读取此 Office 文件，请检查格式或文件内容。')
        return output
      } finally {
        // Cleanup through the current lease only; never recreate a stopped container for a temp file.
        if (entry && this.manager.entries.get(this.sessionId) === entry && !entry.fenced)
          await remote.files.deleteFiles([path]).catch(() => {})
      }
    })
  }
}

class RemoteFileSystem extends FileSystem {
  session: SessionSandbox
  constructor(ctx: Context, session: SessionSandbox) {
    super(ctx)
    this.session = session
  }
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
    return this.session.rpc<FsTarget>(
      'resolve',
      [path, { cwd: this.session.cwd(opts?.cwd) }],
      opts?.signal,
    )
  }
  processPath(target: FsTarget) {
    return target.displayPath
  }
  fileUrl(target: FsTarget) {
    return `file://${target.displayPath.split('/').map(encodeURIComponent).join('/')}`
  }
  contains(parent: FsTarget, child: FsTarget) {
    return (
      child.targetKey === parent.targetKey ||
      child.targetKey.startsWith(parent.targetKey.replace(/\/$/, '') + '/')
    )
  }
  stat(target: FsTarget, signal?: AbortSignal) {
    return this.session.rpc<FsInfo | undefined>('stat', [target], signal)
  }
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    return this.session.rpc<FsPathInfo | undefined>(
      'lstat',
      [path, { cwd: this.session.cwd(opts?.cwd) }],
      signal,
    )
  }
  readText(target: FsTarget, signal?: AbortSignal) {
    return this.session.rpc<string>('readText', [target], signal)
  }
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) {
    return Buffer.from(
      await this.session.rpc<string>('readBytes', [target, null, maxBytes], signal),
      'base64',
    )
  }
  async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ) {
    return Buffer.from(
      await this.session.rpc<string>('readByteRange', [target, range], signal),
      'base64',
    )
  }
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const readRange = this.readByteRange.bind(this)
    return (async function* () {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for (let offset = 0; ; offset += 65536) {
        const bytes = await readRange(target, { offset, length: 65536 }, signal)
        if (bytes.includes(0)) throw new FsError('文件不是文本。', 'FS_NOT_TEXT')
        yield decoder.decode(bytes, { stream: true })
        if (bytes.length < 65536) {
          yield decoder.decode()
          break
        }
      }
    })()
  }
  listDir(target: FsTarget, signal?: AbortSignal) {
    return this.session.rpc<FsDirEntry[]>('listDir', [target], signal)
  }
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal) {
    return this.session.rpc<FsWriteOutcome>('writeText', [target, content, expected], signal)
  }
  editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsInfo['version'] },
    signal?: AbortSignal,
  ) {
    return this.session.rpc<FsEditOutcome>('editText', [target, edit, expected], signal)
  }
}

export class RemoteShell extends ShellExecutor {
  processes = new Set<ShellExecution>()
  session: SessionSandbox
  constructor(ctx: Context, session: SessionSandbox) {
    super(ctx)
    this.session = session
    ctx.effect(() => async () => {
      for (const process of this.processes) process.kill()
      await Promise.all([...this.processes].map((process) => process.done))
    })
  }
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...request,
      workdir: this.session.cwd(request.workdir),
      timeoutMs: request.timeoutMs ?? 120000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024,
      sandboxPolicy: undefined,
    }
  }
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    spec.signal?.throwIfAborted()
    const abort = new AbortController()
    let reason: 'aborted' | 'timedOut' | undefined
    const cancel = (cause: typeof reason) => {
      if (!reason) {
        reason = cause
        abort.abort()
      }
    }
    const onAbort = () => cancel('aborted')
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    const timer =
      spec.onExpiry === 'kill' ? setTimeout(() => cancel('timedOut'), spec.timeoutMs) : undefined
    const capture = (cap: number) => {
      let bytes = Buffer.alloc(0),
        total = 0,
        cursor = 0
      return {
        append(text: string) {
          const next = Buffer.from(text)
          total += next.length
          const all = Buffer.concat([bytes, next])
          bytes = all.subarray(Math.max(0, all.length - cap))
        },
        get output() {
          return { text: bytes.toString(), truncated: total > bytes.length }
        },
        readFrom(offset: number) {
          const base = total - bytes.length
          return {
            text: bytes.subarray(Math.max(0, offset - base)).toString(),
            nextOffset: total,
            lossy: offset < base,
          }
        },
        read() {
          const read = this.readFrom(cursor)
          cursor = read.nextOffset
          return read
        },
      }
    }
    const stdout = capture(spec.stdoutMaxBytes),
      stderr = capture(1024 * 1024)
    const settled = Promise.withResolvers<void>()
    const process: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: settled.promise,
      observed: { stdout, stderr },
      kill: () => {
        if (process.status !== 'running') return false
        cancel('aborted')
        return true
      },
      readOutput: () => {
        const out = stdout.read(),
          err = stderr.read()
        return {
          delta: out.text + (err.text ? `\n[stderr]\n${err.text}` : ''),
          lossy: out.lossy || err.lossy,
        }
      },
      result: () => result,
    }
    const result: Promise<ShellRunResult> = (async () => {
      try {
        // Never copy process.env or DSH host paths into the untrusted environment.
        const execution = await this.session.command(
          ['bash', '-c', spec.command],
          { workingDirectory: spec.workdir },
          {
            skipAccumulation: true,
            onStdout: (m) => stdout.append(outputLine(m.text)),
            onStderr: (m) => stderr.append(outputLine(m.text)),
          },
          abort.signal,
        )
        process.exitCode = execution.exitCode ?? null
        if (execution.error && execution.exitCode === null) stderr.append(execution.error.value)
      } catch (error) {
        if (
          !reason ||
          (error instanceof Error && 'code' in error && error.code === 'SANDBOX_UNAVAILABLE')
        )
          throw sandboxError()
      } finally {
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        process.status = reason ? 'killed' : 'completed'
        process.signal = reason ? 'SIGKILL' : null
        this.processes.delete(process)
      }
      return {
        exitCode: process.exitCode,
        signal: process.signal,
        timedOut: reason === 'timedOut',
        aborted: reason === 'aborted',
        timeoutMs: spec.timeoutMs,
        stdout: stdout.output,
        stderr: stderr.output,
      }
    })()
    void result.then(
      () => settled.resolve(),
      () => {
        process.status = 'killed'
        settled.resolve()
      },
    )
    this.processes.add(process)
    return process
  }
}

export async function registerSandbox(ctx: Context, session: SessionSandbox, files: Artifacts) {
  const scope = ctx.isolate('shell').isolate('fs').isolate('shellEnv')
  await scope.plugin({
    name: 'session-sandbox',
    apply: (inner: Context) => {
      new RemoteShell(inner, session)
      new RemoteFileSystem(inner, session)
    },
  })
  await scope.plugin(ShellEnv, { dshHome: '/workspace/.dsh' })
  await scope.plugin(BashTool, { enableRunInBackground: false })
  await scope.plugin(FileTools)
  scope.tools.register(
    defineTool({
      name: 'export_file',
      description:
        '把 /workspace 中已生成的文件发布为会话下载附件；支持任意文件格式。只有成功返回附件后才声称用户可下载。',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async (args, exec) =>
        JSON.stringify(await session.exportFile(args.path, files, exec.signal)),
    }),
  )
}
