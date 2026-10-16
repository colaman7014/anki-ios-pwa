#!/usr/bin/env python3
"""
Builds one self-contained media pack (.zip) per deck so each deck's audio / images can be
AirDropped to the iPhone and imported independently (the whole media library is ~625 MB).

  dist/packs/<name>.zip      pack.json + media/<file> entries, all STORED (mp3/jpg don't deflate)
  data/media-manifest.js     tiny manifest the PWA uses to show per-deck pack status

Large root decks (see SPLIT_ROOTS) are split by their immediate sub-decks.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import zipfile
from pathlib import Path

from build_pwa import (
    PWA_ROOT,
    UNIT01_AUDIO_JSON,
    build_unit01_audio_map,
    load_full_collection,
    resolve_db_path,
)

MEDIA_DIRS = [
    Path("/Users/colalin/repos/anki/build/media"),
    Path("/Users/colalin/repos/anki/build/anki-smoke/User 1/collection.media"),
    Path.home() / "Library" / "Application Support" / "Anki2" / "使用者 1" / "collection.media",
]
SPLIT_ROOTS = {"4000 Essential English Words"}
E62_ROOT = "E62 English2000 全書"

SOUND_RE = re.compile(r"\[sound:([^\]|]+)")
IMG_RE = re.compile(r"""<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))""", re.I)


def load_bundle_collection() -> dict:
    """The collection the PWA actually ships (data/full-bundle.js), so packs always match the cards."""
    text = (PWA_ROOT / "data" / "full-bundle.js").read_text(encoding="utf-8")
    b64 = re.search(r'ANKI_FULL_BUNDLE_B64_GZ = "([^"]+)"', text).group(1)
    return json.loads(gzip.decompress(base64.b64decode(b64)))


def index_media_dirs() -> dict:
    """filename -> Path, first directory in MEDIA_DIRS wins (same precedence as server.py)."""
    index = {}
    for d in MEDIA_DIRS:
        try:
            for entry in os.scandir(d):
                if entry.is_file():
                    index.setdefault(entry.name, Path(entry.path))
        except OSError as exc:
            print(f"[skip media dir] {d}: {exc}")
    return index


def media_names_of(fields: list) -> set:
    text = " ".join(fields)
    names = {m.strip() for m in SOUND_RE.findall(text)}
    for m in IMG_RE.finditer(text):
        src = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if src and not src.startswith(("http:", "https:", "data:", "media/", "/")):
            names.add(src)
    return names


def plan_packs(col: dict) -> list:
    """Return [{deckPath, title}] in deck-name order: each root deck, or its sub-decks if split."""
    paths = sorted(set(col["decks"].values()))
    packs = []
    for root in sorted({p.split("::")[0] for p in paths}):
        children = sorted(p for p in paths if p.startswith(root + "::") and p.count("::") == 1)
        if root in SPLIT_ROOTS and children:
            packs.extend({"deckPath": c, "title": c.replace("::", " · ")} for c in children)
        else:
            packs.append({"deckPath": root, "title": root})
    return packs


def safe_filename(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", title).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build per-deck AirDrop media packs.")
    parser.add_argument("--db", type=Path, default=None, help="Read cards from this Anki DB instead of data/full-bundle.js")
    parser.add_argument("--desktop", action="store_true", help="Read cards from the Anki.app desktop profile instead of data/full-bundle.js")
    parser.add_argument("--out", type=Path, default=PWA_ROOT / "dist" / "packs")
    args = parser.parse_args()

    if args.db or args.desktop:
        col = load_full_collection(resolve_db_path(args.db, args.desktop))
    else:
        col = load_bundle_collection()
    media_index = index_media_dirs()
    print(f"[media] indexed {len(media_index)} files")

    unit01_files = set()
    for item in build_unit01_audio_map(UNIT01_AUDIO_JSON).values():
        if item.get("wordAudio"):
            unit01_files.add(item["wordAudio"])
        unit01_files.update(item.get("sentenceAudios") or [])

    plan = plan_packs(col)
    for pack in plan:
        pack["names"] = set()
    for card in col["cards"]:
        deck_name = col["decks"].get(str(card[2]), "")
        note = col["notes"].get(str(card[1]))
        if not note:
            continue
        for pack in plan:
            dp = pack["deckPath"]
            if deck_name == dp or deck_name.startswith(dp + "::"):
                pack["names"] |= media_names_of(note[1])
                break
    for pack in plan:
        if pack["deckPath"] == E62_ROOT:
            pack["names"] |= unit01_files

    args.out.mkdir(parents=True, exist_ok=True)
    for stale in args.out.glob("*.zip"):
        stale.unlink()

    manifest = []
    for pack in plan:
        present = sorted(n for n in pack["names"] if n in media_index)
        missing = len(pack["names"]) - len(present)
        if not present:
            print(f"[skip] {pack['title']}: no media files ({missing} referenced but not on disk)")
            continue
        sizes = [(n, media_index[n].stat().st_size) for n in present]
        total = sum(s for _, s in sizes)
        version = hashlib.sha1(json.dumps(sizes, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]
        pack_id = hashlib.sha1(pack["deckPath"].encode("utf-8")).hexdigest()[:10]
        meta = {
            "kind": "anki-ios-pwa-deckpack",
            "format": 1,
            "id": pack_id,
            "title": pack["title"],
            "deckPath": pack["deckPath"],
            "version": version,
            "files": [[n, s] for n, s in sizes],
        }
        zip_name = f"Anki離線包_{safe_filename(pack['title'])}.zip"
        with zipfile.ZipFile(args.out / zip_name, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            zf.writestr("pack.json", json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
            for name, _ in sizes:
                zf.write(media_index[name], f"media/{name}")
        manifest.append(
            {
                "id": pack_id,
                "title": pack["title"],
                "deckPath": pack["deckPath"],
                "version": version,
                "files": len(sizes),
                "bytes": total,
                "missing": missing,
                "zip": zip_name,
            }
        )
        print(f"[pack] {zip_name}: {len(sizes)} files, {total/1e6:.1f} MB, missing={missing}")

    manifest_path = PWA_ROOT / "data" / "media-manifest.js"
    manifest_path.write_text(
        "// Auto-generated by scripts/build_media_packs.py\n"
        f"window.ANKI_MEDIA_PACKS = {json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"[manifest] {len(manifest)} packs -> {manifest_path}")
    print(f"[done] AirDrop the .zip files in {args.out} to the iPhone, then import them in the app.")


if __name__ == "__main__":
    main()
