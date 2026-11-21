// src/index.ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat, unlink, access, mkdir, writeFile, readFile, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
var name = "snapshot";
var inject = ["tools"];
var dshHome = () => process.env.DSH_HOME ?? join(homedir(), ".dsh");
var outDir = () => process.env.DSH_SNAPSHOT_DIR ?? join(homedir(), "dsh-backups");
var MAX_KEEP = 30;
var textOutput = () => ({
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});
function ts() {
  const d = /* @__PURE__ */ new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: opts.windowsHide });
    let out = "", err = "";
    p.stdout.on("data", (c) => out += c.toString());
    p.stderr.on("data", (c) => err += c.toString());
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve({ out, err }) : reject(new Error(err.trim() || `${cmd} exited ${code}`)));
  });
}
async function sha256(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return h.digest("hex");
}
async function listSnapshots() {
  const out = outDir();
  try {
    await access(out);
  } catch {
    return [];
  }
  const entries = await readdir(out);
  const snaps = [];
  for (const e of entries.filter((n) => /^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(n))) {
    const full = join(out, e);
    const st = await stat(full);
    let hash = null;
    try {
      hash = (await readFile(join(out, e + ".sha256"), "utf8")).split(/\s+/)[0];
    } catch {
    }
    let verified = null;
    if (hash) {
      try {
        verified = await sha256(full) === hash;
      } catch {
        verified = false;
      }
    }
    snaps.push({ file: e, size: st.size, mtime: st.mtime.toISOString(), sha256: hash, verified });
  }
  return snaps.sort((a, b) => b.file.localeCompare(a.file));
}
var LOCK_NAME = ".backup.lock";
var LOCK_STALE_MS = 15 * 6e4;
async function acquireBackupLock() {
  const lockPath = join(outDir(), LOCK_NAME);
  await mkdir(outDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
      await fh.close();
      return async () => {
        await unlink(lockPath).catch(() => {
        });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let ageMs;
      try {
        ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch {
        ageMs = LOCK_STALE_MS + 1;
      }
      if (ageMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {
        });
        continue;
      }
      let holder = "";
      try {
        holder = (await readFile(lockPath, "utf8")).trim();
      } catch {
      }
      throw new Error(
        `\u53E6\u4E00\u500B\u5099\u4EFD\u6B63\u5728\u9032\u884C\uFF08\u9396\u5EFA\u7ACB\u65BC ${Math.round(ageMs / 1e3)} \u79D2\u524D${holder ? `\uFF0C${holder}` : ""}\uFF09\u3002\u5169\u500B\u884C\u7A0B\u540C\u6642\u6253 tar \u6703\u649E\u5230\u540C\u4E00\u500B\u6A94\u540D\u4E26\u5BEB\u58DE\u58D3\u7E2E\u5305\uFF0C\u6240\u4EE5\u9019\u6B21\u4E0D\u57F7\u884C\uFF1B\u82E5\u78BA\u5B9A\u524D\u4E00\u500B\u884C\u7A0B\u5DF2\u6B7B\uFF0C\u7B49 ${Math.round(LOCK_STALE_MS / 6e4)} \u5206\u9418\u5B83\u6703\u81EA\u52D5\u904E\u671F\u6216\u88AB\u63A5\u7BA1\u3002`
      );
    }
  }
  throw new Error("\u53D6\u4E0D\u5230\u5099\u4EFD\u9396\uFF08\u9023\u7E8C\u5169\u6B21\u90FD\u88AB\u4F54\u7528\uFF09");
}
function apply(ctx) {
  async function createBackup(keep) {
    const release = await acquireBackupLock();
    try {
      let file = `dsh-backup-${ts()}.tar.gz`;
      let dest = join(outDir(), file);
      if (await access(dest).then(() => true, () => false)) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        file = `dsh-backup-${ts()}.tar.gz`;
        dest = join(outDir(), file);
      }
      await mkdir(outDir(), { recursive: true });
      const excl = ["--exclude=node_modules", "--exclude=cache", "--exclude=home-archive"];
      await run("tar", ["-czf", dest, "-C", dshHome(), ...excl, "."], { windowsHide: true });
      const hash = await sha256(dest);
      await writeFile(dest + ".sha256", hash + "  " + file + "\n");
      const snaps = await listSnapshots();
      let removed = 0;
      for (const s of snaps.slice(keep)) {
        await unlink(join(outDir(), s.file)).catch(() => {
        });
        await unlink(join(outDir(), s.file + ".sha256")).catch(() => {
        });
        removed++;
      }
      return { ok: true, file, sha256: hash, size: (await stat(dest)).size, removed };
    } finally {
      await release();
    }
  }
  const backupTool = {
    name: "snapshot_backup",
    description: "Create a gzip tar snapshot of ~/.dsh (configs, sessions, credentials, plugin manifests; node_modules and cache excluded) into ~/dsh-backups with a sha256 sidecar, then enforce retention (keep newest N).",
    parameters: {
      type: "object",
      properties: {
        keep: { type: "number", description: "Number of archives to retain (default 10, max 30)" }
      }
    },
    output: textOutput(),
    timeoutMs: 12e4,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: "generic", title: "snapshot backup", kind: "write", rawInput: a }),
    async execute(args) {
      const keep = Math.min(Math.max(1, typeof args.keep === "number" ? args.keep : 10), MAX_KEEP);
      return createBackup(keep);
    }
  };
  const listTool = {
    name: "snapshot_list",
    description: "List ~/dsh-backups snapshots with sha256 verification status.",
    parameters: { type: "object", properties: {} },
    output: textOutput(),
    timeoutMs: 3e4,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: "generic", title: "snapshot list", kind: "read" }),
    async execute() {
      return { ok: true, dir: outDir(), snapshots: await listSnapshots() };
    }
  };
  const restoreTool = {
    name: "snapshot_restore",
    description: "Restore a snapshot archive into ~/.dsh. Every archive entry is validated to stay inside the destination root (traversal guard). Requires confirm: true. Existing ~/.dsh files are NOT deleted \u2014 files are extracted over them.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "Archive filename (see snapshot_list)" },
        confirm: { type: "boolean", description: "Must be true to actually restore" }
      },
      required: ["file"]
    },
    output: textOutput(),
    timeoutMs: 18e4,
    isConcurrencySafe: () => false,
    presentCall: (a) => ({ card: "generic", title: "snapshot restore", kind: "write", rawInput: a }),
    async execute(args) {
      const a = args;
      const f = typeof a.file === "string" ? a.file : null;
      if (!f || !/^dsh-backup-\d{8}-\d{6}\.tar\.gz$/.test(f)) {
        throw new Error("file must be a dsh-backup-YYYYMMDD-HHMMSS.tar.gz name from snapshot_list");
      }
      if (a.confirm !== true) {
        return { ok: false, error: "refusing to restore without confirm: true" };
      }
      const archive = join(outDir(), f);
      await access(archive);
      let verified = null;
      try {
        const side = (await readFile(join(outDir(), f + ".sha256"), "utf8")).split(/\s+/)[0];
        verified = await sha256(archive) === side;
        if (!verified) return { ok: false, error: "sha256 mismatch \u2014 archive corrupt or tampered" };
      } catch {
      }
      const { out } = await run("tar", ["-tzf", archive], { windowsHide: true });
      const entries = out.split(/\r?\n/).filter(Boolean);
      const bad = entries.filter((e) => {
        const norm = e.replaceAll("\\", "/");
        return norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..");
      });
      if (bad.length > 0) {
        return { ok: false, error: "archive contains unsafe paths: " + bad.slice(0, 5).join(", ") };
      }
      await run("tar", ["-xzf", archive, "-C", dshHome()], { windowsHide: true });
      return { ok: true, entries: entries.length, verified, restored: true };
    }
  };
  for (const tool of [backupTool, listTool, restoreTool]) {
    try {
      ctx.tools.register(tool);
    } catch (err) {
      console.error(`[dsh-snapshot] ${tool.name} skipped: ${err}`);
    }
  }
  const intervalHours = Number(process.env.DSH_SNAPSHOT_INTERVAL_HOURS ?? "0");
  let timer = null;
  if (intervalHours > 0) {
    const newestAgeMs = async () => {
      const snaps = await listSnapshots();
      const f = snaps[0]?.file;
      const m = f ? f.match(/dsh-backup-(\d{8})-(\d{6})\.tar\.gz$/) : null;
      if (!m) return Number.POSITIVE_INFINITY;
      const d = m[1], tm = m[2];
      const ms = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${tm.slice(0, 2)}:${tm.slice(2, 4)}:${tm.slice(4, 6)}`);
      return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : Date.now() - ms;
    };
    const check = async () => {
      try {
        const age = await newestAgeMs();
        if (age >= intervalHours * 36e5) await createBackup(10);
      } catch {
      }
    };
    void check(), timer = setInterval(check, 36e5), timer.unref?.();
  }
  ctx.inject?.(["webServer"], (webCtx) => {
    const register = (kind, path, handler) => {
      webCtx.webServer.register({ kind, path, handler });
    };
    const mount = () => registerHttpRoutes(ctx, register);
    if (typeof webCtx.effect === "function") webCtx.effect(mount, "snapshot: GET /api/snapshot/health");
    else mount();
  });
  return () => {
    if (timer) clearInterval(timer);
  };
}
function createRequestFence(ctx) {
  const resolveConnection = () => {
    const read = ctx?.get;
    if (typeof read !== "function") return void 0;
    try {
      const connection = read.call(ctx, "connection");
      return typeof connection?.requestRejection === "function" ? connection : void 0;
    } catch {
      return void 0;
    }
  };
  return (req, res) => {
    const connection = resolveConnection();
    if (connection === void 0) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "connection service unavailable: the Host/Origin fence cannot be applied" }));
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === void 0) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}
function registerHttpRoutes(ctx, register) {
  const rejected = createRequestFence(ctx);
  register("exact", "/api/snapshot/health", (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, plugin: "dsh-snapshot", ts: true, backupsDir: outDir() }));
  });
}
export {
  apply,
  inject,
  name,
  registerHttpRoutes
};
