/**
 * Anki Reviewer Card Template & Audio/TTS Renderer
 * Reverse-engineered from Anki.app (_aqt/data/web/js/reviewer.js, css/reviewer.css, css/webview.css)
 * and Anki v18 template specifications.
 */
(function (global) {
  'use strict';

  function stripHtml(html) {
    return String(html || '')
      .replace(/\[sound:[^\]]+\]/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const PLAY_SVG =
    '<svg class="playImage" viewBox="0 0 64 64" version="1.1"><circle cx="32" cy="32" r="29"></circle><path d="M56.5,32l-36,-21l0,42l36,-21Z"></path></svg>';

  function renderClozeText(rawHtml, targetOrd, isBack) {
    const targetNum = (Number(targetOrd) || 0) + 1;
    return String(rawHtml || '').replace(
      /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/gi,
      (_match, cNumStr, answer, hint) => {
        const cNum = Number(cNumStr);
        if (cNum === targetNum) {
          if (isBack) {
            return `<span class="cloze">${answer}</span>`;
          }
          const label = hint ? `[${hint}]` : '[...]';
          return `<span class="cloze">${label}</span>`;
        }
        return answer;
      }
    );
  }

  function renderTypeComparison(typed, expected) {
    const cleanTyped = String(typed || '').trim();
    const cleanExpected = stripHtml(expected);
    if (!cleanTyped) {
      return `<div id="typeans" class="typeans-compare"><span class="typeMissed">${escapeHtml(
        cleanExpected
      )}</span></div>`;
    }
    const isExact = cleanTyped.toLowerCase() === cleanExpected.toLowerCase();
    if (isExact) {
      return `<div id="typeans" class="typeans-compare"><span class="typeGood">${escapeHtml(
        cleanExpected
      )}</span> <span class="type-badge good">✓ 正確</span></div>`;
    }
    return `<div id="typeans" class="typeans-compare">
      <div><span class="typeBad">${escapeHtml(cleanTyped)}</span></div>
      <div class="type-arrow">↓ 正確答案</div>
      <div><span class="typeMissed">${escapeHtml(cleanExpected)}</span></div>
    </div>`;
  }

  function evaluateTemplate(templateStr, fieldMap, options) {
    const { isBack, frontRenderedHtml, cardOrd, typedAnswer, fallbackTerm } = options;
    let out = String(templateStr || '');

    // Remove stray unmatched </script> tags found in some community templates (e.g., Basic-基本 多詞性+)
    if (!out.includes('<script') && out.includes('</script>')) {
      out = out.replace(/<\/script>/gi, '');
    }

    // 1. Resolve conditional blocks {{#Field}}...{{/Field}} and {{^Field}}...{{/Field}}
    // Support nested/repeated blocks with up to 4 passes
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      out = out.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (_m, op, fName, inner) => {
        changed = true;
        const val = fieldMap[fName] !== undefined ? fieldMap[fName] : fieldMap[fName.toLowerCase()] || '';
        const nonEmpty = stripHtml(val).length > 0 || /\[sound:|<img/i.test(val);
        if (op === '#' && nonEmpty) return inner;
        if (op === '^' && !nonEmpty) return inner;
        return '';
      });
      if (!changed) break;
    }

    // 2. Resolve {{FrontSide}} on back template
    if (isBack && frontRenderedHtml !== undefined) {
      out = out.replace(/\{\{\s*FrontSide\s*\}\}/gi, () => frontRenderedHtml);
    }

    // 3. Resolve field tags and filters {{filter:Field}} or {{Field}}
    out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawExpr) => {
      const expr = rawExpr.trim();

      // Filter: {{tts en_US ...:FieldName}}
      if (/^tts\s+/i.test(expr)) {
        const colonIdx = expr.lastIndexOf(':');
        if (colonIdx > 0) {
          const headerPart = expr.slice(0, colonIdx);
          const fName = expr.slice(colonIdx + 1).trim();
          const langMatch = headerPart.match(/tts\s+([a-zA-Z]{2}[_-][a-zA-Z]{2})/i);
          const lang = langMatch ? langMatch[1].replace('_', '-') : 'en-US';
          const rawVal = fieldMap[fName] !== undefined ? fieldMap[fName] : fieldMap[fName.toLowerCase()] || '';
          const textToSpeak = stripHtml(rawVal);
          if (!textToSpeak) return '';
          return `<a class="replay-button soundLink tts-btn" href="#" role="button" title="朗讀 (${escapeHtml(
            lang
          )})" data-tts-text="${escapeHtml(textToSpeak)}" data-tts-lang="${escapeHtml(lang)}">${PLAY_SVG}</a>`;
        }
      }

      // Filter: {{text:FieldName}}
      if (/^text:/i.test(expr)) {
        const fName = expr.slice(5).trim();
        const rawVal = fieldMap[fName] !== undefined ? fieldMap[fName] : fieldMap[fName.toLowerCase()] || '';
        return escapeHtml(stripHtml(rawVal));
      }

      // Filter: {{type:FieldName}}
      if (/^type:/i.test(expr)) {
        const fName = expr.slice(5).trim();
        const rawVal = fieldMap[fName] !== undefined ? fieldMap[fName] : fieldMap[fName.toLowerCase()] || '';
        if (!isBack) {
          const expected = stripHtml(rawVal);
          return `<div class="typeans-wrap"><input id="typeans" type="text" class="anki-typeans" placeholder="輸入答案..." value="${escapeHtml(
            typedAnswer || ''
          )}" data-expected="${escapeHtml(expected)}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>`;
        } else {
          return renderTypeComparison(typedAnswer, rawVal);
        }
      }

      // Filter: {{cloze:FieldName}}
      if (/^cloze:/i.test(expr)) {
        const fName = expr.slice(6).trim();
        const rawVal = fieldMap[fName] !== undefined ? fieldMap[fName] : fieldMap[fName.toLowerCase()] || '';
        return renderClozeText(rawVal, cardOrd, isBack);
      }

      // Standard field lookup
      if (fieldMap[expr] !== undefined) return fieldMap[expr];
      if (fieldMap[expr.toLowerCase()] !== undefined) return fieldMap[expr.toLowerCase()];
      return '';
    });

    // 4. Replace [sound:filename.mp3] with Anki's .replay-button SVG
    out = out.replace(/\[sound:([^\]]+)\]/gi, (_m, soundFile) => {
      const cleanFile = soundFile.trim();
      if (cleanFile === '_1sec.mp3') return '';
      return `<a class="replay-button soundLink" href="#" role="button" title="播放音訊 ${escapeHtml(
        cleanFile
      )}" data-sound="${escapeHtml(cleanFile)}" data-tts-fallback="${escapeHtml(
        fallbackTerm || ''
      )}">${PLAY_SVG}<span class="sound-badge">${escapeHtml(cleanFile)}</span></a>`;
    });

    // 5. Rewrite relative <img src="foo.jpg"> to resolve via /media/foo.jpg or offline blob store
    out = out.replace(/<img\s+([^>]*?)src=(["'])([^"']+)\2([^>]*)>/gi, (full, pre, quote, srcVal, post) => {
      if (
        srcVal.startsWith('http:') ||
        srcVal.startsWith('https:') ||
        srcVal.startsWith('data:') ||
        srcVal.startsWith('blob:') ||
        srcVal.startsWith('/media/')
      ) {
        return full;
      }
      return `<img ${pre}src="/media/${encodeURIComponent(srcVal)}" data-media-src="${escapeHtml(
        srcVal
      )}" onerror="this.style.display='none'"${post}>`;
    });

    return out;
  }

  function extractPrimaryEnglishTerm(fieldMap, fieldsList, fldsArr) {
    const priorityNames = ['Term', 'Word', 'English', 'Front', '單字', '英文', 'vacabulary'];
    for (const name of priorityNames) {
      if (fieldMap[name]) {
        const clean = stripHtml(fieldMap[name]);
        if (clean) return clean;
      }
    }
    for (let i = 0; i < fldsArr.length; i++) {
      const clean = stripHtml(fldsArr[i]);
      if (clean && /[a-zA-Z]/.test(clean)) return clean;
    }
    return '';
  }

  function renderAnkiCard({ card, note, notetype, deckName, typedAnswer = '', unit01AudioMap = null }) {
    const [, fldsArr, tagsStr] = note;
    const ord = Number(card[3] || 0);
    const fieldsList = (notetype && notetype.fields) || [];
    const templates = (notetype && notetype.templates) || [];
    const tmpl = templates.find((t) => Number(t.ord) === ord) || templates[0] || {
      name: 'Card 1',
      qfmt: '{{Front}}',
      afmt: '{{FrontSide}}<hr id=answer>{{Back}}'
    };

    const subdeck = String(deckName || '預設').split('::').pop();
    const fieldMap = {
      Tags: tagsStr || '',
      tags: tagsStr || '',
      Type: (notetype && notetype.name) || 'Basic',
      type: (notetype && notetype.name) || 'Basic',
      Deck: deckName || '預設',
      deck: deckName || '預設',
      Subdeck: subdeck,
      subdeck: subdeck,
      Card: tmpl.name || 'Card 1',
      card: tmpl.name || 'Card 1'
    };

    for (let i = 0; i < fldsArr.length; i++) {
      const fName = fieldsList[i] || `Field${i + 1}`;
      fieldMap[fName] = fldsArr[i];
      fieldMap[fName.toLowerCase()] = fldsArr[i];
    }

    const primaryTerm = extractPrimaryEnglishTerm(fieldMap, fieldsList, fldsArr);

    const frontHtmlRaw = evaluateTemplate(tmpl.qfmt, fieldMap, {
      isBack: false,
      cardOrd: ord,
      typedAnswer,
      fallbackTerm: primaryTerm
    });

    // For {{FrontSide}} inside the back template, strip the interactive <input id="typeans"> so it isn't duplicated
    const frontForBack = frontHtmlRaw.replace(/<div class="typeans-wrap">[\s\S]*?<\/div>/gi, '');

    const backHtmlRaw = evaluateTemplate(tmpl.afmt, fieldMap, {
      isBack: true,
      frontRenderedHtml: frontForBack,
      cardOrd: ord,
      typedAnswer,
      fallbackTerm: primaryTerm
    });

    // Inject interactive TTS buttons onto E62 example lines & headword if no native [sound:] button is present
    const enrichE62Audio = (html) => {
      let enriched = html;
      // Check if unit01AudioMap has real MP3 files for this E62 term
      const termLower = (fieldMap.Term || '').trim().toLowerCase();
      const posRaw = (fieldMap.PartOfSpeech || '').trim();
      const audioEntry =
        unit01AudioMap && termLower ? unit01AudioMap[`${termLower}__${posRaw}`] || unit01AudioMap[termLower] : null;

      // Add a subtle speaker button next to .head .term if not already containing a replay-button
      if (fieldMap.Term && !enriched.includes('head-tts-btn')) {
        const wordSoundAttr =
          audioEntry && audioEntry.wordAudio
            ? `data-sound="${escapeHtml(audioEntry.wordAudio)}"`
            : '';
        enriched = enriched.replace(
          /(<span class="pos">[\s\S]*?<\/span>)/i,
          `$1 <a class="replay-button soundLink head-tts-btn" href="#" role="button" title="發音: ${escapeHtml(
            stripHtml(fieldMap.Term)
          )}" ${wordSoundAttr} data-tts-text="${escapeHtml(stripHtml(fieldMap.Term))}" data-tts-lang="en-US">${PLAY_SVG}</a>`
        );
      }

      // Make each .example-line or .usage-en clickable for instant TTS/audio playback on iOS
      enriched = enriched.replace(
        /<div class="(example-line|usage-en)">([\s\S]*?)<\/div>/gi,
        (full, cls, innerHtml) => {
          const cleanSentence = stripHtml(innerHtml);
          if (!cleanSentence) return full;
          return `<div class="${cls} speakable-sentence" data-tts-text="${escapeHtml(
            cleanSentence
          )}" data-tts-lang="en-US" title="點擊朗讀例句">${innerHtml} <span class="sentence-speaker" aria-hidden="true">🔊</span></div>`;
        }
      );

      return enriched;
    };

    const finalFrontHtml = enrichE62Audio(frontHtmlRaw);
    const finalBackHtml = enrichE62Audio(backHtmlRaw);

    return {
      frontHtml: finalFrontHtml,
      backHtml: finalBackHtml,
      css: (notetype && notetype.css) || '',
      primaryTerm,
      fieldMap,
      templateName: tmpl.name
    };
  }

  global.AnkiRenderer = {
    stripHtml,
    escapeHtml,
    renderAnkiCard
  };
})(typeof window !== 'undefined' ? window : globalThis);
