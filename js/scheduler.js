/**
 * Anki SM-2 / v3 Spaced Repetition Scheduler & Hierarchical Deck Engine
 * Preserves Anki SQLite card state tuples:
 *   [0:cid, 1:nid, 2:did, 3:ord, 4:type, 5:queue, 6:due, 7:ivl, 8:factor, 9:reps, 10:lapses]
 * and revlog tuples:
 *   [0:id(ms), 1:cid, 2:ease, 3:ivl, 4:lastIvl, 5:factor, 6:time(ms), 7:type]
 */
(function (global) {
  'use strict';

  function getTodayDays(crt) {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseCrt = Number(crt) || nowSec - 86400;
    return Math.max(0, Math.floor((nowSec - baseCrt) / 86400));
  }

  function formatIntervalLabel(secondsOrDays, isDays) {
    if (!isDays) {
      const mins = Math.max(1, Math.round(secondsOrDays / 60));
      if (mins <= 1) return '<1分鐘';
      if (mins < 60) return `${mins}分鐘`;
      const hrs = Math.round(mins / 60);
      return `${hrs}小時`;
    }
    const days = Math.max(1, Math.round(secondsOrDays));
    if (days < 30) return `${days}天`;
    if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}個月`;
    return `${(days / 365).toFixed(1).replace(/\.0$/, '')}年`;
  }

  function computeNextState(cardTuple, ease, crt, nowMs = Date.now()) {
    const next = cardTuple.slice();
    const nowSec = Math.floor(nowMs / 1000);
    const todayDays = getTodayDays(crt);

    const cType = Number(next[4] || 0);
    const cQueue = Number(next[5] || 0);
    const cDue = Number(next[6] || 0);
    const cIvl = Number(next[7] || 0);
    const cFactor = Number(next[8] || 2500) || 2500;
    const cReps = Number(next[9] || 0);
    const cLapses = Number(next[10] || 0);

    next[9] = cReps + 1;

    let label = '';
    let revlogType = 0;

    // 1. New Card (queue === 0 or type === 0)
    if (cQueue === 0 || cType === 0) {
      revlogType = 0;
      if (ease === 1) {
        next[4] = 1; // Learning
        next[5] = 1;
        next[6] = nowSec + 60;
        next[7] = 0;
        next[8] = 2500;
        label = formatIntervalLabel(60, false);
      } else if (ease === 2) {
        next[4] = 1;
        next[5] = 1;
        next[6] = nowSec + 360;
        next[7] = 0;
        next[8] = 2500;
        label = formatIntervalLabel(360, false);
      } else if (ease === 3) {
        next[4] = 1;
        next[5] = 1;
        next[6] = nowSec + 600;
        next[7] = 1; // Marks step 2 ready to graduate on next Good
        next[8] = 2500;
        label = formatIntervalLabel(600, false);
      } else {
        // Easy -> Graduate directly to Review (4 days)
        next[4] = 2;
        next[5] = 2;
        next[7] = 4;
        next[6] = todayDays + 4;
        next[8] = 2500;
        label = formatIntervalLabel(4, true);
      }
    }
    // 2. Learning / Relearning Card (queue === 1 or 3, or type === 1 or 3)
    else if (cQueue === 1 || cQueue === 3 || cType === 1 || cType === 3) {
      revlogType = cType === 3 ? 2 : 0;
      if (ease === 1) {
        next[4] = cType === 3 ? 3 : 1;
        next[5] = 1;
        next[6] = nowSec + 60;
        next[7] = cType === 3 ? Math.max(1, Math.round(cIvl * 0.5)) : 0;
        next[8] = cFactor;
        label = formatIntervalLabel(60, false);
      } else if (ease === 2) {
        next[4] = cType === 3 ? 3 : 1;
        next[5] = 1;
        next[6] = nowSec + 360;
        next[7] = cIvl;
        next[8] = cFactor;
        label = formatIntervalLabel(360, false);
      } else if (ease === 3) {
        // Graduate to Review
        const gradIvl = Math.max(1, cIvl || 1);
        next[4] = 2;
        next[5] = 2;
        next[7] = gradIvl;
        next[6] = todayDays + gradIvl;
        next[8] = cFactor;
        label = formatIntervalLabel(gradIvl, true);
      } else {
        // Easy graduate
        const easyIvl = Math.max(4, (cIvl || 1) + 3);
        next[4] = 2;
        next[5] = 2;
        next[7] = easyIvl;
        next[6] = todayDays + easyIvl;
        next[8] = cFactor;
        label = formatIntervalLabel(easyIvl, true);
      }
    }
    // 3. Review Card (queue === 2)
    else {
      revlogType = 1;
      const curIvl = Math.max(1, cIvl || 1);
      const daysLate = Math.max(0, todayDays - cDue);
      if (ease === 1) {
        // Lapse into Relearning
        const newFactor = Math.max(1300, cFactor - 200);
        const newIvl = Math.max(1, Math.round(curIvl * 0.5));
        next[4] = 3; // Relearning
        next[5] = 1; // Learning queue
        next[6] = nowSec + 600;
        next[7] = newIvl;
        next[8] = newFactor;
        next[10] = cLapses + 1;
        label = formatIntervalLabel(600, false);
      } else if (ease === 2) {
        const newFactor = Math.max(1300, cFactor - 150);
        const newIvl = Math.max(curIvl + 1, Math.round(curIvl * 1.2));
        next[4] = 2;
        next[5] = 2;
        next[7] = newIvl;
        next[6] = todayDays + newIvl;
        next[8] = newFactor;
        label = formatIntervalLabel(newIvl, true);
      } else if (ease === 3) {
        const newIvl = Math.max(curIvl + 1, Math.round((curIvl + daysLate / 2) * (cFactor / 1000)));
        next[4] = 2;
        next[5] = 2;
        next[7] = newIvl;
        next[6] = todayDays + newIvl;
        next[8] = cFactor;
        label = formatIntervalLabel(newIvl, true);
      } else {
        const newFactor = cFactor + 150;
        const newIvl = Math.max(curIvl + 2, Math.round((curIvl + daysLate) * (cFactor / 1000) * 1.3));
        next[4] = 2;
        next[5] = 2;
        next[7] = newIvl;
        next[6] = todayDays + newIvl;
        next[8] = newFactor;
        label = formatIntervalLabel(newIvl, true);
      }
    }

    return {
      nextCard: next,
      label,
      revlogEntry: [
        nowMs,
        String(cardTuple[0]),
        ease,
        next[7],
        cIvl,
        next[8],
        0,
        revlogType
      ]
    };
  }

  function previewAllIntervals(cardTuple, crt) {
    return {
      1: computeNextState(cardTuple, 1, crt).label,
      2: computeNextState(cardTuple, 2, crt).label,
      3: computeNextState(cardTuple, 3, crt).label,
      4: computeNextState(cardTuple, 4, crt).label
    };
  }

  function isCardDueReview(cardTuple, todayDays) {
    const queue = Number(cardTuple[5]);
    const due = Number(cardTuple[6]);
    if (queue === 2) {
      return due <= todayDays;
    }
    return false;
  }

  function buildDeckTree(decksMap, cardsList, crt) {
    const todayDays = getTodayDays(crt);
    const byPath = new Map();

    function ensureNode(fullPath, did = null) {
      if (byPath.has(fullPath)) {
        const existing = byPath.get(fullPath);
        if (did && !existing.did) existing.did = String(did);
        return existing;
      }
      const parts = fullPath.split('::');
      const shortName = parts[parts.length - 1];
      const depth = parts.length - 1;
      const node = {
        path: fullPath,
        shortName,
        depth,
        did: did ? String(did) : null,
        dids: new Set(did ? [String(did)] : []),
        newCount: 0,
        lrnCount: 0,
        revDueCount: 0,
        revTotalCount: 0,
        suspCount: 0,
        totalCount: 0,
        children: []
      };
      byPath.set(fullPath, node);
      if (parts.length > 1) {
        const parentPath = parts.slice(0, -1).join('::');
        const parentNode = ensureNode(parentPath, null);
        if (!parentNode.children.includes(node)) {
          parentNode.children.push(node);
        }
      }
      return node;
    }

    for (const [did, name] of Object.entries(decksMap)) {
      if (name === '預設' && did === '1') continue;
      ensureNode(name, did);
    }

    for (const c of cardsList) {
      const did = String(c[2]);
      const deckName = decksMap[did] || '預設';
      const node = ensureNode(deckName, did);
      const queue = Number(c[5]);
      node.totalCount++;
      if (queue === 0) {
        node.newCount++;
      } else if (queue === 1 || queue === 3) {
        node.lrnCount++;
      } else if (queue === 2) {
        node.revTotalCount++;
        if (isCardDueReview(c, todayDays)) {
          node.revDueCount++;
        }
      } else if (queue < 0) {
        node.suspCount++;
      }
    }

    // Roll up counts from children to parents
    const allNodes = Array.from(byPath.values()).sort((a, b) => b.depth - a.depth);
    for (const node of allNodes) {
      node.children.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hant-TW', { numeric: true }));
      if (node.depth > 0) {
        const parentPath = node.path.split('::').slice(0, -1).join('::');
        const parent = byPath.get(parentPath);
        if (parent) {
          parent.newCount += node.newCount;
          parent.lrnCount += node.lrnCount;
          parent.revDueCount += node.revDueCount;
          parent.revTotalCount += node.revTotalCount;
          parent.suspCount += node.suspCount;
          parent.totalCount += node.totalCount;
          for (const d of node.dids) parent.dids.add(d);
        }
      }
    }

    const roots = Array.from(byPath.values())
      .filter((n) => n.depth === 0 && n.totalCount > 0)
      .sort((a, b) => {
        // Put E62 decks first for immediate access
        const aE62 = a.path.startsWith('E62') ? 0 : 1;
        const bE62 = b.path.startsWith('E62') ? 0 : 1;
        if (aE62 !== bE62) return aE62 - bE62;
        return a.path.localeCompare(b.path, 'zh-Hant-TW', { numeric: true });
      });

    return { roots, byPath };
  }

  function buildStudyQueue(cardsList, targetDidsSet, crt, options = {}) {
    const { newLimit = 50, revLimit = 200, includeAllReview = false } = options;
    const todayDays = getTodayDays(crt);

    const lrnCards = [];
    const revCards = [];
    const newCards = [];

    for (const c of cardsList) {
      if (targetDidsSet && targetDidsSet.size > 0 && !targetDidsSet.has(String(c[2]))) {
        continue;
      }
      const queue = Number(c[5]);
      if (queue < 0) continue; // Skip suspended/buried

      if (queue === 1 || queue === 3) {
        lrnCards.push(c);
      } else if (queue === 2) {
        if (includeAllReview || isCardDueReview(c, todayDays)) {
          revCards.push(c);
        }
      } else if (queue === 0) {
        newCards.push(c);
      }
    }

    lrnCards.sort((a, b) => Number(a[6]) - Number(b[6]));
    revCards.sort((a, b) => Number(a[6]) - Number(b[6]));
    newCards.sort((a, b) => Number(a[6]) - Number(b[6]) || Number(a[0]) - Number(b[0]));

    const selectedRev = revCards.slice(0, revLimit);
    const selectedNew = newCards.slice(0, newLimit);

    // Interleave: Learning due first, then Review & New interleaved (Anki v3 style)
    const queue = [...lrnCards];
    const maxLen = Math.max(selectedRev.length, selectedNew.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < selectedRev.length) queue.push(selectedRev[i]);
      if (i < selectedNew.length) queue.push(selectedNew[i]);
    }

    return {
      queue,
      counts: {
        newRemaining: selectedNew.length,
        lrnRemaining: lrnCards.length,
        revRemaining: selectedRev.length,
        totalAvailableNew: newCards.length,
        totalAvailableLrn: lrnCards.length,
        totalAvailableRev: revCards.length
      }
    };
  }

  global.AnkiScheduler = {
    getTodayDays,
    formatIntervalLabel,
    computeNextState,
    previewAllIntervals,
    isCardDueReview,
    buildDeckTree,
    buildStudyQueue
  };
})(typeof window !== 'undefined' ? window : globalThis);
