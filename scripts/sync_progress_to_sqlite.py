#!/usr/bin/env python3
"""
Two-way sync utility between Anki iOS Offline PWA (anki-ios-progress-*.json)
and a target Anki SQLite database (collection.anki2).

Usage:
  # 1. Write iOS PWA review progress JSON into a target Anki collection.anki2:
  python3 scripts/sync_progress_to_sqlite.py \
      --progress ~/Downloads/anki-ios-progress-2026-10-16.json \
      --db "/path/to/Anki2/User 1/collection.anki2"

  # 2. Rebuild PWA bundles after syncing:
  python3 scripts/build_pwa.py
"""
import argparse
import json
import shutil
import sqlite3
import time
from pathlib import Path


def sync_progress_to_db(progress_path: Path, db_path: Path, create_backup: bool = True) -> dict:
    if not progress_path.exists():
        raise FileNotFoundError(f"Progress JSON not found: {progress_path}")
    if not db_path.exists():
        raise FileNotFoundError(f"Target SQLite database not found: {db_path}")

    payload = json.loads(progress_path.read_text(encoding="utf-8"))
    if payload.get("kind") != "anki-ios-pwa-progress":
        raise ValueError("Invalid progress JSON: expected kind == 'anki-ios-pwa-progress'")

    if create_backup:
        ts = time.strftime("%Y%m%d-%H%M%S")
        backup_path = db_path.with_name(f"{db_path.name}.bak-{ts}")
        shutil.copy2(db_path, backup_path)
    else:
        backup_path = None

    conn = sqlite3.connect(str(db_path))
    conn.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    cur = conn.cursor()

    now_sec = int(time.time())
    cards_dict = payload.get("cards") or {}
    updated_cards = 0

    for cid_str, tuple_val in cards_dict.items():
        # tuple_val: [0:cid, 1:nid, 2:did, 3:ord, 4:type, 5:queue, 6:due, 7:ivl, 8:factor, 9:reps, 10:lapses]
        if not isinstance(tuple_val, list) or len(tuple_val) < 11:
            continue
        cid = int(tuple_val[0])
        ctype = int(tuple_val[4])
        queue = int(tuple_val[5])
        due = int(tuple_val[6])
        ivl = int(tuple_val[7])
        factor = int(tuple_val[8])
        reps = int(tuple_val[9])
        lapses = int(tuple_val[10])

        cur.execute(
            """
            UPDATE cards
               SET type = ?,
                   queue = ?,
                   due = ?,
                   ivl = ?,
                   factor = ?,
                   reps = ?,
                   lapses = ?,
                   mod = ?,
                   usn = -1
             WHERE id = ?
            """,
            (ctype, queue, due, ivl, factor, reps, lapses, now_sec, cid),
        )
        if cur.rowcount > 0:
            updated_cards += 1

    revlog_list = payload.get("revlog") or []
    inserted_revlog = 0
    for entry in revlog_list:
        # entry: [0:id(ms), 1:cid, 2:ease, 3:ivl, 4:lastIvl, 5:factor, 6:time(ms), 7:type]
        if not isinstance(entry, list) or len(entry) < 8:
            continue
        rid = int(entry[0])
        cid = int(entry[1])
        ease = int(entry[2])
        ivl = int(entry[3])
        last_ivl = int(entry[4])
        factor = int(entry[5])
        time_ms = int(entry[6])
        rtype = int(entry[7])

        cur.execute("SELECT 1 FROM revlog WHERE id = ?", (rid,))
        if cur.fetchone() is None:
            cur.execute(
                """
                INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
                VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)
                """,
                (rid, cid, ease, ivl, last_ivl, factor, time_ms, rtype),
            )
            inserted_revlog += 1

    conn.commit()
    conn.close()

    return {
        "updatedCards": updated_cards,
        "insertedRevlog": inserted_revlog,
        "backupPath": str(backup_path) if backup_path else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sync exported iOS PWA progress JSON back into an Anki collection.anki2 SQLite database."
    )
    parser.add_argument("--progress", required=True, type=Path, help="Path to anki-ios-progress-*.json")
    parser.add_argument("--db", required=True, type=Path, help="Path to target collection.anki2")
    parser.add_argument("--no-backup", action="store_true", help="Skip creating a .bak copy before writing")
    args = parser.parse_args()

    result = sync_progress_to_db(args.progress, args.db, create_backup=not args.no_backup)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
