import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'snap-home-'))
process.env.DSH_SNAPSHOT_DIR = mkdtempSync(join(tmpdir(), 'snap-out-'))
const home = process.env.DSH_HOME
const out = process.env.DSH_SNAPSHOT_DIR

const { apply } = await import('../lib/index.js')

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