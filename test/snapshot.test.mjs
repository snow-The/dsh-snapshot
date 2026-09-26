import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'snap-home-'))
process.env.DSH_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'snap-out-'))
const home = process.env.DSH_HOME
const out = process.env.DSH_SNAPSHOT_DIR

const { apply, registerHttpRoutes } = await import('../dist/index.js')

function makeCtx() {
  const tools = []
  tools.register = (t) => tools.push(t)
  return { tools }
}

test('registers three tools', () => {
  const ctx = makeCtx()
  apply(ctx)
  assert.deepEqual(ctx.tools.map((t) => t.name).sort(), ['snapshot_backup', 'snapshot_list', 'snapshot_restore'])
})

test('backup creates archive with sha256 and list verifies', async () => {
  const ctx = makeCtx()
  apply(ctx)
  // seed home with a config
  mkdirSync(join(home, 'profiles'), { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding: x\n')
  const backup = ctx.tools.find((t) => t.name === 'snapshot_backup')
  const r = await backup.execute({})
  assert.equal(r.ok, true)
  assert.ok(/^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(r.file))
  const archive = join(out, r.file)
  const side = readFileSync(archive + '.sha256', 'utf8')
  assert.match(side, new RegExp(r.sha256))
  const list = ctx.tools.find((t) => t.name === 'snapshot_list')
  const lr = await list.execute({})
  assert.equal(lr.ok, true)
  assert.equal(lr.snapshots.length, 1)
  assert.equal(lr.snapshots[0].verified, true)
})

test('restore refuses without confirm', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const restore = ctx.tools.find((t) => t.name === 'snapshot_restore')
  const list = ctx.tools.find((t) => t.name === 'snapshot_list')
  const lr = await list.execute({})
  const file = lr.snapshots[0].file
  const r = await restore.execute({ file })
  assert.equal(r.ok, false)
  assert.match(r.error, /confirm/)
})

test('restore validates filename and restores content', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const restore = ctx.tools.find((t) => t.name === 'snapshot_restore')
  await assert.rejects(() => restore.execute({ file: '../evil.tar.gz', confirm: true }), /file must be/)
  // mutate home then restore
  writeFileSync(join(home, 'settings.yaml'), 'mutated\n')
  const list = ctx.tools.find((t) => t.name === 'snapshot_list')
  const lr = await list.execute({})
  const r = await restore.execute({ file: lr.snapshots[0].file, confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.verified, true)
  assert.match(readFileSync(join(home, 'settings.yaml'), 'utf8'), /ui-onboarding/)
})

test('retention keeps only newest', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const backup = ctx.tools.find((t) => t.name === 'snapshot_backup')
  await backup.execute({})
  await backup.execute({ keep: 1 })
  const list = ctx.tools.find((t) => t.name === 'snapshot_list')
  const lr = await list.execute({})
  assert.equal(lr.snapshots.length, 1)
})

// 捕获 registerHttpRoutes 注册的路由, 并用假 res 调用它 —— 直接测我们自己的 handler
// (原生 node:http req/res), 而不是 Hono 的 Request/Response 适配层。
function captureRoutes(ctx) {
  const routes = new Map()
  // The handler asks the composition's `connection` service for a rejection first (the official
  // Host/Origin + login-cookie fence). Passing `{}` made that service read as UNREACHABLE, so the
  // fence correctly failed CLOSED with 503 and these tests asserted 503 instead of 200 -- the stub
  // never modelled a real host. `undefined` from requestRejection means "admissible", which is what
  // a same-origin browser request gets. A host with NO connection service is a separate case with
  // its own coverage, so the two facts stay distinguishable.
  const base = ctx && Object.keys(ctx).length > 0
    ? ctx
    : { get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined) }
  registerHttpRoutes(base, (kind, path, handler) => { routes.set(path, { kind, handler }) })
  const call = async (path, method = 'GET') => {
    const route = routes.get(path)
    if (!route) throw new Error('no route registered at ' + path)
    const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    await route.handler({ method, url: path }, res)
    return res
  }
  return { routes, call }
}

test('health route is exact /api/snapshot/health and answers 200', async () => {
  const { routes, call } = captureRoutes({})
  assert.equal(routes.get('/api/snapshot/health').kind, 'exact')
  const res = await call('/api/snapshot/health')
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(String(res.body))
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-snapshot')
  assert.equal(body.backupsDir, out)
  // 旧的 hono 标记已随 hono 依赖一起移除
  assert.equal(body.hono, undefined)
})

test('non-GET is rejected with 405 + allow: GET', async () => {
  const { call } = captureRoutes({})
  const res = await call('/api/snapshot/health', 'POST')
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers['allow'], 'GET')
})

test('apply registers on the official ctx.webServer, not the absent ctx.http', () => {
  const registered = []
  let effectLabel = null
  const ctx = cordisCtx({
    webServer: { register: (r) => { registered.push(r); return () => {} } },
    extra: { tools: makeCtx().tools, effect: (fn, label) => { effectLabel = label; fn() } },
  })
  apply(ctx)
  assert.deepEqual(registered.map((r) => r.path), ['/api/snapshot/health'])
  assert.match(String(effectLabel), /snapshot/)
})

// 复刻 cordis 的 ctx 代理: 读一个已注册但**未声明 inject** 的服务时, get 陷阱先抛
// "cannot get property X without inject" —— 可选链 `ctx.webServer?.x` 挡不住。
// 这正是本次迁移踩到的坑: 在 apply 里直接读 ctx.webServer 会让整个插件激活失败
// (不是路由不注册, 而是插件整体不加载)。所以 apply 必须走 ctx.inject。
function cordisCtx({ webServer, extra = {} } = {}) {
  let inInject = false
  const target = {
    ...extra,
    inject: (deps, cb) => {
      if (!deps.includes('webServer') || !webServer) return undefined
      const prev = inInject
      inInject = true
      try { return cb({ webServer, effect: extra.effect }) } finally { inInject = prev }
    },
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'webServer' && !inInject) throw new Error('cannot get property "webServer" without inject')
      return t[prop]
    },
  })
}

test('the cordis trap is real, and apply avoids it by using ctx.inject', () => {
  const ctx = cordisCtx({ webServer: { register: () => () => {} } })
  assert.throws(() => ctx.webServer, /without inject/)
  assert.doesNotThrow(() => apply(ctx))
})

test('apply tolerates a host without webServer (no throw)', () => {
  apply(makeCtx())                                     // 朴素 ctx: 连 inject 都没有
  assert.doesNotThrow(() => apply(cordisCtx({ extra: { tools: makeCtx().tools } })))  // 有 inject, 服务缺席
})