/**
 * dsh-snapshot — ~/.dsh backup / restore / rotate for DeepSeek Harness (TypeScript).
 *
 * Safety rules:
 *  1. archives land in ~/dsh-backups (outside the backed-up tree);
 *  2. restore validates every tar entry stays within the destination root;
 *  3. restore requires an explicit confirm flag;
 *  4. retention deletes only files matching the dsh-backup-*.tar.gz pattern;
 *  5. runtime dependencies: node builtins + system tar only.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat, unlink, access, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'snapshot'
export const inject = ['tools']

// --- minimal DSH tool surface ---
type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

interface Tool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[] }
  output: {
    schema: Json
    render: (args: Json, value: Json) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  presentCall?: (args: Json) => Json
  execute: (args: Json, exec: { signal?: AbortSignal }) => Promise<Json>
}

/** Official web-server surface (host/webserver/src/index.ts:42-47, 166). */
interface WebServer {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** The child context handed to the ctx.inject callback — here webServer is legal to read. */
interface InjectedCtx {
  webServer: WebServer
  effect?: (fn: () => unknown, label?: string) => unknown
}

interface Ctx {
  tools: { register: (tool: Tool) => void }
  inject?: (deps: string[], cb: (ctx: InjectedCtx) => unknown) => unknown
}

const dshHome = (): string => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const outDir = (): string => process.env.DSH_SNAPSHOT_DIR ?? join(homedir(), 'dsh-backups')
const MAX_KEEP = 30

const textOutput = (): Tool['output'] => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

function ts(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function run(cmd: string, args: string[], opts: { windowsHide?: boolean } = {}): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: opts.windowsHide })
    let out = '', err = ''
    p.stdout.on('data', (c: Buffer) => (out += c.toString()))
    p.stderr.on('data', (c: Buffer) => (err += c.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(err.trim() || `${cmd} exited ${code}`))))
  })
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c as Buffer))
    s.on('end', () => resolve())
    s.on('error', reject)
  })
  return h.digest('hex')
}

interface Snap { file: string; size: number; mtime: string; sha256: string | null; verified: boolean | null }

async function listSnapshots(): Promise<Snap[]> {
  const out = outDir()
  try { await access(out) } catch { return [] }
  const entries = await readdir(out)
  const snaps: Snap[] = []
  for (const e of entries.filter((n) => /^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(n))) {
    const full = join(out, e)
    const st = await stat(full)
    let hash: string | null = null
    try { hash = (await readFile(join(out, e + '.sha256'), 'utf8')).split(/\s+/)[0] } catch { /* no sidecar */ }
    let verified: boolean | null = null
    if (hash) {
      try { verified = (await sha256(full)) === hash } catch { verified = false }
    }
    snaps.push({ file: e, size: st.size, mtime: st.mtime.toISOString(), sha256: hash, verified })
  }
  return snaps.sort((a, b) => b.file.localeCompare(a.file))
}

export function apply(ctx: Ctx): (() => void) | void {
async function createBackup(keep: number): Promise<Json> {
  const file = `dsh-backup-${ts()}.tar.gz`
  const dest = join(outDir(), file)
  await mkdir(outDir(), { recursive: true })
  const excl = ['--exclude=node_modules', '--exclude=cache']
  await run('tar', ['-czf', dest, '-C', dshHome(), ...excl, '.'], { windowsHide: true })
  const hash = await sha256(dest)
  await writeFile(dest + '.sha256', hash + '  ' + file + '\n')
  const snaps = await listSnapshots()
  let removed = 0
  for (const s of snaps.slice(keep)) {
    await unlink(join(outDir(), s.file)).catch(() => {})
    await unlink(join(outDir(), s.file + '.sha256')).catch(() => {})
    removed++
  }
  return { ok: true, file, sha256: hash, size: (await stat(dest)).size, removed }
}

  const backupTool: Tool = {
    name: 'snapshot_backup',
    description:
      'Create a gzip tar snapshot of ~/.dsh (configs, sessions, credentials, plugin manifests; node_modules and cache excluded) into ~/dsh-backups with a sha256 sidecar, then enforce retention (keep newest N).',
    parameters: {
      type: 'object',
      properties: {
        keep: { type: 'number', description: 'Number of archives to retain (default 10, max 30)' },
      },
    },
    output: textOutput(),
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: 'generic', title: 'snapshot backup', kind: 'write', rawInput: a }),
    async execute(args) {
      const keep = Math.min(Math.max(1, typeof (args as Record<string, Json>).keep === 'number' ? ((args as Record<string, Json>).keep as number) : 10), MAX_KEEP)
      return createBackup(keep)
    },
  }

  const listTool: Tool = {
    name: 'snapshot_list',
    description: 'List ~/dsh-backups snapshots with sha256 verification status.',
    parameters: { type: 'object', properties: {} },
    output: textOutput(),
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'snapshot list', kind: 'read' }),
    async execute() {
      return { ok: true, dir: outDir(), snapshots: (await listSnapshots()) as unknown as Json }
    },
  }

  const restoreTool: Tool = {
    name: 'snapshot_restore',
    description:
      'Restore a snapshot archive into ~/.dsh. Every archive entry is validated to stay inside the destination root (traversal guard). Requires confirm: true. Existing ~/.dsh files are NOT deleted — files are extracted over them.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Archive filename (see snapshot_list)' },
        confirm: { type: 'boolean', description: 'Must be true to actually restore' },
      },
      required: ['file'],
    },
    output: textOutput(),
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: 'generic', title: 'snapshot restore', kind: 'write', rawInput: a }),
    async execute(args) {
      const a = args as Record<string, Json>
      const f = typeof a.file === 'string' ? a.file : null
      if (!f || !/^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(f)) {
        throw new Error('file must be a dsh-backup-YYYYMMDD-HHMMSS.tar.gz name from snapshot_list')
      }
      if (a.confirm !== true) {
        return { ok: false, error: 'refusing to restore without confirm: true' }
      }
      const archive = join(outDir(), f)
      await access(archive)
      let verified: boolean | null = null
      try {
        const side = (await readFile(join(outDir(), f + '.sha256'), 'utf8')).split(/\s+/)[0]
        verified = (await sha256(archive)) === side
        if (!verified) return { ok: false, error: 'sha256 mismatch — archive corrupt or tampered' }
      } catch { /* no sidecar: skip verification */ }
      const { out } = await run('tar', ['-tzf', archive], { windowsHide: true })
      const entries = out.split(/\r?\n/).filter(Boolean)
      const bad = entries.filter((e) => {
        const norm = e.replaceAll('\\', '/')
        return norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')
      })
      if (bad.length > 0) {
        return { ok: false, error: 'archive contains unsafe paths: ' + bad.slice(0, 5).join(', ') }
      }
      await run('tar', ['-xzf', archive, '-C', dshHome()], { windowsHide: true })
      return { ok: true, entries: entries.length, verified, restored: true }
    },
  }

  for (const tool of [backupTool, listTool, restoreTool]) {
    try { ctx.tools.register(tool) } catch (err) { console.error(`[snapshot] ${tool.name} skipped: ${err}`) }
  }

  // ---- auto-backup: DSH_SNAPSHOT_INTERVAL_HOURS (>0) enables hourly checks ----
  const intervalHours = Number(process.env.DSH_SNAPSHOT_INTERVAL_HOURS ?? '0')
  let timer: ReturnType<typeof setInterval> | null = null
  if (intervalHours > 0) {
    const newestAgeMs = async (): Promise<number> => {
      const snaps = await listSnapshots()
      const f = snaps[0]?.file
      const m = f ? f.match(/dsh-backup-(\d{8})-(\d{6})\.tar\.gz$/) : null
      if (!m) return Number.POSITIVE_INFINITY
      const d = m[1], tm = m[2]
      const ms = Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${tm.slice(0,2)}:${tm.slice(2,4)}:${tm.slice(4,6)}`)
      return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : Date.now() - ms
    }
    const check = async (): Promise<void> => {
      try {
        const age = await newestAgeMs()
        if (age >= intervalHours * 3600_000) await createBackup(10)
      } catch { /* never crash the host */ }
    }
    void check(),
    timer = setInterval(check, 3600_000),
    timer.unref?.()
  }

  // HTTP: 注册到官方 ctx.webServer。
  //
  // **不能**直接读 `ctx.webServer` —— cordis 的 ctx 是代理, 读一个已注册但未声明 inject
  // 的服务会抛 "cannot get property ... without inject", 可选链挡不住(get 陷阱先抛)。
  // 官方写法是用 ctx.inject 把依赖收进子 context (client/connection/src/index.ts:139-159):
  //   ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route), 'label'))
  // 没有 webServer 的 profile 里回调不执行 —— 路由不注册, 插件其余部分照常加载。
  // (原先的 `ctx.http?.mount?.()` —— ctx.http 不是 DSH 服务, 那条路由从未生效。)
  ctx.inject?.(['webServer'], (webCtx) => {
    const register = (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
      webCtx.webServer.register({ kind, path, handler })
    }
    const mount = (): void => registerHttpRoutes(ctx, register)
    if (typeof webCtx.effect === 'function') webCtx.effect(mount, 'snapshot: GET /api/snapshot/health')
    else mount()
  })
  return () => { if (timer) clearInterval(timer) }

}

// --- HTTP route (official ctx.webServer; native node:http req/res, no Hono, no bridge) ---

/**
 * 原先这里返回一个 Hono app 供 `ctx.http?.mount?.()` 挂载, 而 `ctx.http` 不是 DSH 的
 * 服务(官方 90 个 ctx.* 里没有它), 所以路由从未响应过任何请求, `hono` 依赖却一直背着。
 * 官方 web 层本来就是 node:http, handler 拿的是原生 IncomingMessage/ServerResponse,
 * 官方既不依赖 hono 也没有 Node↔Fetch 桥 —— 所以这里直接写 res, 不造桥、不引 hono。
 */
/**
 * Apply the official Host/Origin + browser-auth fence to one plugin's health routes.
 *
 * SOURCE — copied from the official DSH 0.1.7-rc.2 package `@deepseek-ai/dsh-host-open-in-app`,
 * which states the contract in its own module comment
 * (`lib/types/index.js:1-21`): "Security has one home, here. **Every route** asks the
 * composition's `connection` service for a rejection first (`requestRejection`): its Host/Origin
 * fence defeats DNS rebinding and cross-site calls, and its browser authentication (the
 * login-token cookie) gates every caller". The helper shape is `lib/index.js:1263-1270` and its
 * use is the first line of every handler there (`lib/index.js:1274-1275`).
 *
 * `requestRejection` itself (`dsh-client-connection/lib/index.js:586-589`):
 *   403 -> the Host is not loopback/trusted, or `sec-fetch-site: cross-site`, or Origin != Host
 *   401 -> the fence passed but there is no valid login-token cookie
 * so an anonymous request gets 401 and a forged one gets 403. Authentication accepts the
 * `dsh-auth-*` cookie ONLY (minted by the 303 set-cookie on `GET /?token=...`); the boot token
 * itself does not authenticate an API call. A browser that loaded the page first is unaffected.
 *
 * DO NOT "simplify" this away, and do not replace the read with `Reflect.get(ctx, 'connection')`.
 * The official helper is written that way because its own plugin declares `inject: ['connection']`;
 * from a plugin that does not, MEASURED on a live 127.0.0.1 instance, BOTH
 * `ctx.connection` AND `Reflect.get(ctx, 'connection')` throw
 * `cannot get property "connection" without inject` (cordis's proxy get-trap throws before any
 * optional chaining can help), while `ctx.get('connection')` returned the live
 * `HostConnectionService` with `requestRejection` present. `ctx.get` is also the official
 * inject-free service read — `dsh-web-app/lib/index.js:216` gates the ready banner on
 * `connectionCtx.get("connection") !== void 0`.
 *
 * FAIL-CLOSED. When the service is unreachable the request is answered 503, never forwarded:
 * silently serving would reopen exactly the hole this helper exists to close. In this profile
 * the branch is unreachable by construction — the route only registers under
 * `ctx.inject(['webServer'])`, and every composition that has `webServer` also carries
 * `connection` (`dsh-web-app/cordis.patch.yml:210-217` registers it beside the webserver).
 *
 * Each plugin carries its OWN copy on purpose: they are independent packages, and a shared
 * module would create a new deployment coupling (the ACP-graph contract already showed what
 * that costs, with 5 copies to re-sync on every edit).
 */

/** Just enough of the official HostConnectionService for the fence call. */
interface RequestFenceConnection {
  /** @returns 401/403 when the request must be refused, `undefined` when it may proceed. */
  requestRejection: (request: IncomingMessage) => number | undefined
}

/**
 * Build the fence for one plugin life.
 *
 * @param ctx - the plugin's context; only `get` is used, and only at call time.
 * @returns true when the request was answered by the fence and the handler must stop.
 */
function createRequestFence(ctx: unknown): (req: IncomingMessage, res: ServerResponse) => boolean {
  /** Read the service without declaring `inject` — see the read note above for why not Reflect.get. */
  const resolveConnection = (): RequestFenceConnection | undefined => {
    const read = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get
    if (typeof read !== 'function') return undefined
    try {
      const connection = read.call(ctx, 'connection') as RequestFenceConnection | undefined
      return typeof connection?.requestRejection === 'function' ? connection : undefined
    } catch {
      return undefined
    }
  }

  return (req, res) => {
    const connection = resolveConnection()
    if (connection === undefined) {
      // Fail closed: an unreachable fence must not become an open route.
      res.statusCode = 503
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'connection service unavailable: the Host/Origin fence cannot be applied' }))
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

export function registerHttpRoutes(
  ctx: unknown,
  register: (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void,
): void {
  const rejected = createRequestFence(ctx)
  register('exact', '/api/snapshot/health', (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, plugin: 'dsh-snapshot', ts: true, backupsDir: outDir() }))
  })
}
