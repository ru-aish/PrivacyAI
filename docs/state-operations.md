# PrivacyAI local-state operations

PrivacyAI treats local operational state as durable security state. Startup and inspection never delete, recreate, rotate, or silently normalize an incompatible store. Upgrade, repair, backup, and restore are separate explicit operations implemented by one shared service in `@privacy-ai/agent-bridge` and exposed through the canonical `privacyai state` CLI.

## State covered

| Component | Current format | Supported upgrade path |
| --- | --- | --- |
| Configuration | JSON version 1 | Legacy unversioned configuration → version 1 |
| Installation identity | JSON version 1, HMAC-SHA-256 key | No automatic rotation or replacement |
| Session vault | JSON records version 2 plus version 1 locators | Legacy version 1 records → identity-bound version 2 |
| Context repository | SQLite schema version 4 | Existing schema versions 1–3 → version 4 |
| Immutable lineage | SQLite schema version 1 | No historical migration is defined |

A version newer than the running release is always reported as unsupported. Malformed data, unsafe paths, active state, and unknown lineage schemas block write operations. Missing installation identity blocks use or migration of existing dependent state instead of creating a replacement identity. Ordinary context-store opens and vault updates reject legacy schemas/records with migration-required errors; only the backup-staged operations service opts into their migration routines.

## Commands

```bash
privacyai state preflight [--json]
privacyai state plan [--json]
privacyai state backup <new-directory> [--json]
privacyai state migrate --backup <new-directory> [--json]
privacyai state repair --backup <new-directory> [--json]
privacyai state restore <backup-directory> [--replace] [--replace-identity] [--json]
```

`preflight` and `plan` are read-only. They return exit code `0` only when no action is required and exit code `1` when migration, repair, onboarding, or manual recovery is required. Their output contains component names, versions, statuses, counts, and recovery steps—not configuration values, session mappings, identity key material, database rows, or source paths.

`backup` requires a destination that does not exist. `migrate` and `repair` require a new backup destination and create a complete backup before changing live state. `restore` requires `--replace` before replacing ordinary state, but not when all restored destinations are absent. Replacing an existing or unverifiable installation identity additionally requires `--replace-identity`; `--replace` alone is never sufficient.

`privacyai doctor` includes the same operational readiness report and suggested next steps.

## Operational contract

The shared API exports:

```js
inspectOperationalState(options)
planOperationalStateUpgrade(options)
createOperationalStateBackup({ ...options, backupDir })
migrateOperationalState({ ...options, backupDir })
repairOperationalState({ ...options, backupDir })
restoreOperationalStateBackup({
  ...options,
  backupDir,
  replace,
  replaceIdentity
})
```

All mutating functions accept an optional `AbortSignal`. A cancellation before publication removes staged output. Migration and restore build replacement artifacts beside the destination, validate them, and publish them by rename. If publication fails during the operation, already-published components are removed and prior components are renamed back where possible.

## Backup guarantees

A backup is a private directory (`0700`) with private regular files (`0600`) and a versioned `manifest.json`. The manifest contains only relative allowlisted paths, byte counts, and SHA-256 integrity hashes. It never records source absolute paths or protected values.

JSON files are read through no-follow file handles and rejected when they are symlinks, hard links, non-regular files, owned by another user, too large, or changed during the read. Vault contents are fingerprinted before and after copying. SQLite stores use the SQLite backup API so a consistent database image is captured while WAL mode is in use. Backup validation verifies every digest and validates each copied component semantically before restore or migration consumes it.

The backup destination and every operation path are checked component-by-component for symlinks. Existing shared parent directories are not chmodded. World- or group-writable destination parents are rejected.

## Repair boundary

Automatic repair is deliberately narrow:

- restore private modes on known owned state files and directories;
- remove stale vault lock or temporary artifacts whose owner is not live;
- restore private modes on known SQLite main/WAL/SHM files.

Repair does not rewrite records, regenerate state, rotate identity, discard corrupted rows, prune stores, or infer a replacement for missing data. Corruption and incompatible schemas require a verified restore or a compatible PrivacyAI release.

## Migration guarantees

Migration always operates on copies from the newly created backup. Live files are not edited in place.

- Configuration normalization adds the canonical version without changing selected provider/model semantics.
- Context migration runs the existing transactional schema initializer against the staged database and verifies SQLite integrity before publication.
- Vault migration derives version 2 filenames and identity metadata from the existing installation identity, writes version 1 locator records for compatibility, and keeps the installation identity byte-for-byte unchanged.
- Lineage is never rewritten by this release.

No operation silently resets local state. If a supported migration cannot complete, the pre-migration backup remains available and the live component is preserved or restored by the publication rollback path.

## Known limitations

- State operations currently rely on the tested Linux/macOS filesystem and SQLite behavior. Windows remains outside the supported product boundary.
- Restore is a local administrative component overlay, not a destructive snapshot replacement or multi-host replication protocol. It replaces only components present in the backup and does not delete local components created after that backup. Stop PrivacyAI agents before migration, repair, or restore.
- Publication is rollback-safe for handled errors and cancellation, but a machine or process crash between renames of multiple components—or a best-effort cleanup failure after success—can leave private `.restore-old` artifacts or mixed component versions. The verified pre-operation backup is the recovery authority in that case.
- A process that ignores SQLite coordination and replaces files outside PrivacyAI can still race an administrator operation; stable reads, SQLite locking/checkpoint checks, staged publication, and post-operation validation reduce but cannot eliminate hostile same-user interference.
- This release has no automatic lineage schema migration and no recovery algorithm for corrupt application records. It fails closed and requires a verified backup or compatible release.
