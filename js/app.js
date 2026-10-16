/**
 * Anki iOS Offline PWA Main Application Controller
 * Supports 100% offline iOS Safari study, IndexedDB persistence, E62 50-Unit & 29,603-card full library,
 * client-side .apkg/.colpkg/.anki2/JSON import, and Web Speech API + native MP3 audio playback.
 */
(function (global) {
  'use strict';

  const { decompressBase64Gzip, importAnkiFile } = global.AnkiSqliteApkg;
  const { stripHtml, escapeHtml, renderAnkiCard } = global.AnkiRenderer;
  const {
    getTodayDays,
    computeNextState,
    previewAllIntervals,
    buildDeckTree,
    buildStudyQueue
  } = global.AnkiScheduler;

  const DB_NAME = 'anki_ios_pwa_db_v1';
  const DB_VERSION = 1;

  const state = {
    collection: null,
    packMode: 'e62', // 'e62' (3,011 cards) or 'full' (29,603 cards)
    unit01AudioMap: {},
    expandedDecks: new Set(['E62 English2000 全書', 'E62 Validation']),
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
      const cid = String(col.cards[i][0]);
      if (state.modifiedCardsMap.has(cid)) {
        col.cards[i] = state.modifiedCardsMap.get(cid).slice();
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
  let currentAudioEl = null;

  async function getMediaBlobFromIdb(fileName) {
    if (state.collection && state.collection.mediaBlobs && state.collection.mediaBlobs[fileName]) {
      return state.collection.mediaBlobs[fileName];
    }
    if (!state.idb) return null;
    return new Promise((resolve) => {
      try {
        const tx = state.idb.transaction(['media_blobs'], 'readonly');
        const req = tx.objectStore('media_blobs').get(fileName);
        req.onsuccess = (e) => resolve(e.target.result ? e.target.result.blob : null);
        req.onerror = () => resolve(null);
      } catch (_e) {
        resolve(null);
      }
    });
  }

  function speakViaWebSpeech(text, lang = 'en-US') {
    if (!text || typeof window.speechSynthesis === 'undefined') return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang;
      utter.rate = 0.94;
      const voices = window.speechSynthesis.getVoices() || [];
      const langPrefix = lang.split('-')[0].toLowerCase();
      const preferred =
        voices.find((v) => v.lang.toLowerCase().includes(lang.toLowerCase()) && /samantha|ava|daniel|alex|enhanced|natural/i.test(v.name)) ||
        voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));
      if (preferred) utter.voice = preferred;
      window.speechSynthesis.speak(utter);
    } catch (_e) {}
  }

  async function playAnkiSoundOrTts({ soundFile, ttsText, ttsLang = 'en-US' }) {
    if (currentAudioEl) {
      try {
        currentAudioEl.pause();
      } catch (_e) {}
      currentAudioEl = null;
    }

    if (soundFile) {
      // 1. Check IndexedDB / imported blobs first
      const blob = await getMediaBlobFromIdb(soundFile);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioEl = audio;
        audio.onended = () => URL.revokeObjectURL(url);
        try {
          await audio.play();
          return;
        } catch (_e) {}
      }

      // 2. Try /media/<soundFile> if running on HTTP/HTTPS server
      if (location.protocol.startsWith('http')) {
        try {
          const url = `/media/${encodeURIComponent(soundFile)}`;
          const audio = new Audio(url);
          currentAudioEl = audio;
          await audio.play();
          return;
        } catch (_e) {
          // Fall through to Web Speech API fallback
        }
      }
    }

    // 3. Fallback to offline iOS Web Speech API
    if (ttsText) {
      speakViaWebSpeech(ttsText, ttsLang);
    }
  }

  // --- Bundle Loading (E62 Core vs Full 29,603-card Collection) ---
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
      state.packMode = 'full';
      return col;
    } else {
      if (!global.ANKI_E62_BUNDLE_B64_GZ) {
        throw new Error('內建 E62 牌組資料未載入');
      }
      const col = await decompressBase64Gzip(global.ANKI_E62_BUNDLE_B64_GZ);
      applyModifiedCardsToCollection(col);
      state.collection = col;
      state.packMode = 'e62';
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

    const packBtnE62 = document.getElementById('btn-pack-e62');
    const packBtnFull = document.getElementById('btn-pack-full');
    if (packBtnE62 && packBtnFull) {
      packBtnE62.classList.toggle('primary', state.packMode === 'e62');
      packBtnFull.classList.toggle('primary', state.packMode === 'full');
    }

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

    // Update bottom controls
    if (!state.isAnswerShown) {
      showAnsWrap.style.display = 'block';
      easeGridWrap.style.display = 'none';
      if (state.autoPlayAudio && rendered.primaryTerm) {
        triggerFirstAudioInContainer(qaContainer, rendered.primaryTerm);
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
    if (!location.protocol.startsWith('http')) {
      showToast('目前為單檔離線模式，已自動啟用 iOS 內建離線語音合成 (TTS)');
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
        const resp = await fetch(`/media/${encodeURIComponent(fName)}`);
        if (resp.ok) {
          const blob = await resp.blob();
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
    await loadEmbeddedBundle('e62');

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

    // Bind Pack Switcher (E62 Core vs Full 29,603-card Library)
    document.getElementById('btn-pack-e62').addEventListener('click', async () => {
      await loadEmbeddedBundle('e62');
      renderDecksTab();
      showToast('已切換至 E62 English2000 全書核心牌組 (3,011 張)');
    });

    document.getElementById('btn-pack-full').addEventListener('click', async () => {
      try {
        showToast('正在解壓載入完整館藏 (29,603 張卡片)...');
        await loadEmbeddedBundle('full');
        renderDecksTab();
        showToast('已載入完整 29,603 張 Anki 牌組館藏！');
      } catch (err) {
        showToast(`完整館藏載入提示：${err.message}`);
      }
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
