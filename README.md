# dsh-snapshot

Backup / restore / rotate snapshots of `~/.dsh` for DeepSeek Harness.

- Archives go to `~/dsh-backups/dsh-backup-<ts>.tar.gz` (outside `~/.dsh`).
- `node_modules` / `cache` are excluded (regenerable); configs, sessions,
  credentials and plugin manifests are kept.
- Every archive ships a `.sha256` sidecar; `snapshot_list` verifies them.
- Restore validates every archive entry stays inside the destination root
  (path-traversal guard) and refuses to run without `confirm: true`.

## Tools

- `snapshot_backup` — create a snapshot (keep: number of archives to retain)
- `snapshot_list` — list snapshots with sha256 verification
- `snapshot_restore` — restore a snapshot (requires confirm: true)

## License

MIT
