/**
 * Pure-JS Offline Parser for Anki .apkg / .colpkg (ZIP), SQLite3 (collection.anki2 / .anki21),
 * Anki v18 Protobuf configs (notetypes.config / templates.config), and Gzip bundles.
 * Zero external dependencies — works 100% offline in iOS Safari and standalone HTML.
 */
(function (global) {
  'use strict';

  const US = '\x1f';

  // --- 1. Gzip / Deflate helpers using Web Compression Streams API ---
  async function decompressBytes(uint8Array, format) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Browser does not support DecompressionStream');
    }
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(uint8Array);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  async function decompressBase64Gzip(b64String) {
    const bin = atob(b64String);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const decompressed = await decompressBytes(bytes, 'gzip');
    const text = new TextDecoder('utf-8').decode(decompressed);
    return JSON.parse(text);
  }

  // --- 2. Pure-JS ZIP Reader (.apkg / .colpkg) ---
  async function parseZipArchive(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.byteLength;

    // Locate End of Central Directory (EOCD) signature 0x06054b50
    let eocdPos = -1;
    const minEocd = Math.max(0, len - 65557);
    for (let i = len - 22; i >= minEocd; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos < 0) {
      throw new Error('Invalid ZIP archive: EOCD signature not found');
    }

    const totalEntries = view.getUint16(eocdPos + 10, true);
    const cdOffset = view.getUint32(eocdPos + 16, true);
    const entries = new Map();
    const decoder = new TextDecoder('utf-8');

    let pos = cdOffset;
    for (let idx = 0; idx < totalEntries && pos < len; idx++) {
      const sig = view.getUint32(pos, true);
      if (sig !== 0x02014b50) break;
      const compressionMethod = view.getUint16(pos + 10, true);
      const compressedSize = view.getUint32(pos + 20, true);
      const uncompressedSize = view.getUint32(pos + 24, true);
      const fileNameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);

      const fileName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + fileNameLen));
      pos += 46 + fileNameLen + extraLen + commentLen;

      // Read local file header at localHeaderOffset
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) continue;
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const rawSlice = bytes.subarray(dataStart, dataStart + compressedSize);

      entries.set(fileName, {
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        rawSlice,
        async extract() {
          if (compressionMethod === 0) {
            return rawSlice.slice();
          } else if (compressionMethod === 8) {
            return await decompressBytes(rawSlice, 'deflate-raw');
          } else {
            throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${fileName}`);
          }
        }
      });
    }
    return entries;
  }

  // --- 3. Anki v18 Protobuf Wire Decoder ---
  function parseProtobufFields(uint8) {
    let pos = 0;
    const out = {};
    const decoder = new TextDecoder('utf-8');
    while (pos < uint8.length) {
      const tagByte = uint8[pos++];
      const fieldNum = tagByte >> 3;
      const wireType = tagByte & 0x07;
      if (wireType === 0) {
        let val = 0;
        let shift = 0;
        while (pos < uint8.length) {
          const b = uint8[pos++];
          val |= (b & 0x7f) * Math.pow(2, shift);
          if (!(b & 0x80)) break;
          shift += 7;
        }
        out[fieldNum] = val;
      } else if (wireType === 2) {
        let length = 0;
        let shift = 0;
        while (pos < uint8.length) {
          const b = uint8[pos++];
          length |= (b & 0x7f) << shift;
          if (!(b & 0x80)) break;
          shift += 7;
        }
        const slice = uint8.subarray(pos, pos + length);
        pos += length;
        try {
          out[fieldNum] = decoder.decode(slice);
        } catch (_e) {
          out[fieldNum] = slice;
        }
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 5) {
        pos += 4;
      } else {
        break;
      }
    }
    return out;
  }

  // --- 4. Pure-JS SQLite 3 B-Tree Table Reader ---
  function readVarint(bytes, offset) {
    let value = 0;
    for (let i = 0; i < 8; i++) {
      const b = bytes[offset + i];
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) {
        return { value, length: i + 1 };
      }
    }
    const b9 = bytes[offset + 8];
    value = value * 256 + b9;
    return { value, length: 9 };
  }

  function readSignedIntBig(bytes, offset, byteLen) {
    if (byteLen === 1) {
      const v = bytes[offset];
      return v & 0x80 ? v - 256 : v;
    }
    if (byteLen === 2) {
      const v = (bytes[offset] << 8) | bytes[offset + 1];
      return v & 0x8000 ? v - 65536 : v;
    }
    if (byteLen === 3) {
      const v = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
      return v & 0x800000 ? v - 16777216 : v;
    }
    if (byteLen === 4) {
      return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, false);
    }
    // 6 or 8 bytes: use safe JS number conversion
    let hi = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, false);
    let result = hi;
    for (let i = 4; i < byteLen; i++) {
      result = result * 256 + bytes[offset + i];
    }
    return result;
  }

  function parseSqliteDatabase(uint8) {
    const headerStr = new TextDecoder('ascii').decode(uint8.subarray(0, 15));
    if (headerStr !== 'SQLite format 3') {
      throw new Error('Not a valid SQLite 3 database file');
    }
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let pageSize = view.getUint16(16, false);
    if (pageSize === 1) pageSize = 65536;
    const reservedSpace = uint8[20];
    const usableSize = pageSize - reservedSpace;
    const textDecoder = new TextDecoder('utf-8');

    function getPageBytes(pageNum) {
      const start = (pageNum - 1) * pageSize;
      return uint8.subarray(start, start + pageSize);
    }

    function readLeafPayload(pageBytes, cellOffset, payloadSize) {
      const maxLocal = usableSize - 35;
      const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
      let localSize = payloadSize;
      if (payloadSize > maxLocal) {
        const k = minLocal + ((payloadSize - minLocal) % (usableSize - 4));
        localSize = k <= maxLocal ? k : minLocal;
      }
      if (localSize === payloadSize) {
        return pageBytes.subarray(cellOffset, cellOffset + payloadSize);
      }
      const full = new Uint8Array(payloadSize);
      full.set(pageBytes.subarray(cellOffset, cellOffset + localSize), 0);
      let written = localSize;
      let nextOverflowPage = new DataView(
        pageBytes.buffer,
        pageBytes.byteOffset + cellOffset + localSize,
        4
      ).getUint32(0, false);

      while (nextOverflowPage > 0 && written < payloadSize) {
        const ovPage = getPageBytes(nextOverflowPage);
        const ovView = new DataView(ovPage.buffer, ovPage.byteOffset, ovPage.byteLength);
        nextOverflowPage = ovView.getUint32(0, false);
        const chunkLen = Math.min(usableSize - 4, payloadSize - written);
        full.set(ovPage.subarray(4, 4 + chunkLen), written);
        written += chunkLen;
      }
      return full;
    }

    function decodeRecord(payload, rowId) {
      const hdrVar = readVarint(payload, 0);
      const headerSize = hdrVar.value;
      let hPos = hdrVar.length;
      const serialTypes = [];
      while (hPos < headerSize) {
        const st = readVarint(payload, hPos);
        serialTypes.push(st.value);
        hPos += st.length;
      }
      let bPos = headerSize;
      const values = [];
      for (let i = 0; i < serialTypes.length; i++) {
        const st = serialTypes[i];
        if (st === 0) {
          values.push(null);
        } else if (st === 1) {
          values.push(readSignedIntBig(payload, bPos, 1));
          bPos += 1;
        } else if (st === 2) {
          values.push(readSignedIntBig(payload, bPos, 2));
          bPos += 2;
        } else if (st === 3) {
          values.push(readSignedIntBig(payload, bPos, 3));
          bPos += 3;
        } else if (st === 4) {
          values.push(readSignedIntBig(payload, bPos, 4));
          bPos += 4;
        } else if (st === 5) {
          values.push(readSignedIntBig(payload, bPos, 6));
          bPos += 6;
        } else if (st === 6) {
          values.push(readSignedIntBig(payload, bPos, 8));
          bPos += 8;
        } else if (st === 7) {
          const dv = new DataView(payload.buffer, payload.byteOffset + bPos, 8);
          values.push(dv.getFloat64(0, false));
          bPos += 8;
        } else if (st === 8) {
          values.push(0);
        } else if (st === 9) {
          values.push(1);
        } else if (st >= 12 && st % 2 === 0) {
          const blobLen = (st - 12) / 2;
          values.push(payload.subarray(bPos, bPos + blobLen));
          bPos += blobLen;
        } else if (st >= 13 && st % 2 === 1) {
          const strLen = (st - 13) / 2;
          values.push(textDecoder.decode(payload.subarray(bPos, bPos + strLen)));
          bPos += strLen;
        } else {
          values.push(null);
        }
      }
      return { rowId, values };
    }

    function readTableBTree(pageNum, rowsOut) {
      const pageBytes = getPageBytes(pageNum);
      const bhOffset = pageNum === 1 ? 100 : 0;
      const pageType = pageBytes[bhOffset];
      const pView = new DataView(pageBytes.buffer, pageBytes.byteOffset, pageBytes.byteLength);
      const cellCount = pView.getUint16(bhOffset + 3, false);

      if (pageType === 0x0d) {
        // Leaf table b-tree page
        const ptrStart = bhOffset + 8;
        for (let i = 0; i < cellCount; i++) {
          const cellOffset = pView.getUint16(ptrStart + i * 2, false);
          const pSizeVar = readVarint(pageBytes, cellOffset);
          const rowIdVar = readVarint(pageBytes, cellOffset + pSizeVar.length);
          const dataOffset = cellOffset + pSizeVar.length + rowIdVar.length;
          const payload = readLeafPayload(pageBytes, dataOffset, pSizeVar.value);
          rowsOut.push(decodeRecord(payload, rowIdVar.value));
        }
      } else if (pageType === 0x05) {
        // Interior table b-tree page
        const rightMostPage = pView.getUint32(bhOffset + 8, false);
        const ptrStart = bhOffset + 12;
        for (let i = 0; i < cellCount; i++) {
          const cellOffset = pView.getUint16(ptrStart + i * 2, false);
          const leftChildPage = pView.getUint32(cellOffset, false);
          readTableBTree(leftChildPage, rowsOut);
        }
        readTableBTree(rightMostPage, rowsOut);
      } else if (pageType === 0x0a) {
        // Leaf index b-tree page (used by WITHOUT ROWID tables like fields, templates, deck_config)
        const ptrStart = bhOffset + 8;
        for (let i = 0; i < cellCount; i++) {
          const cellOffset = pView.getUint16(ptrStart + i * 2, false);
          const pSizeVar = readVarint(pageBytes, cellOffset);
          const dataOffset = cellOffset + pSizeVar.length;
          const payload = readLeafPayload(pageBytes, dataOffset, pSizeVar.value);
          rowsOut.push(decodeRecord(payload, null));
        }
      } else if (pageType === 0x02) {
        // Interior index b-tree page (used by WITHOUT ROWID tables)
        const rightMostPage = pView.getUint32(bhOffset + 8, false);
        const ptrStart = bhOffset + 12;
        for (let i = 0; i < cellCount; i++) {
          const cellOffset = pView.getUint16(ptrStart + i * 2, false);
          const leftChildPage = pView.getUint32(cellOffset, false);
          readTableBTree(leftChildPage, rowsOut);
          const pSizeVar = readVarint(pageBytes, cellOffset + 4);
          const dataOffset = cellOffset + 4 + pSizeVar.length;
          const payload = readLeafPayload(pageBytes, dataOffset, pSizeVar.value);
          rowsOut.push(decodeRecord(payload, null));
        }
        readTableBTree(rightMostPage, rowsOut);
      }
      return rowsOut;
    }

    // Read sqlite_master from page 1
    const masterRows = readTableBTree(1, []);
    const tables = {};
    for (const r of masterRows) {
      const [type, name, tblName, rootpage, sql] = r.values;
      if (type === 'table' && rootpage > 0) {
        tables[name] = { name, tblName, rootpage, sql };
      }
    }

    return {
      tables,
      readTable(tableName) {
        const info = tables[tableName];
        if (!info) return [];
        return readTableBTree(info.rootpage, []);
      }
    };
  }

  // --- 5. Convert SQLite Anki Database (v11 or v18) to Normalized Collection Object ---
  function convertAnkiSqliteToCollection(uint8) {
    const db = parseSqliteDatabase(uint8);
    const colRows = db.readTable('col');
    let crt = Math.floor(Date.now() / 1000) - 86400;
    let ver = 18;
    let legacyModelsJson = null;
    let legacyDecksJson = null;

    if (colRows.length > 0) {
      const c = colRows[0].values;
      // col schema: id(0), crt(1), mod(2), scm(3), ver(4), dty(5), usn(6), ls(7), conf(8), models(9), decks(10), dconf(11), tags(12)
      if (c[1]) crt = c[1];
      if (c[4]) ver = c[4];
      if (typeof c[9] === 'string' && c[9].length > 2) legacyModelsJson = c[9];
      if (typeof c[10] === 'string' && c[10].length > 2) legacyDecksJson = c[10];
    }

    const decks = {};
    if (db.tables.decks) {
      for (const r of db.readTable('decks')) {
        const did = String(r.values[0] !== null ? r.values[0] : r.rowId);
        const name = String(r.values[1] || '預設').replace(/\x1f/g, '::');
        decks[did] = name;
      }
    } else if (legacyDecksJson) {
      try {
        const parsedDecks = JSON.parse(legacyDecksJson);
        for (const [did, dObj] of Object.entries(parsedDecks)) {
          decks[String(did)] = String(dObj.name || '預設').replace(/\x1f/g, '::');
        }
      } catch (_e) {}
    }

    const notetypes = {};
    if (db.tables.notetypes) {
      for (const r of db.readTable('notetypes')) {
        const mid = String(r.values[0] !== null ? r.values[0] : r.rowId);
        const name = String(r.values[1] || 'Basic');
        const cfgBytes = r.values[3];
        let css = '';
        let isCloze = false;
        if (cfgBytes instanceof Uint8Array) {
          const pb = parseProtobufFields(cfgBytes);
          css = typeof pb[3] === 'string' ? pb[3] : '';
          isCloze = pb[1] === 1;
        }
        notetypes[mid] = { id: mid, name, css, isCloze, fields: [], templates: [] };
      }
      if (db.tables.fields) {
        const fieldRows = db.readTable('fields');
        fieldRows.sort((a, b) => (a.values[1] || 0) - (b.values[1] || 0));
        for (const r of fieldRows) {
          const ntid = String(r.values[0]);
          const fname = String(r.values[2] || '');
          if (notetypes[ntid]) {
            notetypes[ntid].fields.push(fname);
          }
        }
      }
      if (db.tables.templates) {
        const tmplRows = db.readTable('templates');
        tmplRows.sort((a, b) => (a.values[1] || 0) - (b.values[1] || 0));
        for (const r of tmplRows) {
          const ntid = String(r.values[0]);
          const ord = Number(r.values[1] || 0);
          const tname = String(r.values[2] || `Card ${ord + 1}`);
          const tcfg = r.values[4];
          let qfmt = '';
          let afmt = '';
          if (tcfg instanceof Uint8Array) {
            const pb = parseProtobufFields(tcfg);
            qfmt = typeof pb[1] === 'string' ? pb[1] : '';
            afmt = typeof pb[2] === 'string' ? pb[2] : '';
          }
          if (notetypes[ntid]) {
            notetypes[ntid].templates.push({ ord, name: tname, qfmt, afmt });
          }
        }
      }
    } else if (legacyModelsJson) {
      try {
        const parsedModels = JSON.parse(legacyModelsJson);
        for (const [mid, mObj] of Object.entries(parsedModels)) {
          notetypes[String(mid)] = {
            id: String(mid),
            name: mObj.name || 'Basic',
            css: mObj.css || '',
            isCloze: mObj.type === 1,
            fields: (mObj.flds || []).map((f) => f.name),
            templates: (mObj.tmpls || []).map((t, idx) => ({
              ord: t.ord !== undefined ? t.ord : idx,
              name: t.name || `Card ${idx + 1}`,
              qfmt: t.qfmt || '',
              afmt: t.afmt || ''
            }))
          };
        }
      } catch (_e) {}
    }

    const notes = {};
    for (const r of db.readTable('notes')) {
      // notes schema: id(0), guid(1), mid(2), mod(3), usn(4), tags(5), flds(6), sfld(7)...
      const nid = String(r.values[0] !== null ? r.values[0] : r.rowId);
      const mid = String(r.values[2]);
      const tags = String(r.values[5] || '').trim();
      const fldsRaw = String(r.values[6] || '');
      notes[nid] = [mid, fldsRaw.split(US), tags];
    }

    const cards = [];
    for (const r of db.readTable('cards')) {
      // cards schema: id(0), nid(1), did(2), ord(3), mod(4), usn(5), type(6), queue(7), due(8), ivl(9), factor(10), reps(11), lapses(12)
      const v = r.values;
      const cid = String(v[0] !== null ? v[0] : r.rowId);
      const nid = String(v[1]);
      const did = String(v[2]);
      const ord = Number(v[3] || 0);
      const type = Number(v[6] || 0);
      const queue = Number(v[7] || 0);
      const due = Number(v[8] || 0);
      const ivl = Number(v[9] || 0);
      const factor = Number(v[10] || 0);
      const reps = Number(v[11] || 0);
      const lapses = Number(v[12] || 0);
      cards.push([cid, nid, did, ord, type, queue, due, ivl, factor, reps, lapses]);
    }

    const revlog = [];
    if (db.tables.revlog) {
      for (const r of db.readTable('revlog')) {
        const v = r.values;
        const id = Number(v[0] !== null ? v[0] : r.rowId);
        revlog.push([
          id,
          String(v[1]),
          Number(v[3] || 3),
          Number(v[4] || 0),
          Number(v[5] || 0),
          Number(v[6] || 2500),
          Number(v[7] || 0),
          Number(v[8] || 0)
        ]);
      }
    }

    return { crt, ver, decks, notetypes, notes, cards, revlog, mediaBlobs: {} };
  }

  // --- 6. High-level File Importer (.apkg, .colpkg, .anki2, .json) ---
  async function importAnkiFile(fileOrBuffer, fileName = '') {
    const buffer =
      fileOrBuffer instanceof ArrayBuffer
        ? fileOrBuffer
        : await fileOrBuffer.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const nameLower = (fileName || (fileOrBuffer && fileOrBuffer.name) || '').toLowerCase();

    // Case 1: Direct SQLite 3 database (.anki2 / .anki21 / .db)
    if (bytes.length > 16) {
      const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 15));
      if (magic === 'SQLite format 3') {
        return convertAnkiSqliteToCollection(bytes);
      }
    }

    // Case 2: ZIP archive (.apkg / .colpkg)
    if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const entries = await parseZipArchive(buffer);
      const dbEntry =
        entries.get('collection.anki21') ||
        entries.get('collection.anki2') ||
        Array.from(entries.values()).find((e) => e.fileName.endsWith('.anki2') || e.fileName.endsWith('.anki21'));

      if (!dbEntry) {
        if (entries.has('collection.anki21b')) {
          throw new Error(
            '此 .colpkg/.apkg 使用 Zstandard (collection.anki21b) 壓縮格式。請於 Anki 匯出時勾選「支援舊版 Anki (Support older Anki versions)」，或直接匯入 collection.anki2 / JSON。'
          );
        }
        throw new Error('ZIP 檔案中找不到 collection.anki2 或 collection.anki21 資料庫');
      }

      const dbBytes = await dbEntry.extract();
      const collection = convertAnkiSqliteToCollection(dbBytes);

      // Parse media mapping if present
      if (entries.has('media')) {
        try {
          const mediaRaw = await entries.get('media').extract();
          const mediaText = new TextDecoder('utf-8').decode(mediaRaw);
          if (mediaText.trim().startsWith('{')) {
            const mediaMap = JSON.parse(mediaText);
            for (const [zipKey, realMediaName] of Object.entries(mediaMap)) {
              if (entries.has(zipKey)) {
                const mediaBytes = await entries.get(zipKey).extract();
                const ext = realMediaName.split('.').pop().toLowerCase();
                const mime =
                  ext === 'mp3'
                    ? 'audio/mpeg'
                    : ext === 'jpg' || ext === 'jpeg'
                    ? 'image/jpeg'
                    : ext === 'png'
                    ? 'image/png'
                    : 'application/octet-stream';
                collection.mediaBlobs[realMediaName] = new Blob([mediaBytes], { type: mime });
              }
            }
          }
        } catch (_e) {
          // Ignore malformed media mapping
        }
      }
      return collection;
    }

    // Case 3: Gzipped JSON (.json.gz)
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const decompressed = await decompressBytes(bytes, 'gzip');
      const obj = JSON.parse(new TextDecoder('utf-8').decode(decompressed));
      return normalizeJsonImport(obj, nameLower);
    }

    // Case 4: Plain JSON (fullbook.json, unit01.audio.json, or exported collection/progress JSON)
    const text = new TextDecoder('utf-8').decode(bytes);
    const obj = JSON.parse(text);
    return normalizeJsonImport(obj, nameLower);
  }

  function normalizeJsonImport(obj, fileName) {
    // Already a normalized collection object
    if (obj && obj.decks && obj.notes && obj.cards && obj.notetypes) {
      return obj;
    }
    // Progress backup JSON
    if (obj && obj.kind === 'anki-ios-pwa-progress') {
      return obj;
    }
    // E62 fullbook.json or unitXX.json format (array of items with id, term, partOfSpeech, meaningZh, example, exampleZh...)
    const items = Array.isArray(obj) ? obj : Array.isArray(obj.items) ? obj.items : null;
    if (items && items.length > 0 && items[0].term) {
      return convertE62JsonItemsToCollection(items, fileName);
    }
    throw new Error('無法識別的 JSON 格式');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function convertE62JsonItemsToCollection(items, fileName) {
    const mid = '1792091008095';
    const groups = new Map();
    for (const item of items) {
      const unitNum = item.unit || 1;
      const unitStr = String(unitNum).padStart(2, '0');
      const key = `${unitStr}__${item.term.toLowerCase()}__${item.partOfSpeech}`;
      if (!groups.has(key)) {
        groups.set(key, {
          unitStr,
          term: item.term,
          pos: item.partOfSpeech,
          entries: []
        });
      }
      groups.get(key).entries.push(item);
    }

    const decks = {};
    const notes = {};
    const cards = [];
    let seq = 1;

    for (const g of groups.values()) {
      const did = String(9000000 + Number(g.unitStr));
      decks[did] = `E62 匯入牌組::Unit ${g.unitStr}`;
      const nid = String(9100000 + seq);
      const cid = String(9200000 + seq);
      const cardIdStr = `e62_u${g.unitStr}_${g.term.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${g.pos.replace(/[^a-z0-9]+/g, '')}`;

      const exLis = g.entries
        .map((e) => `<li><div class="example-line">${escapeHtml(e.example || '')}</div></li>`)
        .join('');
      const usLis = g.entries
        .map(
          (e) =>
            `<li><div class="usage-head"><span class="usage-pos">${escapeHtml(
              e.partOfSpeech
            )}</span><span class="usage-meaning">${escapeHtml(e.meaningZh || '')}</span> ${
              e.phoneticKK ? `<span class="usage-kk">${escapeHtml(e.phoneticKK)}</span>` : ''
            }</div><div class="usage-en">${escapeHtml(e.example || '')}</div><div class="usage-zh">${escapeHtml(
              e.exampleZh || ''
            )}</div>${e.extra ? `<div class="usage-extra">${escapeHtml(e.extra)}</div>` : ''}</li>`
        )
        .join('');

      notes[nid] = [
        mid,
        [
          cardIdStr,
          g.term,
          g.pos,
          `<ol class="examples">${exLis}</ol>`,
          `<ol class="usages">${usLis}</ol>`,
          fileName || 'E62 JSON Import'
        ],
        `e62 unit${g.unitStr}`
      ];
      cards.push([cid, nid, did, 0, 0, 0, seq, 0, 0, 0, 0]);
      seq++;
    }

    return {
      crt: Math.floor(Date.now() / 1000) - 86400,
      ver: 18,
      decks,
      notetypes: {},
      notes,
      cards,
      revlog: [],
      mediaBlobs: {}
    };
  }

  global.AnkiSqliteApkg = {
    decompressBytes,
    decompressBase64Gzip,
    parseZipArchive,
    parseProtobufFields,
    parseSqliteDatabase,
    convertAnkiSqliteToCollection,
    importAnkiFile
  };
})(typeof window !== 'undefined' ? window : globalThis);
