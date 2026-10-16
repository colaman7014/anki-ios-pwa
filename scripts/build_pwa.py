#!/usr/bin/env python3
"""
Builds the offline data bundles (data/e62-bundle.js and data/full-bundle.js)
and the single-file AirDrop standalone HTML (dist/anki-ios-offline.html)
from the Anki SQLite collection in strict read-only mode.
"""
import base64
import gzip
import json
import sqlite3
from pathlib import Path
from urllib.parse import quote

PWA_ROOT = Path(__file__).resolve().parent.parent
ANKI_REPO = Path("/Users/colalin/repos/anki")
DEFAULT_DB_PATH = ANKI_REPO / "build" / "anki-smoke" / "User 1" / "collection.anki2"
UNIT01_AUDIO_JSON = ANKI_REPO / "build" / "unit01.audio.json"

US = "\x1f"


def parse_protobuf_fields(buf: bytes) -> dict:
    pos = 0
    out = {}
    n = len(buf)
    while pos < n:
        tag_byte = buf[pos]
        pos += 1
        field_num = tag_byte >> 3
        wire_type = tag_byte & 0x07
        if wire_type == 0:
            val = 0
            shift = 0
            while pos < n:
                b = buf[pos]
                pos += 1
                val |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            out[field_num] = val
        elif wire_type == 2:
            length = 0
            shift = 0
            while pos < n:
                b = buf[pos]
                pos += 1
                length |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
            chunk = buf[pos : pos + length]
            pos += length
            try:
                out[field_num] = chunk.decode("utf-8")
            except Exception:
                out[field_num] = chunk
        elif wire_type == 1:
            pos += 8
        elif wire_type == 5:
            pos += 4
        else:
            break
    return out


def extract_collection_from_sqlite(db_path: Path, e62_only: bool = False) -> dict:
    uri = f"file:{quote(str(db_path))}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    cur = conn.cursor()

    col_row = cur.execute("SELECT id, crt, mod, scm, ver FROM col").fetchone()
    crt = int(col_row[1]) if col_row else 1790625600
    ver = int(col_row[4]) if col_row else 18

    notetypes = {}
    for mid, name, cfg in cur.execute("SELECT id, name, config FROM notetypes").fetchall():
        mid_str = str(mid)
        pb = parse_protobuf_fields(cfg) if cfg else {}
        css = pb.get(3, "") if isinstance(pb.get(3), str) else ""
        is_cloze = pb.get(1, 0) == 1
        fields = [
            r[0]
            for r in cur.execute(
                "SELECT name FROM fields WHERE ntid=? ORDER BY ord", (mid,)
            ).fetchall()
        ]
        templates = []
        for ord_i, tname, tcfg in cur.execute(
            "SELECT ord, name, config FROM templates WHERE ntid=? ORDER BY ord", (mid,)
        ).fetchall():
            tpb = parse_protobuf_fields(tcfg) if tcfg else {}
            qfmt = tpb.get(1, "") if isinstance(tpb.get(1), str) else ""
            afmt = tpb.get(2, "") if isinstance(tpb.get(2), str) else ""
            templates.append(
                {
                    "ord": int(ord_i),
                    "name": tname,
                    "qfmt": qfmt,
                    "afmt": afmt,
                }
            )
        notetypes[mid_str] = {
            "id": mid_str,
            "name": name,
            "css": css,
            "isCloze": is_cloze,
            "fields": fields,
            "templates": templates,
        }

    e62_mids = {1792091008095, 1792080708967, 1792078113447}

    notes = {}
    for nid, mid, tags, flds in cur.execute("SELECT id, mid, tags, flds FROM notes").fetchall():
        if e62_only and int(mid) not in e62_mids:
            continue
        notes[str(nid)] = [str(mid), flds.split(US), (tags or "").strip()]

    cards = []
    used_dids = set()
    for row in cur.execute(
        "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses FROM cards"
    ).fetchall():
        cid, nid, did, ord_i, ctype, queue, due, ivl, factor, reps, lapses = row
        if str(nid) not in notes:
            continue
        used_dids.add(str(did))
        cards.append(
            [
                str(cid),
                str(nid),
                str(did),
                int(ord_i),
                int(ctype),
                int(queue),
                int(due),
                int(ivl),
                int(factor),
                int(reps),
                int(lapses),
            ]
        )

    all_decks = {
        str(did): name.replace(US, "::")
        for did, name in cur.execute("SELECT id, name FROM decks").fetchall()
    }
    if e62_only:
        decks = {
            did: dname
            for did, dname in all_decks.items()
            if did in used_dids or dname.startswith("E62")
        }
        notetypes = {k: v for k, v in notetypes.items() if int(k) in e62_mids}
    else:
        decks = all_decks

    card_cids = {c[0] for c in cards}
    revlog = []
    for row in cur.execute(
        "SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog"
    ).fetchall():
        if str(row[1]) in card_cids or not e62_only:
            revlog.append(
                [
                    int(row[0]),
                    str(row[1]),
                    int(row[2]),
                    int(row[3]),
                    int(row[4]),
                    int(row[5]),
                    int(row[6]),
                    int(row[7]),
                ]
            )

    conn.close()
    return {
        "crt": crt,
        "ver": ver,
        "decks": decks,
        "notetypes": notetypes,
        "notes": notes,
        "cards": cards,
        "revlog": revlog,
    }


def build_unit01_audio_map(audio_json_path: Path) -> dict:
    if not audio_json_path.exists():
        return {}
    raw = json.loads(audio_json_path.read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else raw.get("items", [])
    mapping = {}
    for item in items:
        term = (item.get("term") or "").strip().lower()
        pos = (item.get("partOfSpeech") or "").strip()
        w_audio = item.get("wordAudio") or ""
        s_audio = item.get("sentenceAudio") or ""
        if w_audio.startswith("[sound:") and w_audio.endswith("]"):
            w_audio = w_audio[7:-1]
        if s_audio.startswith("[sound:") and s_audio.endswith("]"):
            s_audio = s_audio[7:-1]
        for key in (f"{term}__{pos}", term):
            if key not in mapping:
                mapping[key] = {"wordAudio": w_audio, "sentenceAudios": []}
            if not mapping[key]["wordAudio"] and w_audio:
                mapping[key]["wordAudio"] = w_audio
            if s_audio and s_audio not in mapping[key]["sentenceAudios"]:
                mapping[key]["sentenceAudios"].append(s_audio)
    return mapping


def to_b64_gzip(data_obj: dict) -> tuple[str, int, int]:
    raw_bytes = json.dumps(data_obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_bytes = gzip.compress(raw_bytes, compresslevel=9)
    b64_str = base64.b64encode(gz_bytes).decode("ascii")
    return b64_str, len(raw_bytes), len(gz_bytes)


def main() -> None:
    import argparse
    import subprocess

    parser = argparse.ArgumentParser(
        description="Extract Anki.app SQLite collection into iOS Offline PWA bundles and optionally push to GitHub."
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help="Path to collection.anki2 (defaults to build/anki-smoke/User 1/collection.anki2)",
    )
    parser.add_argument(
        "--desktop",
        action="store_true",
        help="Read from macOS Anki.app default profile (~/Library/Application Support/Anki2/使用者 1/collection.anki2)",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="Automatically git commit and push updated bundles to GitHub",
    )
    args = parser.parse_args()

    if args.db:
        db_path = args.db.expanduser().resolve()
    elif args.desktop:
        db_path = (
            Path.home()
            / "Library"
            / "Application Support"
            / "Anki2"
            / "使用者 1"
            / "collection.anki2"
        )
    else:
        db_path = DEFAULT_DB_PATH

    print(f"[Source Anki DB] {db_path}")

    data_dir = PWA_ROOT / "data"
    dist_dir = PWA_ROOT / "dist"
    data_dir.mkdir(parents=True, exist_ok=True)
    dist_dir.mkdir(parents=True, exist_ok=True)

    # 1. Build E62 Core Bundle (3,011 cards)
    e62_col = extract_collection_from_sqlite(db_path, e62_only=True)
    e62_b64, e62_raw_len, e62_gz_len = to_b64_gzip(e62_col)
    audio_map = build_unit01_audio_map(UNIT01_AUDIO_JSON)

    e62_js_path = data_dir / "e62-bundle.js"
    e62_js_content = (
        f"// Auto-generated E62 Core Anki Collection Bundle ({len(e62_col['cards'])} cards)\n"
        f"window.ANKI_E62_BUNDLE_B64_GZ = {json.dumps(e62_b64)};\n"
        f"window.ANKI_UNIT01_AUDIO_MAP = {json.dumps(audio_map, ensure_ascii=False, separators=(',', ':'))};\n"
    )
    e62_js_path.write_text(e62_js_content, encoding="utf-8")
    print(
        f"[E62 Bundle] cards={len(e62_col['cards'])}, decks={len(e62_col['decks'])}, "
        f"raw={e62_raw_len/1024/1024:.2f} MB, gz={e62_gz_len/1024:.1f} KB -> {e62_js_path}"
    )

    # 2. Build Full Library Bundle (29,603 cards across 72 subdecks)
    full_col = extract_collection_from_sqlite(db_path, e62_only=False)
    full_b64, full_raw_len, full_gz_len = to_b64_gzip(full_col)
    full_js_path = data_dir / "full-bundle.js"
    full_js_content = (
        f"// Auto-generated Full Anki Collection Bundle ({len(full_col['cards'])} cards)\n"
        f"window.ANKI_FULL_BUNDLE_B64_GZ = {json.dumps(full_b64)};\n"
    )
    full_js_path.write_text(full_js_content, encoding="utf-8")
    print(
        f"[Full Bundle] cards={len(full_col['cards'])}, decks={len(full_col['decks'])}, "
        f"raw={full_raw_len/1024/1024:.2f} MB, gz={full_gz_len/1024/1024:.2f} MB -> {full_js_path}"
    )

    # 3. Build Single-File Standalone HTML for AirDrop (dist/anki-ios-offline.html)
    index_html = (PWA_ROOT / "index.html").read_text(encoding="utf-8")
    css_text = (PWA_ROOT / "css" / "anki-ios.css").read_text(encoding="utf-8")
    js_sqlite = (PWA_ROOT / "js" / "sqlite-apkg.js").read_text(encoding="utf-8")
    js_renderer = (PWA_ROOT / "js" / "renderer.js").read_text(encoding="utf-8")
    js_scheduler = (PWA_ROOT / "js" / "scheduler.js").read_text(encoding="utf-8")
    js_app = (PWA_ROOT / "js" / "app.js").read_text(encoding="utf-8")

    standalone = index_html.replace(
        '<link rel="stylesheet" href="css/anki-ios.css">',
        f"<style>\n{css_text}\n</style>",
    )
    standalone = standalone.replace(
        '  <script src="data/e62-bundle.js"></script>\n'
        '  <script src="js/sqlite-apkg.js"></script>\n'
        '  <script src="js/renderer.js"></script>\n'
        '  <script src="js/scheduler.js"></script>\n'
        '  <script src="js/app.js"></script>',
        f"<script>\n{e62_js_content}\n</script>\n"
        f"<script>\n{js_sqlite}\n</script>\n"
        f"<script>\n{js_renderer}\n</script>\n"
        f"<script>\n{js_scheduler}\n</script>\n"
        f"<script>\n{js_app}\n</script>",
    )
    standalone_path = dist_dir / "anki-ios-offline.html"
    standalone_path.write_text(standalone, encoding="utf-8")
    print(
        f"[Standalone AirDrop HTML] size={standalone_path.stat().st_size/1024:.1f} KB -> {standalone_path}"
    )

    if args.push:
        subprocess.run(
            ["git", "add", "data/e62-bundle.js", "data/full-bundle.js", "dist/anki-ios-offline.html"],
            cwd=str(PWA_ROOT),
            check=True,
        )
        diff_check = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(PWA_ROOT))
        if diff_check.returncode != 0:
            subprocess.run(
                ["git", "commit", "-m", "chore(sync): update Anki collection bundles from Anki.app"],
                cwd=str(PWA_ROOT),
                check=True,
            )
            subprocess.run(["git", "push", "origin", "main"], cwd=str(PWA_ROOT), check=True)
            print("[Git Push] Successfully pushed updated Anki bundles to origin/main")
        else:
            print("[Git Push] Bundles are already up to date; nothing to commit.")


if __name__ == "__main__":
    main()

