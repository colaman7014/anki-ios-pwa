const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
require('../js/sqlite-apkg.js');
require('../js/renderer.js');
require('../js/scheduler.js');
require('../data/e62-bundle.js');
require('../data/full-bundle.js');

const { decompressBase64Gzip, convertAnkiSqliteToCollection } = global.AnkiSqliteApkg;
const { renderAnkiCard } = global.AnkiRenderer;
const { computeNextState, previewAllIntervals, buildDeckTree, buildStudyQueue } = global.AnkiScheduler;

async function runTests() {
  console.log('1. Testing E62 Core Bundle decompression & structure...');
  const e62Col = await decompressBase64Gzip(global.ANKI_E62_BUNDLE_B64_GZ);
  assert.strictEqual(e62Col.cards.length, 3011, 'E62 bundle should contain 3,011 cards (2,912 Fullbook + 99 Validation)');
  const e62Tree = buildDeckTree(e62Col.decks, e62Col.cards, e62Col.crt);
  const fullbookRoot = e62Tree.byPath.get('E62 English2000 全書');
  assert(fullbookRoot, 'E62 English2000 全書 root deck must exist');
  assert.strictEqual(fullbookRoot.children.length, 50, 'E62 English2000 全書 must have 50 Unit subdecks');
  assert.strictEqual(fullbookRoot.totalCount, 2912, 'E62 English2000 全書 must roll up 2,912 cards');

  console.log('2. Testing Full 29,603-card Library Bundle decompression & structure...');
  const fullCol = await decompressBase64Gzip(global.ANKI_FULL_BUNDLE_B64_GZ);
  assert.strictEqual(fullCol.cards.length, 29603, 'Full bundle should contain 29,603 cards');
  assert.strictEqual(Object.keys(fullCol.notetypes).length, 16, 'Full bundle should contain 16 notetypes');

  console.log('3. Testing Anki Template & Audio Renderer across notetypes...');
  const sampleCard = e62Col.cards.find((c) => e62Col.decks[String(c[2])] === 'E62 English2000 全書::Unit 01');
  assert(sampleCard, 'Unit 01 sample card must exist');
  const sampleNote = e62Col.notes[String(sampleCard[1])];
  const sampleNt = e62Col.notetypes[String(sampleNote[0])];
  const rendered = renderAnkiCard({
    card: sampleCard,
    note: sampleNote,
    notetype: sampleNt,
    deckName: 'E62 English2000 全書::Unit 01',
    unit01AudioMap: global.ANKI_UNIT01_AUDIO_MAP
  });
  assert(rendered.frontHtml.includes('e62-front'), 'Front HTML must contain e62-front');
  assert(rendered.backHtml.includes('e62-back'), 'Back HTML must contain e62-back');
  assert(rendered.backHtml.includes('id="answer"'), 'Back HTML must contain hr#answer');
  assert(rendered.css.includes('.card'), 'Notetype CSS must include .card rules');

  console.log('4. Testing SM-2 / v3 Scheduler state transitions...');
  const newCard = [1001, 2001, 3001, 0, 0, 0, 1, 0, 0, 0, 0];
  const previews = previewAllIntervals(newCard, e62Col.crt);
  assert.strictEqual(previews[1], '<1分鐘');
  assert.strictEqual(previews[2], '6分鐘');
  assert.strictEqual(previews[3], '10分鐘');
  assert.strictEqual(previews[4], '4天');

  const afterGood1 = computeNextState(newCard, 3, e62Col.crt).nextCard;
  assert.strictEqual(afterGood1[5], 1, 'New card rated Good enters learning queue (1)');
  const afterGood2 = computeNextState(afterGood1, 3, e62Col.crt).nextCard;
  assert.strictEqual(afterGood2[5], 2, 'Learning card rated Good graduates to review queue (2)');
  assert.strictEqual(afterGood2[7], 1, 'Graduated card has 1-day interval');

  const unit01Node = e62Tree.byPath.get('E62 English2000 全書::Unit 01');
  const studyQ = buildStudyQueue(e62Col.cards, unit01Node.dids, e62Col.crt, { newLimit: 50, revLimit: 200 });
  assert.strictEqual(studyQ.queue.length, 50, 'Study queue respects newLimit=50');

  console.log('5. Testing Pure-JS SQLite3 B-tree reader against live SQLite snapshot...');
  const sqlitePath = '/Users/colalin/repos/anki/build/anki-smoke/User 1/collection.anki2';
  if (fs.existsSync(sqlitePath)) {
    const dbBytes = new Uint8Array(fs.readFileSync(sqlitePath));
    const parsedFromDb = convertAnkiSqliteToCollection(dbBytes);
    assert.strictEqual(parsedFromDb.cards.length, 29603);
    assert.strictEqual(Object.keys(parsedFromDb.notes).length, 29603);
  }

  console.log('ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
