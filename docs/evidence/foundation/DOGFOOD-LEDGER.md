# Foundation Dogfood Ledger

- Schema version: 1
- Frozen build: NOT_SELECTED
- Timezone: Europe/Berlin
- Completed consecutive days: 0
- Enrolled owners: 0
- Enrolled machines: 0
- Machine matrix rows: 0 of 16
- Copied isolated restore rows: 0
- Direct SQLite repairs observed so far: 0
- Human reviewer: UNREVIEWED
- Foundation status: IN_PROGRESS_EXTERNAL
- Canonical exit: NOT_MET

The timezone is locked before day one. Days are consecutive local calendar dates; DST does not alter calendar-date consecutiveness. Entries cannot be backfilled. A missing date, build change, direct database repair, incomplete or failed result, or missing authenticated review resets the derived streak. Corrections append a new record that refers to the original.

Direct SQLite repair means any manual statement or file edit that changes authoritative database contents outside shipped migrations, restore, or supported commands. Zero here means only that none has been observed yet; it is not period-wide proof.

## Machine and run rows

No owners, machines, runners, runs, or attempts have been enrolled or observed.

## Backup and restore rows

No copied encrypted backup or isolated restore has been executed.

## Daily rows

No dogfood day has been closed.

## Canonical criterion

Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.

The structured source for this ledger is `live-evidence.json`. Aggregate statuses are always derived and never entered manually.
