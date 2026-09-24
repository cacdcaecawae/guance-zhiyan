import {
  ConnectionConfig,
  Sandbox,
  SandboxApiException,
  type SandboxCreateOptions,
} from '@alibaba-group/opensandbox'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { Store } from './store.ts'
import { isIP } from 'node:net'

export interface SandboxConfig {
  endpoint: string
  apiKey: string
  image: string
  capacity: number
  cpu: string
  memory: string
  idleSeconds: number
  denyCidrs?: string[]
}
export function sandboxConfig(env = process.env): SandboxConfig | undefined {
  if (!env.SANDBOX_URL?.trim()) return undefined
  const endpoint = new URL(env.SANDBOX_URL)
  const capacity = Number(env.SANDBOX_CAPACITY ?? 4)
  const idleSeconds = Number(env.SANDBOX_IDLE_SECONDS ?? 300)
  const denyCidrs = (env.SANDBOX_DENY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (
    denyCidrs.some((cidr) => {
      const [ip, prefix, extra] = cidr.split('/')
      return (
        extra !== undefined ||
        isIP(ip) !== 4 ||
        (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > 32))
      )
    })
  )
    throw new Error('SANDBOX_DENY_CIDRS 必须为 IPv4 地址或 CIDR。')
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    !env.SANDBOX_API_KEY?.trim() ||
    !env.SANDBOX_IMAGE?.trim() ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    !Number.isSafeInteger(idleSeconds) ||
    idleSeconds < 60
  )
    throw new Error('沙箱配置无效：检查 URL、API_KEY、IMAGE、CAPACITY 与 IDLE_SECONDS。')
  return {
    endpoint: endpoint.href,
    apiKey: env.SANDBOX_API_KEY,
    image: env.SANDBOX_IMAGE,
    capacity,
    idleSeconds,
    denyCidrs,
    cpu: env.SANDBOX_CPU ?? '1',
    memory: env.SANDBOX_MEMORY ?? '1Gi',
  }
}
export const sandboxError = () =>
  new HarnessError('沙箱服务不可用，请检查部署与连接后重试。', 'SANDBOX_UNAVAILABLE')
const missing = (e: unknown) => e instanceof SandboxApiException && e.statusCode === 404
type Entry = {
  remote: Promise<Sandbox>
  users: number
  used: number
  fenced?: boolean
  retiring?: Promise<void>
}

/** ponytail: one backend process owns these leases; distributed ownership is needed before scaling out. */
export class Sandboxes {
  entries = new Map<string, Entry>()
  wake = new Set<() => void>()
  closed = false
  connection: ConnectionConfig
  timer?: ReturnType<typeof setInterval>
  sweeping = false
  store: Store
  config: SandboxConfig
  constructor(store: Store, config: SandboxConfig) {
    this.store = store
    this.config = config
    this.connection = new ConnectionConfig({
      domain: config.endpoint,
      apiKey: config.apiKey,
      useServerProxy: true,
      disableMetrics: true,
    })
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS sandboxes(session_id TEXT PRIMARY KEY REFERENCES sessions(id), remote_id TEXT NOT NULL)',
    )
  }
  async init() {
    // A restarted application must stop previous executions before mounting their volumes again.
    const rows = this.store.db.prepare('SELECT session_id, remote_id FROM sandboxes').all()
    for (const row of rows) {
      let remote: Sandbox | undefined
      try {
        remote = await Sandbox.connect({
          sandboxId: String(row.remote_id),
          connectionConfig: this.connection,
          skipHealthCheck: true,
        })
        await remote.kill()
      } catch (e) {
        if (!missing(e)) throw sandboxError()
      } finally {
        await remote?.close()
      }
      this.store.db.prepare('DELETE FROM sandboxes WHERE session_id=?').run(row.session_id!)
    }
    this.timer = setInterval(() => {
      void this.sweep()
    }, 30_000)
    this.timer.unref()
    return this
  }
  creation(sessionId: string): SandboxCreateOptions {
    return {
      connectionConfig: this.connection,
      image: this.config.image,
      readyTimeoutSeconds: 120,
      timeoutSeconds: Math.max(600, this.config.idleSeconds * 2),
      resource: { cpu: this.config.cpu, memory: this.config.memory },
      metadata: { application: 'guance-zhiyan', session: sessionId },
      volumes: [
        {
          name: 'workspace',
          mountPath: '/workspace',
          pvc: {
            claimName: `gczy-${sessionId}`,
            createIfNotExists: true,
            deleteOnSandboxTermination: false,
          },
        },
      ],
      networkPolicy: {
        defaultAction: 'allow',
        egress: [
          { action: 'deny', target: '0.0.0.0/8' },
          { action: 'deny', target: '10.0.0.0/8' },
          { action: 'deny', target: '100.64.0.0/10' },
          { action: 'deny', target: '127.0.0.0/8' },
          { action: 'deny', target: '169.254.0.0/16' },
          { action: 'deny', target: '172.16.0.0/12' },
          { action: 'deny', target: '192.168.0.0/16' },
          { action: 'deny', target: '198.18.0.0/15' },
          { action: 'deny', target: '224.0.0.0/4' },
          { action: 'deny', target: '240.0.0.0/4' },
          ...(this.config.denyCidrs ?? []).map((target) => ({ action: 'deny' as const, target })),
        ],
      },
    }
  }
  changed() {
    for (const wake of this.wake) wake()
  }
  async wait(signal?: AbortSignal) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        this.wake.delete(done)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        this.wake.delete(done)
        reject(signal?.reason)
      }
      this.wake.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  async use<T>(
    userId: string,
    sessionId: string,
    signal: AbortSignal | undefined,
    work: (remote: Sandbox) => Promise<T>,
  ): Promise<T> {
    this.store.session(userId, sessionId)
    for (;;) {
      signal?.throwIfAborted()
      if (this.closed) throw sandboxError()
      let entry = this.entries.get(sessionId)
      if (entry?.fenced) {
        await this.retire(sessionId, entry)
        continue
      }
      if (!entry) {
        if (this.entries.size >= this.config.capacity) {
          const idle = [...this.entries]
            .filter(([, e]) => !e.users && !e.retiring)
            .sort((a, b) => a[1].used - b[1].used)[0]
          if (idle) {
            await this.retire(idle[0], idle[1])
            continue
          }
          await this.wait(signal)
          continue
        }
        entry = { users: 0, used: Date.now(), remote: this.create(sessionId) }
        this.entries.set(sessionId, entry)
      }
      entry.users++
      try {
        const remote = await entry.remote
        signal?.throwIfAborted()
        return await work(remote)
      } finally {
        entry.users--
        entry.used = Date.now()
        this.changed()
      }
    }
  }
  async create(sessionId: string) {
    try {
      const remote = await Sandbox.create(this.creation(sessionId))
      this.store.db
        .prepare('INSERT OR REPLACE INTO sandboxes VALUES(?, ?)')
        .run(sessionId, remote.id)
      return remote
    } catch {
      this.entries.delete(sessionId)
      this.changed()
      throw sandboxError()
    }
  }
  async retire(id: string, entry: Entry) {
    if (entry.retiring) return entry.retiring
    entry.fenced = true
    const retiring = (async () => {
      let remote: Sandbox
      try {
        remote = await entry.remote
      } catch {
        return
      }
      try {
        await remote.kill()
      } catch (e) {
        if (!missing(e)) throw sandboxError()
      }
      this.store.db.prepare('DELETE FROM sandboxes WHERE session_id=?').run(id)
      this.entries.delete(id)
      await remote.close()
    })()
    entry.retiring = retiring
    try {
      await retiring
    } finally {
      // A failed deletion stays fenced; retries may delete it, but no new command may use it.
      entry.retiring = undefined
      this.changed()
    }
  }
  async stop(userId: string, id: string) {
    this.store.session(userId, id)
    const entry = this.entries.get(id)
    if (entry) await this.retire(id, entry)
  }
  async sweep() {
    if (this.sweeping || this.closed) return
    this.sweeping = true
    try {
      for (const [id, entry] of this.entries) {
        if (entry.retiring) continue
        if (
          entry.fenced ||
          (!entry.users && Date.now() - entry.used >= this.config.idleSeconds * 1000)
        )
          await this.retire(id, entry)
        else await (await entry.remote).renew(Math.max(600, this.config.idleSeconds * 2))
      }
    } catch {
      console.warn('沙箱续期或回收失败，请检查 OpenSandbox 服务。')
    } finally {
      this.sweeping = false
    }
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    this.changed()
    const results = await Promise.allSettled(
      [...this.entries].map(([id, entry]) => this.retire(id, entry)),
    )
    if (results.some((r) => r.status === 'rejected')) throw sandboxError()
  }
}
