/**
 * Anki iOS Offline PWA Main Application Controller
 * Supports 100% offline iOS Safari study, IndexedDB persistence, E62 50-Unit & 29,603-card full library,
 * client-side .apkg/.colpkg/.anki2/JSON import, and Web Speech API + native MP3 audio playback.
 */
(function (global) {
  'use strict';

  const { decompressBase64Gzip, importAnkiFile, readDeckPackMeta, forEachStoredZipEntry } = global.AnkiSqliteApkg;
  const { stripHtml, escapeHtml, renderAnkiCard } = global.AnkiRenderer;
  const {
    getTodayDays,
    computeNextState,
    previewAllIntervals,
    buildDeckTree,
    buildStudyQueue
  } = global.AnkiScheduler;

  const DB_NAME = 'anki_ios_pwa_db_v1';
  const DB_VERSION = 2;

  const state = {
    collection: null,
    unit01AudioMap: {},
    expandedDecks: new Set(),
    installedPacks: new Map(), // pack id -> { id, title, deckPath, version, bytes, files, names }
    importingPack: null, // { title, done, total } while a media pack is being imported
    mediaModalPath: null,
    activeDeckPath: 'E62 English2000 全書::Unit 01',
    activeTab: 'decks',
    studyQueue: [],
    studyCounts: { newRemaining: 0, lrnRemaining: 0, revRemaining: 0 },
    currentCard: null,
    isAnswerShown: false,
    cardStartTimeMs: 0,
    typedAnswer: '',
    undoStack: [],
    nightMode: false,
    autoPlayAudio: false,
    newLimitPerSession: 50,
    revLimitPerSession: 200,
    browserQuery: '',
    browserDeckFilter: 'ALL',
    browserStateFilter: 'ALL',
    idb: null,
    modifiedCardsMap: new Map(),
    customRevlog: []
  };

  // --- IndexedDB Persistence ---
  function openDatabase() {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) {
          resolve(null);
          return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('card_states')) {
            db.createObjectStore('card_states', { keyPath: 'cid' });
          }
          if (!db.objectStoreNames.contains('revlog')) {
            db.createObjectStore('revlog', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('media_blobs')) {
            db.createObjectStore('media_blobs', { keyPath: 'name' });
          }
          if (!db.objectStoreNames.contains('custom_decks')) {
            db.createObjectStore('custom_decks', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('media_packs')) {
            db.createObjectStore('media_packs', { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
      } catch (_err) {
        resolve(null);
      }
    });
  }

  async function loadPersistedProgress() {
    // Also read localStorage fallback for file:// standalone environments
    try {
      const lsRaw = localStorage.getItem('anki_ios_pwa_progress_v1');
      if (lsRaw) {
        const parsed = JSON.parse(lsRaw);
        if (parsed.cards) {
          for (const [cid, tuple] of Object.entries(parsed.cards)) {
            state.modifiedCardsMap.set(String(cid), tuple);
          }
        }
        if (Array.isArray(parsed.revlog)) {
          state.customRevlog = parsed.revlog;
        }
      }
    } catch (_e) {}

    if (!state.idb) return;
    await new Promise((resolve) => {
      const tx = state.idb.transaction(['card_states', 'revlog'], 'readonly');
      const csStore = tx.objectStore('card_states');
      const rvStore = tx.objectStore('revlog');

      csStore.getAll().onsuccess = (e) => {
        for (const item of e.target.result || []) {
          state.modifiedCardsMap.set(String(item.cid), item.tuple);
        }
      };
      rvStore.getAll().onsuccess = (e) => {
        const rows = e.target.result || [];
        if (rows.length > state.customRevlog.length) {
          state.customRevlog = rows.map((r) => r.entry);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  function saveCardProgress(cardTuple, revlogEntry) {
    const cid = String(cardTuple[0]);
    state.modifiedCardsMap.set(cid, cardTuple.slice());
    if (revlogEntry) {
      state.customRevlog.push(revlogEntry);
    }

    // Save to localStorage for instant file:// persistence
    try {
      const cardsObj = {};
      for (const [k, v] of state.modifiedCardsMap.entries()) {
        cardsObj[k] = v;
      }
      localStorage.setItem(
        'anki_ios_pwa_progress_v1',
        JSON.stringify({
          updatedAt: Date.now(),
          cards: cardsObj,
          revlog: state.customRevlog.slice(-2000)
        })
      );
    } catch (_e) {}

    // Save to IndexedDB
    if (state.idb) {
      try {
        const tx = state.idb.transaction(['card_states', 'revlog'], 'readwrite');
        tx.objectStore('card_states').put({ cid, tuple: cardTuple.slice() });
        if (revlogEntry) {
          tx.objectStore('revlog').put({ id: revlogEntry[0], entry: revlogEntry });
        }
      } catch (_e) {}
    }
  }

  function applyModifiedCardsToCollection(col) {
    if (!col || !col.cards) return;
    for (let i = 0; i < col.cards.length; i++) {
      const bundleCard = col.cards[i];
      const cid = String(bundleCard[0]);
      if (state.modifiedCardsMap.has(cid)) {
        const localCard = state.modifiedCardsMap.get(cid);
        const bundleReps = Number(bundleCard[9] || 0);
        const localReps = Number(localCard[9] || 0);
        if (localReps >= bundleReps) {
          col.cards[i] = localCard.slice();
        } else {
          // Bundle from Anki.app has newer reviews; update local map to match
          state.modifiedCardsMap.set(cid, bundleCard.slice());
        }
      }
    }
  }

  // --- Toast Helper ---
  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('toast-banner');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('visible');
    }, 2600);
  }

  // --- Audio & iOS Offline Web Speech API Playback ---
  // IMPORTANT (iOS Safari / WebKit): audio.play() and speechSynthesis.speak() must be
  // invoked synchronously inside the user's tap handler. Any `await` before them
  // (IndexedDB lookups, failing network requests) revokes the user-gesture activation
  // and WebKit silently drops the playback. Everything below is therefore synchronous.
  let currentAudioEl = null;
  let activeUtterance = null; // strong reference so WebKit GC never kills speech mid-way
  let cachedVoices = [];
  const mediaBlobUrlMap = new Map(); // fileName -> blob: URL (populated from IDB/imports)

  function refreshVoices() {
    try {
      const v = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      if (v && v.length) cachedVoices = v;
    } catch (_e) {}
  }

  function registerMediaBlob(fileName, blob) {
    if (!fileName || !blob || mediaBlobUrlMap.has(fileName)) return;
    try {
      mediaBlobUrlMap.set(fileName, URL.createObjectURL(blob));
    } catch (_e) {}
  }

  // Media blobs are NOT preloaded (a full library is ~30k files). Each rendered card asks IndexedDB
  // for just the files it references, and registers blob: URLs before the user can tap play, so
  // playback itself stays synchronous.
  const mediaChecked = new Set(); // names already looked up in IndexedDB (hit or miss)

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function ensureMediaBlobs(names) {
    const wanted = [...new Set(names)].filter((n) => n && !mediaBlobUrlMap.has(n) && !mediaChecked.has(n));
    if (!state.idb || wanted.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = state.idb.transaction(['media_blobs'], 'readonly');
        const store = tx.objectStore('media_blobs');
        for (const name of wanted) {
          store.get(name).onsuccess = (e) => {
            mediaChecked.add(name);
            const rec = e.target.result;
            if (rec && rec.blob) registerMediaBlob(name, rec.blob);
          };
        }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch (_e) {
        resolve();
      }
    });
  }

  // Resolves once every sound / image referenced inside `container` has a blob URL (if stored offline).
  async function hydrateMedia(container) {
    if (!container) return;
    const imgs = Array.from(container.querySelectorAll('img[data-media-src]'));
    const sounds = Array.from(container.querySelectorAll('[data-sound]'));
    const names = imgs
      .map((i) => i.getAttribute('data-media-src'))
      .concat(sounds.map((el) => el.getAttribute('data-sound')));
    await ensureMediaBlobs(names);
    for (const img of imgs) {
      const url = mediaBlobUrlMap.get(img.getAttribute('data-media-src'));
      if (url && img.getAttribute('src') !== url) {
        img.removeAttribute('onerror');
        img.style.display = '';
        img.src = url;
      }
    }
  }

  // --- Offline media packs (one .zip per deck, AirDropped from scripts/build_media_packs.py) ---
  function mediaManifest() {
    return Array.isArray(global.ANKI_MEDIA_PACKS) ? global.ANKI_MEDIA_PACKS : [];
  }

  function formatBytes(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
    return `${Math.max(1, Math.round(n / 1e3))} KB`;
  }

  // Manifest packs merged with whatever is installed (installed packs may not be in the manifest).
  function allKnownPacks() {
    const byId = new Map();
    for (const m of mediaManifest()) byId.set(m.id, { ...m, installed: null });
    for (const rec of state.installedPacks.values()) {
      const base = byId.get(rec.id) || {
        id: rec.id,
        title: rec.title,
        deckPath: rec.deckPath,
        version: rec.version,
        files: rec.files,
        bytes: rec.bytes,
        missing: 0,
        zip: ''
      };
      byId.set(rec.id, { ...base, installed: rec });
    }
    return Array.from(byId.values());
  }

  function packsUnder(deckPath) {
    return allKnownPacks().filter(
      (p) => !deckPath || p.deckPath === deckPath || p.deckPath.startsWith(deckPath + '::')
    );
  }

  async function loadInstalledPacks() {
    if (!state.idb) return;
    try {
      const tx = state.idb.transaction(['media_packs'], 'readonly');
      const rows = await idbRequest(tx.objectStore('media_packs').getAll());
      for (const rec of rows || []) state.installedPacks.set(rec.id, rec);
    } catch (_e) {}
  }

  async function removeMediaPack(packId) {
    const rec = state.installedPacks.get(packId);
    if (!rec || !state.idb) return;
    const keep = new Set();
    for (const other of state.installedPacks.values()) {
      if (other.id !== packId) for (const n of other.names || []) keep.add(n);
    }
    const doomed = (rec.names || []).filter((n) => !keep.has(n));
    for (let i = 0; i < doomed.length; i += 500) {
      const tx = state.idb.transaction(['media_blobs'], 'readwrite');
      const store = tx.objectStore('media_blobs');
      for (const n of doomed.slice(i, i + 500)) store.delete(n);
      await idbTxDone(tx);
    }
    for (const n of doomed) {
      const url = mediaBlobUrlMap.get(n);
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (_e) {}
        mediaBlobUrlMap.delete(n);
      }
      mediaChecked.delete(n);
    }
    const tx = state.idb.transaction(['media_packs'], 'readwrite');
    tx.objectStore('media_packs').delete(packId);
    await idbTxDone(tx);
    state.installedPacks.delete(packId);
  }

  async function importDeckPack(file, parsed) {
    const { meta, entries } = parsed;
    if (!state.idb) throw new Error('此瀏覽器無法使用 IndexedDB，無法離線儲存音檔');
    const list = meta.files
      .map(([name]) => entries.get('media/' + name))
      .filter(Boolean);
    const totalBytes = meta.files.reduce((sum, [, size]) => sum + size, 0);

    if (navigator.storage) {
      try {
        if (navigator.storage.persist) await navigator.storage.persist();
        if (navigator.storage.estimate) {
          const { quota, usage } = await navigator.storage.estimate();
          if (quota && quota - (usage || 0) < totalBytes * 1.1) {
            throw new Error(
              `儲存空間不足：需要約 ${formatBytes(totalBytes)}，剩餘 ${formatBytes(quota - (usage || 0))}`
            );
          }
        }
      } catch (err) {
        if (/儲存空間不足/.test(err.message)) throw err;
      }
    }

    const previous = state.installedPacks.get(meta.id);
    state.importingPack = { title: meta.title, done: 0, total: list.length };
    refreshMediaViews();

    const written = [];
    let batch = [];
    let batchBytes = 0;
    let lastToast = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const tx = state.idb.transaction(['media_blobs'], 'readwrite');
      const store = tx.objectStore('media_blobs');
      for (const rec of batch) store.put(rec);
      await idbTxDone(tx);
      batch = [];
      batchBytes = 0;
    };

    try {
      await forEachStoredZipEntry(file, list, async (entry, bytes) => {
        const name = entry.name.slice('media/'.length);
        const ext = name.split('.').pop().toLowerCase();
        const mime =
          ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg'
          : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
        batch.push({ name, blob: new Blob([bytes], { type: mime }) });
        written.push(name);
        batchBytes += bytes.length;
        if (batch.length >= 300 || batchBytes >= 16 * 1024 * 1024) await flush();
        // A re-import replaces the file, so drop any stale blob: URL for it
        const stale = mediaBlobUrlMap.get(name);
        if (stale) {
          try {
            URL.revokeObjectURL(stale);
          } catch (_e) {}
          mediaBlobUrlMap.delete(name);
        }
        mediaChecked.delete(name);
        state.importingPack.done = written.length;
        if (Date.now() - lastToast > 400) {
          lastToast = Date.now();
          showToast(`匯入「${meta.title}」${written.length} / ${list.length}`);
          refreshMediaViews();
        }
      });
      await flush();

      const rec = {
        id: meta.id,
        title: meta.title,
        deckPath: meta.deckPath,
        version: meta.version,
        files: written.length,
        bytes: totalBytes,
        installedAt: Date.now(),
        names: written
      };
      const tx = state.idb.transaction(['media_packs'], 'readwrite');
      tx.objectStore('media_packs').put(rec);
      await idbTxDone(tx);
      state.installedPacks.set(rec.id, rec);

      // Re-import of an older version: drop files the new version no longer contains
      if (previous) {
        const stillUsed = new Set(written);
        for (const other of state.installedPacks.values()) {
          if (other.id !== rec.id) for (const n of other.names || []) stillUsed.add(n);
        }
        const gone = (previous.names || []).filter((n) => !stillUsed.has(n));
        if (gone.length) {
          const dtx = state.idb.transaction(['media_blobs'], 'readwrite');
          for (const n of gone) dtx.objectStore('media_blobs').delete(n);
          await idbTxDone(dtx);
        }
      }
      return rec;
    } catch (err) {
      // Best effort: don't leave an unowned half-imported pack in storage
      try {
        const keep = new Set();
        for (const other of state.installedPacks.values()) for (const n of other.names || []) keep.add(n);
        const orphan = written.filter((n) => !keep.has(n));
        if (orphan.length && state.idb) {
          const tx = state.idb.transaction(['media_blobs'], 'readwrite');
          for (const n of orphan) tx.objectStore('media_blobs').delete(n);
        }
      } catch (_e) {}
      throw err;
    } finally {
      state.importingPack = null;
      refreshMediaViews();
    }
  }

  async function importMediaPackFiles(files) {
    let ok = 0;
    for (const file of files) {
      const parsed = await readDeckPackMeta(file);
      if (!parsed) {
        showToast(`「${file.name}」不是離線音檔包（請使用 build_media_packs.py 產生的 .zip）`);
        continue;
      }
      try {
        const rec = await importDeckPack(file, parsed);
        ok++;
        showToast(`已匯入「${rec.title}」：${rec.files.toLocaleString()} 個檔案 (${formatBytes(rec.bytes)})`);
      } catch (err) {
        const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));
        showToast(quota ? '儲存空間已滿，請先移除不用的牌組音檔' : `匯入失敗：${err.message || err}`);
        break;
      }
    }
    if (ok > 0 && state.activeTab === 'study') renderReviewerTab();
    refreshMediaViews();
  }

  function packStatusText(p) {
    if (!p.installed) return '尚未匯入';
    if (p.version && p.installed.version !== p.version) return '已匯入（有新版，請重新匯入）';
    return `已匯入 · ${p.installed.files.toLocaleString()} 個檔案`;
  }

  function mediaChipHtml(path) {
    const packs = packsUnder(path);
    if (packs.length === 0) return '';
    const done = packs.filter((p) => p.installed).length;
    const bytes = packs.reduce((sum, p) => sum + (p.bytes || 0), 0);
    let cls = 'none';
    let label = `⬇ 音檔 ${formatBytes(bytes)}`;
    if (done === packs.length) {
      cls = 'done';
      label = '🔊 已離線';
    } else if (done > 0) {
      cls = 'part';
      label = `🔊 ${done}/${packs.length}`;
    }
    return `<button class="media-chip ${cls}" type="button" data-media-deck="${escapeHtml(
      path
    )}" title="管理此牌組的離線音檔／圖片">${label}</button>`;
  }

  function renderMediaPackList(container, deckPath) {
    if (!container) return;
    const packs = packsUnder(deckPath);
    const importing = state.importingPack;
    const rows = packs
      .map((p) => {
        const busy = importing && importing.title === p.title;
        const pct = busy ? Math.round((importing.done / Math.max(1, importing.total)) * 100) : 0;
        const status = busy ? `匯入中 ${pct}%（${importing.done}/${importing.total}）` : packStatusText(p);
        return `
          <div class="media-pack-row">
            <div class="media-pack-info">
              <div class="media-pack-title">${escapeHtml(p.title)}</div>
              <div class="media-pack-meta">${p.files.toLocaleString()} 個檔案 · ${formatBytes(p.bytes)} · ${escapeHtml(status)}</div>
              ${p.missing ? `<div class="media-pack-meta">另有 ${p.missing.toLocaleString()} 個音檔不在電腦媒體庫，這些卡片會改用語音朗讀</div>` : ''}
              ${p.zip ? `<div class="media-pack-meta file">檔名：${escapeHtml(p.zip)}</div>` : ''}
              ${busy ? `<div class="media-progress"><span style="width:${pct}%"></span></div>` : ''}
            </div>
            ${
              p.installed && !busy
                ? `<button class="icon-btn" type="button" data-remove-pack="${escapeHtml(p.id)}">移除</button>`
                : ''
            }
          </div>`;
      })
      .join('');
    container.innerHTML =
      rows || '<p class="media-pack-meta">此牌組沒有需要離線的音檔或圖片。</p>';
    container.querySelectorAll('[data-remove-pack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-remove-pack');
        const p = state.installedPacks.get(id);
        if (!p || !window.confirm(`移除「${p.title}」的離線音檔／圖片？（複習進度不會受影響）`)) return;
        try {
          await removeMediaPack(id);
          showToast(`已移除「${p.title}」`);
        } catch (err) {
          showToast(`移除失敗：${err.message || err}`);
        }
        refreshMediaViews();
      });
    });
  }

  function refreshMediaViews() {
    const modal = document.getElementById('media-pack-modal');
    if (modal && modal.classList.contains('open')) {
      renderMediaPackList(document.getElementById('media-pack-list'), state.mediaModalPath);
    }
    renderMediaPackList(document.getElementById('media-pack-list-all'), null);
    if (state.activeTab === 'decks') renderDecksTab();
  }

  function openMediaModal(deckPath) {
    state.mediaModalPath = deckPath;
    document.getElementById('media-pack-modal-title').textContent = `離線音檔／圖片 · ${deckPath || '全部牌組'}`;
    renderMediaPackList(document.getElementById('media-pack-list'), deckPath);
    document.getElementById('media-pack-modal').classList.add('open');
  }

  // Only the local server.py mounts real Anki media under media/; static hosts
  // (GitHub Pages) and file:// do not. Probed once at startup so the tap handler
  // can decide synchronously without waiting for a 404.
  let mediaServerAvailable = false;
  function probeMediaServer() {
    if (!location.protocol.startsWith('http')) return Promise.resolve(false);
    return fetch('media/__probe__', { cache: 'no-store' })
      .then((r) => {
        mediaServerAvailable = r.ok && r.headers.get('X-Anki-Media') === '1';
        return mediaServerAvailable;
      })
      .catch(() => false);
  }

  function speakViaWebSpeech(text, lang = 'en-US') {
    const synth = window.speechSynthesis;
    if (!text || !synth || typeof window.SpeechSynthesisUtterance === 'undefined') {
      if (text) showToast('此瀏覽器不支援語音合成 (Web Speech API)');
      return false;
    }
    try {
      // Only cancel when something is actually queued: an unconditional cancel()
      // right before speak() makes iOS drop the new utterance.
      if (synth.speaking || synth.pending) synth.cancel();
      if (synth.paused) synth.resume();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = 0.94;
      utter.volume = 1;
      refreshVoices();
      const langLower = lang.toLowerCase();
      const langPrefix = langLower.split('-')[0];
      const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
      const preferred =
        cachedVoices.find((v) => norm(v) === langLower && /samantha|ava|daniel|alex|enhanced|premium/i.test(v.name)) ||
        cachedVoices.find((v) => norm(v) === langLower && v.localService) ||
        cachedVoices.find((v) => norm(v) === langLower) ||
        cachedVoices.find((v) => norm(v).startsWith(langPrefix));
      if (preferred) utter.voice = preferred;
      utter.onend = utter.onerror = () => {
        if (activeUtterance === utter) activeUtterance = null;
      };
      activeUtterance = utter;
      synth.speak(utter);
      return true;
    } catch (_e) {
      return false;
    }
  }

  function stopCurrentAudio() {
    if (currentAudioEl) {
      try {
        currentAudioEl.pause();
      } catch (_e) {}
      currentAudioEl = null;
    }
  }

  // Synchronous on purpose: never put an `await` before audio.play()/speak() here.
  function playAnkiSoundOrTts({ soundFile, ttsText, ttsLang = 'en-US' }) {
    stopCurrentAudio();

    let src = '';
    if (soundFile) {
      if (mediaBlobUrlMap.has(soundFile)) {
        src = mediaBlobUrlMap.get(soundFile);
      } else if (mediaServerAvailable) {
        // Relative path (not /media/) so it also works under a sub-path deployment
        src = `media/${encodeURIComponent(soundFile)}`;
      }
    }

    if (src) {
      const audio = new Audio(src);
      currentAudioEl = audio;
      let fellBack = false;
      const fallback = () => {
        if (fellBack || currentAudioEl !== audio) return;
        fellBack = true;
        if (ttsText) speakViaWebSpeech(ttsText, ttsLang);
      };
      audio.onerror = fallback;
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(fallback);
      return;
    }

    // No real MP3 reachable offline -> iOS built-in TTS, called synchronously in the tap
    if (ttsText) {
      speakViaWebSpeech(ttsText, ttsLang);
    } else if (soundFile) {
      showToast('此音檔未包含在離線版中，且找不到可朗讀的文字');
    }
  }

  // iOS: unlock speech + audio on the very first touch so later programmatic
  // playback (auto-play on card flip) is allowed.
  function unlockAudioOnFirstGesture() {
    const unlock = () => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          const srcNode = ctx.createBufferSource();
          srcNode.buffer = ctx.createBuffer(1, 1, 22050);
          srcNode.connect(ctx.destination);
          if (srcNode.start) srcNode.start(0);
          if (ctx.resume) ctx.resume();
        }
      } catch (_e) {}
      refreshVoices();
      document.removeEventListener('touchend', unlock, true);
      document.removeEventListener('click', unlock, true);
    };
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('click', unlock, true);
  }

  // --- Bundle Loading (full 29,603-card collection; E62 core as offline/standalone fallback) ---
  async function loadEmbeddedBundle(mode = 'e62') {
    if (mode === 'full') {
      if (!global.ANKI_FULL_BUNDLE_B64_GZ) {
        // Dynamically load data/full-bundle.js if not yet in memory
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'data/full-bundle.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('無法載入 data/full-bundle.js'));
          document.head.appendChild(s);
        });
      }
      const col = await decompressBase64Gzip(global.ANKI_FULL_BUNDLE_B64_GZ);
      applyModifiedCardsToCollection(col);
      state.collection = col;
      if (global.ANKI_UNIT01_AUDIO_MAP) {
        state.unit01AudioMap = global.ANKI_UNIT01_AUDIO_MAP;
      }
      return col;
    } else {
      if (!global.ANKI_E62_BUNDLE_B64_GZ) {
        throw new Error('內建 E62 牌組資料未載入');
      }
      const col = await decompressBase64Gzip(global.ANKI_E62_BUNDLE_B64_GZ);
      applyModifiedCardsToCollection(col);
      state.collection = col;
      if (global.ANKI_UNIT01_AUDIO_MAP) {
        state.unit01AudioMap = global.ANKI_UNIT01_AUDIO_MAP;
      }
      return col;
    }
  }

  // --- Tab Switching ---
  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab-panel').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tabTarget === tabName);
    });

    if (tabName === 'decks') {
      renderDecksTab();
    } else if (tabName === 'study') {
      renderReviewerTab();
    } else if (tabName === 'browser') {
      populateBrowserDeckFilter();
      renderBrowserResults();
    } else if (tabName === 'stats') {
      renderStatsTab();
    }
  }

  // --- 1. Decks Tab Rendering ---
  function renderDecksTab() {
    if (!state.collection) return;
    const { roots, byPath } = buildDeckTree(
      state.collection.decks,
      state.collection.cards,
      state.collection.crt
    );

    let totalNew = 0;
    let totalLrn = 0;
    let totalRev = 0;
    let totalCards = 0;
    for (const r of roots) {
      totalNew += r.newCount;
      totalLrn += r.lrnCount;
      totalRev += r.revDueCount;
      totalCards += r.totalCount;
    }

    document.getElementById('summary-total-cards').textContent = totalCards.toLocaleString();
    document.getElementById('summary-new-cards').textContent = totalNew.toLocaleString();
    document.getElementById('summary-lrn-cards').textContent = totalLrn.toLocaleString();
    document.getElementById('summary-rev-cards').textContent = totalRev.toLocaleString();

    const container = document.getElementById('deck-tree-rows');
    const rowsHtml = [];

    function walkNode(node) {
      const hasChildren = node.children && node.children.length > 0;
      const isExpanded = state.expandedDecks.has(node.path);
      const indentPx = node.depth * 20;

      rowsHtml.push(`
        <div class="deck-row ${node.depth > 0 ? 'subdeck' : ''}" data-deck-path="${escapeHtml(node.path)}">
          <div class="deck-row-left" style="padding-left: ${indentPx}px">
            ${
              hasChildren
                ? `<button class="deck-expand-btn" data-toggle-deck="${escapeHtml(
                    node.path
                  )}" title="展開/收合子牌組">${isExpanded ? '▼' : '▶'}</button>`
                : `<span class="deck-expand-btn" style="pointer-events:none;opacity:0.35">•</span>`
            }
            <span class="deck-title">${escapeHtml(node.shortName)}</span>
            ${mediaChipHtml(node.path)}
          </div>
          <div class="deck-counts">
            <span class="count-badge new ${node.newCount === 0 ? 'zero' : ''}" title="新卡片 (New)">${
        node.newCount
      }</span>
            <span class="count-badge lrn ${node.lrnCount === 0 ? 'zero' : ''}" title="學習中 (Learning)">${
        node.lrnCount
      }</span>
            <span class="count-badge rev ${node.revDueCount === 0 ? 'zero' : ''}" title="待複習 (Due)">${
        node.revDueCount
      }</span>
          </div>
        </div>
      `);

      if (hasChildren && isExpanded) {
        for (const child of node.children) {
          walkNode(child);
        }
      }
    }

    for (const root of roots) {
      walkNode(root);
    }

    container.innerHTML = rowsHtml.join('');

    // Attach event listeners
    container.querySelectorAll('[data-toggle-deck]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btn.getAttribute('data-toggle-deck');
        if (state.expandedDecks.has(path)) {
          state.expandedDecks.delete(path);
        } else {
          state.expandedDecks.add(path);
        }
        renderDecksTab();
      });
    });

    container.querySelectorAll('[data-media-deck]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openMediaModal(chip.getAttribute('data-media-deck'));
      });
    });

    container.querySelectorAll('.deck-row').forEach((row) => {
      row.addEventListener('click', () => {
        const path = row.getAttribute('data-deck-path');
        startStudyingDeck(path, byPath);
      });
    });
  }

  // --- 2. Start Studying a Deck & Reviewer Logic ---
  function startStudyingDeck(deckPath, byPathMap = null, includeAllReview = false) {
    if (!state.collection) return;
    const tree =
      byPathMap ||
      buildDeckTree(state.collection.decks, state.collection.cards, state.collection.crt).byPath;
    const node = tree.get(deckPath) || Array.from(tree.values())[0];
    if (!node) return;

    state.activeDeckPath = node.path;
    const { queue, counts } = buildStudyQueue(
      state.collection.cards,
      node.dids,
      state.collection.crt,
      {
        newLimit: state.newLimitPerSession,
        revLimit: state.revLimitPerSession,
        includeAllReview
      }
    );

    state.studyQueue = queue;
    state.studyCounts = counts;
    state.currentCard = queue.length > 0 ? queue[0] : null;
    state.isAnswerShown = false;
    state.typedAnswer = '';
    state.cardStartTimeMs = Date.now();

    switchTab('study');
  }

  function refreshStudyQueueCountsOnly() {
    if (!state.collection || !state.activeDeckPath) return;
    const { byPath } = buildDeckTree(
      state.collection.decks,
      state.collection.cards,
      state.collection.crt
    );
    const node = byPath.get(state.activeDeckPath);
    if (!node) return;
    const { counts } = buildStudyQueue(state.collection.cards, node.dids, state.collection.crt, {
      newLimit: state.newLimitPerSession,
      revLimit: state.revLimitPerSession
    });
    state.studyCounts = counts;
  }

  function renderReviewerTab() {
    if (!state.collection) return;
    if (!state.currentCard && state.studyQueue.length === 0) {
      // Initialize default deck if none active
      const { byPath } = buildDeckTree(
        state.collection.decks,
        state.collection.cards,
        state.collection.crt
      );
      const target = byPath.has(state.activeDeckPath)
        ? state.activeDeckPath
        : Array.from(byPath.keys())[0];
      if (target) {
        const node = byPath.get(target);
        const built = buildStudyQueue(state.collection.cards, node.dids, state.collection.crt, {
          newLimit: state.newLimitPerSession,
          revLimit: state.revLimitPerSession
        });
        state.studyQueue = built.queue;
        state.studyCounts = built.counts;
        state.currentCard = built.queue[0] || null;
        state.isAnswerShown = false;
        state.cardStartTimeMs = Date.now();
      }
    }

    document.getElementById('reviewer-deck-title').textContent = state.activeDeckPath || '牌組';
    const cQueue = state.currentCard ? Number(state.currentCard[5]) : -1;

    const elNew = document.getElementById('rev-count-new');
    const elLrn = document.getElementById('rev-count-lrn');
    const elRev = document.getElementById('rev-count-rev');
    elNew.textContent = state.studyCounts.newRemaining;
    elLrn.textContent = state.studyCounts.lrnRemaining;
    elRev.textContent = state.studyCounts.revRemaining;
    elNew.classList.toggle('active-queue', cQueue === 0);
    elLrn.classList.toggle('active-queue', cQueue === 1 || cQueue === 3);
    elRev.classList.toggle('active-queue', cQueue === 2);

    const undoBtn = document.getElementById('btn-undo-review');
    if (undoBtn) {
      undoBtn.disabled = state.undoStack.length === 0;
      undoBtn.style.opacity = state.undoStack.length === 0 ? '0.45' : '1';
    }

    const qaContainer = document.getElementById('qa');
    const styleEl = document.getElementById('anki-dynamic-notetype-style');
    const showAnsWrap = document.getElementById('bottom-show-answer-wrap');
    const easeGridWrap = document.getElementById('bottom-ease-grid-wrap');

    if (!state.currentCard) {
      styleEl.textContent = '';
      qaContainer.innerHTML = `
        <div style="text-align:center; padding: 48px 20px;">
          <div style="font-size: 48px; margin-bottom: 12px;">🎉</div>
          <h2 style="margin: 0 0 8px;">恭喜！本牌組今日排程已完成</h2>
          <p style="color: var(--text-secondary); margin: 0 0 20px;">
            您已完成 <strong>${escapeHtml(state.activeDeckPath)}</strong> 目前佇列中的卡片。
          </p>
          <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            <button class="icon-btn primary" id="btn-cram-deck">額外自主練習 (載入全部卡片)</button>
            <button class="icon-btn" id="btn-back-to-decks">返回牌組列表</button>
          </div>
        </div>
      `;
      showAnsWrap.style.display = 'none';
      easeGridWrap.style.display = 'none';

      const cramBtn = document.getElementById('btn-cram-deck');
      if (cramBtn) {
        cramBtn.addEventListener('click', () => {
          state.newLimitPerSession += 100;
          state.revLimitPerSession += 200;
          startStudyingDeck(state.activeDeckPath, null, true);
        });
      }
      const backBtn = document.getElementById('btn-back-to-decks');
      if (backBtn) {
        backBtn.addEventListener('click', () => switchTab('decks'));
      }
      return;
    }

    const card = state.currentCard;
    const nid = String(card[1]);
    const did = String(card[2]);
    const note = state.collection.notes[nid];
    if (!note) return;
    const mid = String(note[0]);
    const notetype = state.collection.notetypes[mid];
    const deckName = state.collection.decks[did] || state.activeDeckPath;

    const rendered = renderAnkiCard({
      card,
      note,
      notetype,
      deckName,
      typedAnswer: state.typedAnswer,
      unit01AudioMap: state.unit01AudioMap
    });

    styleEl.textContent = rendered.css || '';
    qaContainer.className = `card ${state.nightMode ? 'nightMode night_mode' : ''}`;
    qaContainer.innerHTML = state.isAnswerShown ? rendered.backHtml : rendered.frontHtml;

    // Bind typeans input if present on front
    const typeInput = qaContainer.querySelector('#typeans');
    if (typeInput && !state.isAnswerShown) {
      typeInput.addEventListener('input', (e) => {
        state.typedAnswer = e.target.value;
      });
      typeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flipCurrentCardToAnswer();
        }
      });
    }

    // Bind audio / TTS buttons inside #qa
    bindCardAudioEvents(qaContainer, rendered.primaryTerm);
    const mediaReady = hydrateMedia(qaContainer);

    // Update bottom controls
    if (!state.isAnswerShown) {
      showAnsWrap.style.display = 'block';
      easeGridWrap.style.display = 'none';
      if (state.autoPlayAudio && rendered.primaryTerm) {
        mediaReady.then(() => {
          if (state.currentCard === card && !state.isAnswerShown) {
            triggerFirstAudioInContainer(qaContainer, rendered.primaryTerm);
          }
        });
      }
    } else {
      showAnsWrap.style.display = 'none';
      easeGridWrap.style.display = 'grid';
      const intervals = previewAllIntervals(card, state.collection.crt);
      document.getElementById('ivl-1').textContent = intervals[1];
      document.getElementById('ivl-2').textContent = intervals[2];
      document.getElementById('ivl-3').textContent = intervals[3];
      document.getElementById('ivl-4').textContent = intervals[4];
    }
  }

  function bindCardAudioEvents(container, fallbackTerm) {
    container.querySelectorAll('.replay-button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const soundFile = btn.getAttribute('data-sound') || '';
        const ttsText =
          btn.getAttribute('data-tts-text') ||
          btn.getAttribute('data-tts-fallback') ||
          fallbackTerm ||
          '';
        const ttsLang = btn.getAttribute('data-tts-lang') || 'en-US';
        playAnkiSoundOrTts({ soundFile, ttsText, ttsLang });
      });
    });

    container.querySelectorAll('.speakable-sentence').forEach((div) => {
      div.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        const ttsText = div.getAttribute('data-tts-text') || '';
        const ttsLang = div.getAttribute('data-tts-lang') || 'en-US';
        if (ttsText) {
          speakViaWebSpeech(ttsText, ttsLang);
        }
      });
    });
  }

  function triggerFirstAudioInContainer(container, fallbackTerm) {
    const firstBtn = container.querySelector('.replay-button');
    if (firstBtn) {
      const soundFile = firstBtn.getAttribute('data-sound') || '';
      const ttsText =
        firstBtn.getAttribute('data-tts-text') ||
        firstBtn.getAttribute('data-tts-fallback') ||
        fallbackTerm ||
        '';
      const ttsLang = firstBtn.getAttribute('data-tts-lang') || 'en-US';
      playAnkiSoundOrTts({ soundFile, ttsText, ttsLang });
    } else if (fallbackTerm) {
      speakViaWebSpeech(fallbackTerm, 'en-US');
    }
  }

  function flipCurrentCardToAnswer() {
    if (!state.currentCard || state.isAnswerShown) return;
    state.isAnswerShown = true;
    renderReviewerTab();
    const scrollArea = document.querySelector('.reviewer-scroll-area');
    if (scrollArea) {
      const answerHr = document.getElementById('answer');
      if (answerHr) {
        answerHr.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  function answerCurrentCard(ease) {
    if (!state.currentCard) return;
    const card = state.currentCard;
    const prevSnapshot = card.slice();
    const elapsedMs = Math.min(60000, Math.max(100, Date.now() - state.cardStartTimeMs));
    const { nextCard, revlogEntry } = computeNextState(card, ease, state.collection.crt);
    revlogEntry[6] = elapsedMs;

    // Save undo state
    state.undoStack.push({
      cardRef: card,
      prevSnapshot
    });

    // Mutate card in-place inside collection.cards so references stay consistent
    for (let i = 0; i < nextCard.length; i++) {
      card[i] = nextCard[i];
    }

    saveCardProgress(card, revlogEntry);

    // Advance study queue
    state.studyQueue.shift();
    // If card is still in intraday learning (queue === 1) and user rated Again/Hard, re-append at end of queue
    if (card[5] === 1 && (ease === 1 || ease === 2)) {
      state.studyQueue.push(card);
    }

    refreshStudyQueueCountsOnly();
    state.currentCard = state.studyQueue[0] || null;
    state.isAnswerShown = false;
    state.typedAnswer = '';
    state.cardStartTimeMs = Date.now();

    renderReviewerTab();
    const scrollArea = document.querySelector('.reviewer-scroll-area');
    if (scrollArea) scrollArea.scrollTop = 0;
  }

  function undoLastReview() {
    if (state.undoStack.length === 0) return;
    const last = state.undoStack.pop();
    const { cardRef, prevSnapshot } = last;
    for (let i = 0; i < prevSnapshot.length; i++) {
      cardRef[i] = prevSnapshot[i];
    }
    if (state.customRevlog.length > 0) {
      state.customRevlog.pop();
    }
    saveCardProgress(cardRef, null);

    // Put card back at front of queue
    state.studyQueue = [cardRef, ...state.studyQueue.filter((c) => c[0] !== cardRef[0])];
    refreshStudyQueueCountsOnly();
    state.currentCard = cardRef;
    state.isAnswerShown = false;
    state.cardStartTimeMs = Date.now();
    renderReviewerTab();
    showToast('已復原上一張卡片複習紀錄');
  }

  // --- 3. Card Browser & Instant Search Tab ---
  function populateBrowserDeckFilter() {
    if (!state.collection) return;
    const select = document.getElementById('browser-deck-select');
    if (!select) return;
    const currentVal = state.browserDeckFilter;
    const deckEntries = Object.entries(state.collection.decks)
      .filter(([did, name]) => !(did === '1' && name === '預設'))
      .sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant-TW', { numeric: true }));

    select.innerHTML =
      `<option value="ALL">所有牌組 (${state.collection.cards.length.toLocaleString()} 張)</option>` +
      deckEntries
        .map(([did, name]) => `<option value="${escapeHtml(did)}">${escapeHtml(name)}</option>`)
        .join('');
    if ([...select.options].some((o) => o.value === currentVal)) {
      select.value = currentVal;
    }
  }

  function renderBrowserResults() {
    if (!state.collection) return;
    const query = (state.browserQuery || '').trim().toLowerCase();
    const deckFilter = state.browserDeckFilter;
    const stateFilter = state.browserStateFilter;

    const results = [];
    const maxDisplay = 120;
    let totalMatched = 0;

    for (const c of state.collection.cards) {
      if (deckFilter !== 'ALL' && String(c[2]) !== deckFilter) continue;
      const queue = Number(c[5]);
      if (stateFilter === 'NEW' && queue !== 0) continue;
      if (stateFilter === 'LRN' && queue !== 1 && queue !== 3) continue;
      if (stateFilter === 'REV' && queue !== 2) continue;
      if (stateFilter === 'SUSP' && queue >= 0) continue;

      const note = state.collection.notes[String(c[1])];
      if (!note) continue;
      const flds = note[1];

      if (query) {
        const joined = (flds.join(' ') + ' ' + (note[2] || '')).toLowerCase();
        if (!joined.includes(query)) continue;
      }

      totalMatched++;
      if (results.length < maxDisplay) {
        results.push({ card: c, note });
      }
    }

    document.getElementById('browser-count-summary').textContent = `符合條件：${totalMatched.toLocaleString()} 張卡片（顯示前 ${
      results.length
    } 筆，點擊卡片可預覽正反面與發音）`;

    const listEl = document.getElementById('browser-results-list');
    listEl.innerHTML = results
      .map(({ card, note }) => {
        const flds = note[1];
        const mid = String(note[0]);
        const deckName = state.collection.decks[String(card[2])] || '';
        const isE62 = mid === '1792091008095' || mid === '1792080708967' || mid === '1792078113447';
        const title = isE62 ? flds[1] || flds[0] : stripHtml(flds[0] || flds[1] || '');
        const pos = isE62 ? flds[2] || '' : '';
        const snippet = isE62
          ? stripHtml(flds[4] || flds[3] || '')
          : stripHtml(flds.slice(1).join(' · '));
        const q = Number(card[5]);
        const badgeClass = q === 0 ? 'new' : q === 1 || q === 3 ? 'lrn' : q === 2 ? 'rev' : 'zero';
        const badgeText =
          q === 0 ? '新卡' : q === 1 || q === 3 ? '學習中' : q === 2 ? `複習(${card[7]}d)` : '已暫停';

        return `
          <div class="browser-card-item" data-preview-cid="${escapeHtml(card[0])}">
            <div style="min-width:0; flex:1;">
              <div>
                <span class="browser-term">${escapeHtml(title)}</span>
                ${pos ? `<span class="browser-pos">${escapeHtml(pos)}</span>` : ''}
                <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">${escapeHtml(
                  deckName
                )}</span>
              </div>
              <div class="browser-snippet">${escapeHtml(snippet)}</div>
            </div>
            <span class="count-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('[data-preview-cid]').forEach((item) => {
      item.addEventListener('click', () => {
        const cid = item.getAttribute('data-preview-cid');
        openCardPreviewModal(cid);
      });
    });
  }

  function openCardPreviewModal(cid) {
    const card = state.collection.cards.find((c) => String(c[0]) === String(cid));
    if (!card) return;
    const note = state.collection.notes[String(card[1])];
    if (!note) return;
    const notetype = state.collection.notetypes[String(note[0])];
    const deckName = state.collection.decks[String(card[2])] || '預設';

    const rendered = renderAnkiCard({
      card,
      note,
      notetype,
      deckName,
      unit01AudioMap: state.unit01AudioMap
    });

    const modal = document.getElementById('card-preview-modal');
    const modalTitle = document.getElementById('modal-card-title');
    const modalBody = document.getElementById('modal-card-body');
    const styleEl = document.getElementById('anki-dynamic-notetype-style');
    styleEl.textContent = rendered.css || '';

    modalTitle.textContent = `${rendered.primaryTerm || '卡片預覽'} (${deckName})`;
    modalBody.className = `modal-body card ${state.nightMode ? 'nightMode night_mode' : ''}`;
    modalBody.innerHTML = rendered.backHtml;
    bindCardAudioEvents(modalBody, rendered.primaryTerm);
    hydrateMedia(modalBody);

    const studyBtn = document.getElementById('btn-modal-study-deck');
    studyBtn.onclick = () => {
      modal.classList.remove('open');
      startStudyingDeck(deckName, null, false);
    };

    modal.classList.add('open');
  }

  // --- 4. Stats, Import & Progress Backup Tab ---
  function renderStatsTab() {
    if (!state.collection) return;
    const cards = state.collection.cards;
    let cNew = 0,
      cLrn = 0,
      cYoung = 0,
      cMature = 0,
      cSusp = 0;

    for (const c of cards) {
      const q = Number(c[5]);
      const ivl = Number(c[7] || 0);
      if (q < 0) cSusp++;
      else if (q === 0) cNew++;
      else if (q === 1 || q === 3) cLrn++;
      else if (q === 2) {
        if (ivl >= 21) cMature++;
        else cYoung++;
      }
    }

    const allRevs = [...(state.collection.revlog || []), ...state.customRevlog];
    const todayStartMs = new Date().setHours(0, 0, 0, 0);
    const todayRevs = allRevs.filter((r) => Number(r[0]) >= todayStartMs);

    document.getElementById('stats-summary-grid').innerHTML = `
      <div class="metric-pill"><span class="label">今日已複習</span><span class="val">${todayRevs.length} 次</span></div>
      <div class="metric-pill"><span class="label">累計複習紀錄</span><span class="val">${allRevs.length} 筆</span></div>
      <div class="metric-pill new"><span class="label">未學新卡 (New)</span><span class="val">${cNew.toLocaleString()}</span></div>
      <div class="metric-pill lrn"><span class="label">學習中 (Learn)</span><span class="val">${cLrn.toLocaleString()}</span></div>
      <div class="metric-pill rev"><span class="label">年輕複習卡 (<21天)</span><span class="val">${cYoung.toLocaleString()}</span></div>
      <div class="metric-pill rev"><span class="label">成熟記憶卡 (≥21天)</span><span class="val">${cMature.toLocaleString()}</span></div>
      <div class="metric-pill"><span class="label">已暫停 (Suspended)</span><span class="val">${cSusp.toLocaleString()}</span></div>
    `;
  }

  function exportProgressJson() {
    const cardsObj = {};
    for (const [k, v] of state.modifiedCardsMap.entries()) {
      cardsObj[k] = v;
    }
    const payload = {
      kind: 'anki-ios-pwa-progress',
      exportedAt: new Date().toISOString(),
      modifiedCardsCount: state.modifiedCardsMap.size,
      revlogCount: state.customRevlog.length,
      cards: cardsObj,
      revlog: state.customRevlog
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `anki-ios-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已匯出複習進度備份 JSON');
  }

  async function handleFileImport(file) {
    if (!file) return;
    try {
      const pack = await readDeckPackMeta(file);
      if (pack) {
        await importMediaPackFiles([file]);
        return;
      }
      showToast(`正在解析 ${file.name}...`);
      const imported = await importAnkiFile(file, file.name);

      if (imported.kind === 'anki-ios-pwa-progress') {
        let count = 0;
        for (const [cid, tuple] of Object.entries(imported.cards || {})) {
          state.modifiedCardsMap.set(String(cid), tuple);
          saveCardProgress(tuple, null);
          count++;
        }
        applyModifiedCardsToCollection(state.collection);
        renderDecksTab();
        renderStatsTab();
        showToast(`成功還原 ${count} 張卡片的複習進度！`);
        return;
      }

      // Merge or switch to imported collection
      for (const [did, dName] of Object.entries(imported.decks || {})) {
        state.collection.decks[did] = dName;
      }
      for (const [mid, nt] of Object.entries(imported.notetypes || {})) {
        state.collection.notetypes[mid] = nt;
      }
      for (const [nid, noteTuple] of Object.entries(imported.notes || {})) {
        state.collection.notes[nid] = noteTuple;
      }
      const existingCids = new Set(state.collection.cards.map((c) => String(c[0])));
      let addedCards = 0;
      for (const c of imported.cards || []) {
        if (!existingCids.has(String(c[0]))) {
          state.collection.cards.push(c);
          addedCards++;
        }
      }
      // Save any extracted media blobs into IndexedDB & memory
      if (imported.mediaBlobs) {
        state.collection.mediaBlobs = state.collection.mediaBlobs || {};
        for (const [mName, blob] of Object.entries(imported.mediaBlobs)) {
          state.collection.mediaBlobs[mName] = blob;
          mediaChecked.delete(mName);
          registerMediaBlob(mName, blob);
          if (state.idb) {
            try {
              const tx = state.idb.transaction(['media_blobs'], 'readwrite');
              tx.objectStore('media_blobs').put({ name: mName, blob });
            } catch (_e) {}
          }
        }
      }

      showToast(
        `成功匯入 ${file.name}（新增 ${addedCards.toLocaleString()} 張卡片，共 ${Object.keys(
          imported.decks || {}
        ).length} 個牌組）！`
      );
      switchTab('decks');
    } catch (err) {
      showToast(`匯入失敗：${err.message || err}`);
    }
  }

  async function preCacheUnit01Audio() {
    if (!mediaServerAvailable) {
      showToast('目前主機沒有提供 MP3（GitHub Pages / 單檔版），發音將使用 iOS 內建離線語音 (TTS)');
      return;
    }
    const entries = Object.values(state.unit01AudioMap || {});
    const files = new Set();
    for (const item of entries) {
      if (item.wordAudio) files.add(item.wordAudio);
      for (const s of item.sentenceAudios || []) files.add(s);
    }
    const list = Array.from(files);
    if (list.length === 0) {
      showToast('找不到可預載的音訊清單');
      return;
    }
    showToast(`正在背景快取 ${list.length} 個真人發音 MP3 至 iOS IndexedDB...`);
    let cached = 0;
    for (const fName of list) {
      try {
        const resp = await fetch(`media/${encodeURIComponent(fName)}`);
        if (resp.ok) {
          const blob = await resp.blob();
          registerMediaBlob(fName, blob);
          if (state.idb) {
            const tx = state.idb.transaction(['media_blobs'], 'readwrite');
            tx.objectStore('media_blobs').put({ name: fName, blob });
          }
          cached++;
        }
      } catch (_e) {}
    }
    showToast(`已完成 ${cached} / ${list.length} 個音訊檔離線快取！`);
  }

  // --- Initialization & Event Binding ---
  async function initApp() {
    // Detect dark mode preference (guarded for file:// / iOS Quick Look contexts)
    let savedTheme = null;
    try {
      savedTheme = localStorage.getItem('anki_ios_theme');
    } catch (_e) {}
    if (
      savedTheme === 'dark' ||
      (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
      state.nightMode = true;
      document.body.classList.add('nightMode', 'night_mode');
    }

    state.idb = await openDatabase();
    await loadPersistedProgress();
    unlockAudioOnFirstGesture();
    refreshVoices();
    if (window.speechSynthesis && 'onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = refreshVoices;
    }
    await loadInstalledPacks();
    probeMediaServer();
    // The e62 bundle (loaded by index.html) is always present; try the full library on http(s)
    let loadedFull = false;
    if (location.protocol.startsWith('http')) {
      try {
        await loadEmbeddedBundle('full');
        loadedFull = true;
      } catch (_err) {}
    }
    if (!loadedFull) {
      await loadEmbeddedBundle('e62');
      showToast('目前僅載入 E62 全書核心牌組（完整館藏需透過網址開啟 PWA）');
    }

    // Bind Top Header buttons
    document.getElementById('btn-toggle-theme').addEventListener('click', () => {
      state.nightMode = !state.nightMode;
      document.body.classList.toggle('nightMode', state.nightMode);
      document.body.classList.toggle('night_mode', state.nightMode);
      try {
        localStorage.setItem('anki_ios_theme', state.nightMode ? 'dark' : 'light');
      } catch (_e) {}
      if (state.activeTab === 'study') renderReviewerTab();
    });

    document.getElementById('btn-toggle-autoplay').addEventListener('click', (e) => {
      state.autoPlayAudio = !state.autoPlayAudio;
      e.currentTarget.textContent = state.autoPlayAudio ? '🔊 自動發音: 開' : '🔈 自動發音: 關';
      showToast(state.autoPlayAudio ? '已開啟翻卡自動發音' : '已關閉自動發音');
    });

    // Bind Bottom Tab Bar
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tabTarget);
      });
    });

    // Bind Reviewer controls
    document.getElementById('btn-show-answer').addEventListener('click', flipCurrentCardToAnswer);
    document.querySelectorAll('.ease-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ease = Number(btn.getAttribute('data-ease'));
        answerCurrentCard(ease);
      });
    });
    document.getElementById('btn-undo-review').addEventListener('click', undoLastReview);
    document.getElementById('btn-replay-audio').addEventListener('click', () => {
      const qaContainer = document.getElementById('qa');
      if (qaContainer) {
        const term = qaContainer.querySelector('.term')
          ? qaContainer.querySelector('.term').textContent
          : '';
        triggerFirstAudioInContainer(qaContainer, term);
      }
    });

    // Keyboard shortcuts for iPad / Mac keyboard
    window.addEventListener('keydown', (e) => {
      if (state.activeTab !== 'study') return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        if (!state.isAnswerShown) flipCurrentCardToAnswer();
        else answerCurrentCard(3);
      } else if (state.isAnswerShown && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        answerCurrentCard(Number(e.key));
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        document.getElementById('btn-replay-audio').click();
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        undoLastReview();
      }
    });

    // Bind Browser Search & Filters
    document.getElementById('browser-search-input').addEventListener('input', (e) => {
      state.browserQuery = e.target.value;
      renderBrowserResults();
    });
    document.getElementById('browser-deck-select').addEventListener('change', (e) => {
      state.browserDeckFilter = e.target.value;
      renderBrowserResults();
    });
    document.getElementById('browser-state-select').addEventListener('change', (e) => {
      state.browserStateFilter = e.target.value;
      renderBrowserResults();
    });

    // Modal close
    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('card-preview-modal').classList.remove('open');
    });
    document.getElementById('card-preview-modal').addEventListener('click', (e) => {
      if (e.target.id === 'card-preview-modal') {
        e.currentTarget.classList.remove('open');
      }
    });

    // Bind File Import & Progress Export
    document.getElementById('file-import-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFileImport(f);
      e.target.value = '';
    });
    document.getElementById('btn-export-progress').addEventListener('click', exportProgressJson);
    document.getElementById('btn-precache-audio').addEventListener('click', preCacheUnit01Audio);

    // Offline media packs: one AirDropped .zip per deck
    document.getElementById('media-pack-input').addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) importMediaPackFiles(files);
    });
    document.getElementById('btn-close-media-modal').addEventListener('click', () => {
      document.getElementById('media-pack-modal').classList.remove('open');
    });
    document.getElementById('media-pack-modal').addEventListener('click', (e) => {
      if (e.target.id === 'media-pack-modal') e.currentTarget.classList.remove('open');
    });
    renderMediaPackList(document.getElementById('media-pack-list-all'), null);

    // Register Service Worker if over http/https
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    renderDecksTab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})(typeof window !== 'undefined' ? window : globalThis);
