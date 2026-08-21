/**
 * dsh-snapshot — ~/.dsh backup / restore / rotate for DeepSeek Harness.
 *
 * Safety rules:
 *  1. archives land in ~/dsh-backups (outside the backed-up tree);
 *  2. restore validates every tar entry stays within the destination root;
 *  3. restore requires an explicit confirm flag;
 *  4. retention deletes only files matching the dsh-backup-*.tar.gz pattern;
 *  5. zero runtime dependencies (node builtins + the system tar).
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat, unlink, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'

export const name = 'snapshot'
export const inject = ['tools']

const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const outDir = () => process.env.DSH_SNAPSHOT_DIR ?? join(homedir(), 'dsh-backups')
const MAX_KEEP = 30

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let out = '', err = ''
    p.stdout.on('data', (c) => (out += c))
    p.stderr.on('data', (c) => (err += c))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(err.trim() || `${cmd} exited ${code}`))))
  })
}

async function sha256(file) {
  const h = createHash('sha256')
  await new Promise((resolve, reject) => {
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('end', resolve)
    s.on('error', reject)
  })
  return h.digest('hex')
}

async function listSnapshots() {
  const out = outDir()
  try { await access(out) } catch { return [] }
  const entries = await readdir(out)
  const snaps = []
  for (const e of entries.filter((n) => /^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(n))) {
    const full = join(outDir(), e)
    const st = await stat(full)
    let hash = null
    try { hash = (await readFileSafe(join(outDir(), e + '.sha256'))).split(/\s+/)[0] } catch {}
    let verified = null
    if (hash) {
      try { verified = (await sha256(full)) === hash } catch { verified = false }
    }
    snaps.push({ file: e, size: st.size, mtime: st.mtime.toISOString(), sha256: hash, verified })
  }
  return snaps.sort((a, b) => b.file.localeCompare(a.file))
}

async function readFileSafe(p) {
  const { readFile } = await import('node:fs/promises')
  return readFile(p, 'utf8')
}

/** DSH requires every tool to declare output { schema, render }. */
const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

export function apply(ctx) {
  const backupTool = {
    name: 'snapshot_backup',
    description:
      'Create a gzip tar snapshot of ~/.dsh (configs, sessions, credentials, plugin manifests; node_modules and cache excluded) into ~/dsh-backups with a sha256 sidecar, then enforce retention (keep newest N).',
    parameters: {
      type: 'object',
      properties: {
        keep: { type: 'number', description: 'Number of archives to retain (default 10, max 30)' },
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: 'generic', title: 'snapshot backup', kind: 'write', rawInput: a }),
    async execute(args) {
      const keep = Math.min(Math.max(1, args?.keep ?? 10), MAX_KEEP)
      const file = `dsh-backup-${ts()}.tar.gz`
      const dest = join(outDir(), file)
      const { mkdir } = await import('node:fs/promises')
      await mkdir(outDir(), { recursive: true })
      const excludes = ['--exclude=node_modules', '--exclude=cache', '--exclude=sessions']
      // sessions are valuable; keep them by default. Reconsider: sessions are
      // part of what a restore must bring back — drop the exclusion.
      const excl = excludes.filter((e) => e !== '--exclude=sessions')
      await run('tar', ['-czf', dest, '-C', dshHome(), ...excl, '.'], { windowsHide: true })
      const hash = await sha256(dest)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(dest + '.sha256', hash + '  ' + file + '\n')
      // retention
      const snaps = await listSnapshots()
      let removed = 0
      for (const s of snaps.slice(keep)) {
        await unlink(join(outDir(), s.file)).catch(() => {})
        await unlink(join(outDir(), s.file + '.sha256')).catch(() => {})
        removed++
      }
      return { ok: true, file, sha256: hash, size: (await stat(dest)).size, removed }
    },
  }

  const listTool = {
    name: 'snapshot_list',
    description: 'List ~/dsh-backups snapshots with sha256 verification status.',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'snapshot list', kind: 'read' }),
    async execute() {
      return { ok: true, dir: outDir(), snapshots: await listSnapshots() }
    },
  }

  const restoreTool = {
    name: 'snapshot_restore',
    description:
      'Restore a snapshot archive into ~/.dsh. Every archive entry is validated to stay inside the destination root (traversal guard). Requires confirm: true. Current ~/.dsh is NOT deleted — files are extracted over it.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Archive filename (e.g. dsh-backup-20260815-183000.tar.gz) — see snapshot_list' },
        confirm: { type: 'boolean', description: 'Must be true to actually restore' },
      },
      required: ['file'],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: 'generic', title: 'snapshot restore', kind: 'write', rawInput: a }),
    async execute(args) {
      const f = args?.file
      if (typeof f !== 'string' || !/^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(f)) {
        throw new Error('file must be a dsh-backup-YYYYMMDD-HHMMSS.tar.gz name from snapshot_list')
      }
      if (args?.confirm !== true) {
        return { ok: false, error: 'refusing to restore without confirm: true' }
      }
      const archive = join(outDir(), f)
      await access(archive)
      // verify sha256 if sidecar exists
      let verified = null
      try {
        const side = (await readFileSafe(join(outDir(), f + '.sha256'))).split(/\s+/)[0]
        verified = (await sha256(archive)) === side
        if (!verified) return { ok: false, error: 'sha256 mismatch — archive corrupt or tampered' }
      } catch {}
      // list entries and validate (bsdtar -tf lists paths)
      const { out } = await run('tar', ['-tzf', archive], { windowsHide: true })
      const entries = out.split(/\r?\n/).filter(Boolean)
      const bad = entries.filter((e) => {
        const norm = e.replaceAll('\\', '/')
        return norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')
      })
      if (bad.length > 0) {
        return { ok: false, error: 'archive contains unsafe paths: ' + bad.slice(0, 5).join(', ') }
      }
      const { out: out2, err: err2 } = await run('tar', ['-xzf', archive, '-C', dshHome()], { windowsHide: true })
      return { ok: true, entries: entries.length, verified, restored: true }
    },
  }

  for (const tool of [backupTool, listTool, restoreTool]) {
    tool.output = textOutput()
    try { ctx.tools.register(tool) } catch (err) { console.error(`[snapshot] ${tool.name} skipped: ${err}`) }
  }
}
