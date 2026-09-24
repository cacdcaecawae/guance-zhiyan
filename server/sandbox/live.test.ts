// Explicit Docker acceptance test: pnpm test:sandbox (never silently skips).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Store } from '../store.ts'
import { Artifacts } from '../artifacts.ts'
import { Sandboxes, sandboxConfig } from '../sandboxes.ts'
import { SessionSandbox } from '../sandbox-tools.ts'

test(
  'real Docker: tenant/control isolation, persistent files, quotas and detached process cancellation',
  { timeout: 240000 },
  async () => {
    const config = sandboxConfig()
    assert.ok(
      config,
      'Set SANDBOX_URL, SANDBOX_API_KEY and SANDBOX_IMAGE before running this test.',
    )
    const root = await mkdtemp(join(tmpdir(), 'gczy-live-sandbox-'))
    const store = new Store(root)
    const manager = await new Sandboxes(store, config).init()
    const files = new Artifacts(store)
    const alice = store.user('live:alice', 'Alice'),
      bob = store.user('live:bob', 'Bob')
    const a = store.create(alice.id),
      b = store.create(bob.id)
    const first = new SessionSandbox(manager, alice.id, a.id),
      second = new SessionSandbox(manager, bob.id, b.id)
    const run = async (session: SessionSandbox, script: string) => {
      let text = ''
      const result = await session.command(
        ['bash', '-c', `set -eu\n${script}`],
        { workingDirectory: '/workspace' },
        {
          skipAccumulation: true,
          onStdout: (message) => {
            text += message.text
          },
          onStderr: (message) => {
            text += message.text
          },
        },
      )
      assert.equal(result.exitCode, 0, text)
      return text
    }
    try {
      assert.equal(await run(first, 'id -u'), '1000\n')
      await run(
        first,
        'test "$(cat /sys/fs/cgroup/memory.max)" != max; test "$(cut -d" " -f1 /sys/fs/cgroup/cpu.max)" != max; test "$(cat /sys/fs/cgroup/pids.max)" = 256',
      )
      await run(first, "printf 'private report' > secret.txt")
      await run(second, 'test ! -e /workspace/secret.txt')
      await assert.rejects(
        manager.use(bob.id, a.id, undefined, async () => {}),
        /没有找到/,
      )
      await run(
        first,
        `python3 - <<'PY'
import urllib.request, urllib.error
for address in ['http://127.0.0.1:44772/ping', 'http://127.0.0.1:44772/internal/init', 'http://127.0.0.1:18080/health', 'http://169.254.169.254/']:
    try:
        urllib.request.urlopen(address, timeout=3)
    except urllib.error.HTTPError:
        raise AssertionError('control endpoint reachable: ' + address)
    except (urllib.error.URLError, TimeoutError):
        pass
    else:
        raise AssertionError('control endpoint reachable: ' + address)
PY`,
      )
      await run(
        first,
        'test ! -r /etc/shadow; test ! -e /var/run/docker.sock; test -z "${DEEPSEEK_API_KEY-}${QIANWEN_API_KEY-}${SANDBOX_API_KEY-}"',
      )
      await run(
        first,
        'python3 -c "import urllib.request; assert urllib.request.urlopen(\'https://example.com\', timeout=20).status == 200"',
      )
      await first.writeFile('native.txt', Buffer.from('native filesystem'))
      const artifact = await first.exportFile('native.txt', files)
      assert.equal(await readFile(files.path(artifact.id), 'utf8'), 'native filesystem')
      await run(
        first,
        "python3 - <<'PY'\nfrom docx import Document\nd = Document(); d.add_paragraph('Real sandbox report'); d.save('/workspace/report.docx')\nPY",
      )
      const word = await first.exportFile('report.docx', files)
      assert.match(await files.read(alice.id, a.id, word.id, first), /Real sandbox report/)
      await run(
        first,
        "setsid bash -c 'while true; do echo tick >> /workspace/ticks; sleep 0.1; done' >/dev/null 2>&1 &\nwhile [ ! -s ticks ]; do sleep 0.05; done",
      )
      await first.stop()
      assert.equal(await run(first, 'cat secret.txt'), 'private report')
      await run(
        first,
        'before=$(wc -c < ticks); sleep 1; after=$(wc -c < ticks); test "$before" = "$after"',
      )
      assert.equal(await run(second, 'id -u'), '1000\n')
      const started = Promise.withResolvers<void>()
      const abort = new AbortController()
      const running = first.command(
        ['bash', '-c', 'echo started; sleep 600'],
        { workingDirectory: '/workspace' },
        { onStdout: () => started.resolve() },
        abort.signal,
      )
      const stopped = assert.rejects(running)
      await started.promise
      abort.abort()
      await stopped
      assert.equal(
        await readFile(files.path(word.id)).then((data) => data.subarray(0, 2).toString()),
        'PK',
      )
    } finally {
      await manager.close()
      store.close()
      // Only remove volumes minted by this test; normal user volumes are retained.
      const { stdout: listed } = await promisify(execFile)('docker', [
        'volume',
        'ls',
        '--format',
        '{{.Name}}',
      ])
      const volumes = [`gczy-${a.id}`, `gczy-${b.id}`].filter((name) =>
        listed.split('\n').includes(name),
      )
      if (volumes.length) await promisify(execFile)('docker', ['volume', 'rm', ...volumes])
      assert.ok(
        resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('gczy-live-sandbox-'),
      )
      await rm(root, { recursive: true })
    }
  },
)
