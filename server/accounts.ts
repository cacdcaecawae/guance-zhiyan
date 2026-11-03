import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { HttpError, Store } from './store.ts'
import type { Identity } from './auth.ts'

const COOKIE = 'gczy_session'
const TTL = 7 * 24 * 3600_000
// 滑动续期：距上次续期超过一天才写库并重发 Cookie，不在每个请求上写
const REFRESH = 24 * 3600_000
// 用户名只允许英文字母、数字与 _ . -，统一存为小写，登录时不区分大小写
function username(name: string) {
  const value = name.toLowerCase()
  if (!/^[a-z0-9_.-]{1,32}$/.test(value))
    throw new Error('用户名须为 1–32 个英文字母、数字、下划线、点或连字符。')
  return value
}
// N=2^15、r=8 约占 32 MiB 内存；参数随哈希保存，以后调高不影响旧密码
const COST = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const derive = (password: string, salt: Buffer, options: typeof COST) =>
  new Promise<Buffer>((done, fail) =>
    scrypt(password, salt, 32, options, (error, key) => (error ? fail(error) : done(key))),
  )
async function hash(password: string) {
  const salt = randomBytes(16)
  const key = await derive(password, salt, COST)
  return `scrypt:${COST.N}:${COST.r}:${COST.p}:${salt.toString('base64')}:${key.toString('base64')}`
}
async function verify(password: string, stored: string) {
  const [, N, r, p, salt, key] = stored.split(':')
  const expected = Buffer.from(key, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: COST.maxmem,
  })
  return timingSafeEqual(actual, expected)
}
// 用户名不存在时也算一次哈希，响应时间不暴露账号是否存在
let decoy: Promise<string> | undefined
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

const WINDOW = 15 * 60_000
const MAX_WAIT = 5 * 60_000
/**
 * 失败超过 free 次后，每次失败的等待时间从 2 秒起翻倍，最长 5 分钟；15 分钟没有失败就清零。
 * ponytail: 计数只在本进程内存中，重启清零；多进程部署时改存 SQLite。
 */
class Attempts {
  failures = new Map<string, { count: number; last: number }>()
  free: number
  constructor(free: number) {
    this.free = free
  }
  entry(key: string, now: number) {
    const entry = this.failures.get(key)
    return entry && now - entry.last < WINDOW ? entry : undefined
  }
  wait(key: string, now: number) {
    const entry = this.entry(key, now)
    if (!entry || entry.count <= this.free) return 0
    return entry.last + Math.min(MAX_WAIT, 1000 * 2 ** (entry.count - this.free)) - now
  }
  fail(key: string, now: number) {
    if (this.failures.size > 10_000)
      for (const [name, entry] of this.failures)
        if (now - entry.last >= WINDOW) this.failures.delete(name)
    this.failures.set(key, { count: (this.entry(key, now)?.count ?? 0) + 1, last: now })
  }
  forgive(key: string, now: number, all: boolean) {
    const entry = this.entry(key, now)
    if (all || !entry || entry.count <= 1) this.failures.delete(key)
    else entry.count--
  }
}

/** 服务器模式的本地账号：密码以加盐 scrypt 保存，登录状态保存在服务端，可随时撤销。 */
export class Accounts {
  db: Store['db']
  secure: boolean
  trustProxy: boolean
  byName = new Attempts(5)
  // 同一出口地址后可能有多人，放宽一些
  byAddress = new Attempts(30)
  constructor(store: Store, options: { secure?: boolean; trustProxy?: boolean } = {}) {
    this.db = store.db
    this.secure = options.secure ?? false
    this.trustProxy = options.trustProxy ?? false
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts(username TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS logins_account ON logins(username);
    `)
  }
  list() {
    return this.db.prepare('SELECT username, created FROM accounts ORDER BY username').all() as {
      username: string
      created: number
    }[]
  }
  /** 每次新建都分配新的内部身份：删除后同名重建的账号看不到原账号的研究记录。 */
  async add(name: string, password: string) {
    const value = await hash(checked(password))
    this.db
      .prepare('INSERT INTO accounts VALUES(?, ?, ?, ?)')
      .run(this.available(name), `account:${randomUUID()}`, value, Date.now())
    return name.toLowerCase()
  }
  /** 改密码同时让该账号所有已登录的浏览器退出。 */
  async passwd(name: string, password: string) {
    const username = this.existing(name)
    const value = await hash(checked(password))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE accounts SET hash=? WHERE username=?').run(value, username)
      this.db.prepare('DELETE FROM logins WHERE username=?').run(username)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return username
  }
  /** 删除账号并撤销其登录；研究记录留在数据目录中，但不再能访问。 */
  remove(name: string) {
    const username = this.existing(name)
    this.db.prepare('DELETE FROM accounts WHERE username=?').run(username)
    return username
  }
  exists(name: string) {
    return !!this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(name.toLowerCase())
  }
  /** 新用户名：格式有效且未被占用。 */
  available(name: string) {
    const value = username(name)
    if (this.exists(value)) throw new Error(`账号 ${value} 已存在。`)
    return value
  }
  existing(name: string) {
    const value = name.toLowerCase()
    if (!this.exists(value)) throw new Error(`账号 ${value} 不存在。`)
    return value
  }

  /** 只有显式配置 TRUST_PROXY 时才采信反向代理追加在 X-Forwarded-For 末尾的地址。 */
  address(request: IncomingMessage) {
    const forwarded = request.headers['x-forwarded-for']
    if (this.trustProxy && typeof forwarded === 'string')
      return forwarded.split(',').at(-1)!.trim() || 'unknown'
    return request.socket.remoteAddress ?? 'unknown'
  }
  cookie(value: string, maxAge: number) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge / 1000}${this.secure ? '; Secure' : ''}`
  }
  async login(
    request: IncomingMessage,
    response: ServerResponse,
    name: string,
    password: string,
  ): Promise<Identity> {
    const username = name.toLowerCase()
    const address = this.address(request)
    const now = Date.now()
    const wait = Math.max(this.byName.wait(username, now), this.byAddress.wait(address, now))
    if (wait > 0) {
      response.setHeader('Retry-After', Math.ceil(wait / 1000))
      throw new HttpError(429, `登录尝试过多，请 ${Math.ceil(wait / 1000)} 秒后再试。`)
    }
    // 先记失败再验证：并发的请求也会看到计数，成功后撤回
    this.byName.fail(username, now)
    this.byAddress.fail(address, now)
    const row = this.db
      .prepare('SELECT subject, hash FROM accounts WHERE username=?')
      .get(username) as { subject: string; hash: string } | undefined
    const valid = await verify(password, row?.hash ?? (await (decoy ??= hash(randomUUID()))))
    if (!row || !valid) throw new HttpError(401, '用户名或密码错误。')
    this.byName.forgive(username, now, true)
    this.byAddress.forgive(address, now, false)
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('DELETE FROM logins WHERE expires<=?').run(now)
    this.db.prepare('INSERT INTO logins VALUES(?, ?, ?)').run(digest(token), username, now + TTL)
    response.setHeader('Set-Cookie', this.cookie(token, TTL))
    return { subject: row.subject, name: username }
  }
  token(request: IncomingMessage) {
    return new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`).exec(request.headers.cookie ?? '')?.[1]
  }
  logout(request: IncomingMessage, response: ServerResponse) {
    const token = this.token(request)
    if (token) this.db.prepare('DELETE FROM logins WHERE token=?').run(digest(token))
    response.setHeader('Set-Cookie', this.cookie('', 0))
  }
  authenticate = async (request: IncomingMessage, response: ServerResponse) => {
    const token = this.token(request)
    if (!token) return undefined
    const key = digest(token)
    const now = Date.now()
    const row = this.db
      .prepare(
        'SELECT a.username, a.subject, l.expires FROM logins l JOIN accounts a USING(username) WHERE l.token=? AND l.expires>?',
      )
      .get(key, now) as { username: string; subject: string; expires: number } | undefined
    if (!row) return undefined
    if (row.expires - now < TTL - REFRESH) {
      this.db.prepare('UPDATE logins SET expires=? WHERE token=?').run(now + TTL, key)
      response.setHeader('Set-Cookie', this.cookie(token, TTL))
    }
    return { subject: row.subject, name: row.username } satisfies Identity
  }
}

function checked(password: string) {
  if (password.length < 8 || password.length > 1024) throw new Error('密码须为 8–1024 个字符。')
  return password
}

/** 终端里输入不回显；管道输入时读第一行。 */
async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.split(/\r?\n/)[0]
  }
  const ask = (prompt: string) =>
    new Promise<string>((done) => {
      process.stdout.write(prompt)
      process.stdin.setRawMode(true)
      process.stdin.resume()
      let text = ''
      const read = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003') {
            process.stdin.setRawMode(false)
            process.stdout.write('\n')
            process.exit(130)
          }
          if (char === '\r' || char === '\n') {
            process.stdin.off('data', read)
            process.stdin.setRawMode(false)
            process.stdin.pause()
            process.stdout.write('\n')
            return done(text)
          }
          text = char === '\u007f' || char === '\b' ? [...text].slice(0, -1).join('') : text + char
        }
      }
      process.stdin.on('data', read)
    })
  const password = await ask('密码（不回显）：')
  if ((await ask('再次输入密码：')) !== password) throw new Error('两次输入的密码不一致。')
  return password
}

const USAGE = `用法：
  pnpm account add <用户名>       新建账号（交互输入密码，或从标准输入读第一行）
  pnpm account passwd <用户名>    修改密码，并让该账号已登录的浏览器退出
  pnpm account remove <用户名>    删除账号并撤销其登录
  pnpm account list               列出账号`

async function main() {
  const [command, name, ...rest] = process.argv.slice(2)
  const valid =
    (command === 'list' && !name) ||
    (['add', 'passwd', 'remove'].includes(command) && name && !rest.length)
  if (!valid) throw new Error(USAGE)
  const store = new Store(resolve(process.env.DATA_DIR ?? 'server/data'))
  try {
    const accounts = new Accounts(store)
    if (command === 'list') {
      const rows = accounts.list()
      if (!rows.length) console.info('尚无账号。')
      for (const row of rows)
        console.info(`${row.username}\t创建于 ${new Date(row.created).toLocaleString('zh-CN')}`)
    } else if (command === 'remove') {
      console.info(`已删除账号 ${accounts.remove(name)}，其登录已失效。`)
    } else if (command === 'add') {
      // 先检查用户名，免得输完两遍密码才报错
      accounts.available(name)
      console.info(`已创建账号 ${await accounts.add(name, await readPassword())}。`)
    } else {
      accounts.existing(name)
      console.info(
        `已修改账号 ${await accounts.passwd(name, await readPassword())} 的密码，原有登录已失效。`,
      )
    }
  } finally {
    store.close()
  }
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : '账号操作失败。')
    process.exitCode = 1
  })
