# Anki iOS Offline PWA (`anki-ios-pwa`)

基於 `morluto/rea` (`rea@6.5.0`) 逆向分析 Anki Desktop (`Anki.app` v26.9.3 / `_rsbridge.so` / `_aqt/data/web`) 之 Reviewer 渲染器、SQLite v18 資料庫 (`WITHOUT ROWID` B-Tree + `unicase`) 與 Protobuf 模板設定所打造的 **iOS 全離線背卡 Progressive Web App**。無須購買或安裝付費版 AnkiMobile，即可在 iPhone / iPad Safari「加入主畫面」100% 離線背單字、發音與記錄 SM-2 排程進度。

## 功能特色

1. **雙館藏一鍵切換**：
   - **E62 全書核心館藏（3,011 張卡）**：包含 `E62 English2000 全書`（Unit 01–50 共 2,912 張 `Term × POS` 詞性整併卡、5,720 個詞義用法）與 `E62 Validation::Unit01`（99 張卡，保留既有學習/複習排程與 Unit 01 真人發音對應）。
   - **完整館藏（29,603 張卡 / 80 個子牌組）**：包含 `4000 Essential English Words` (Book 1–6)、`常春藤` (L1–L3)、`高中核心6000單` (level 1–6)、`英文7000單字`、`英文1600單字`、`新北市正德國中英文2000單字(1)-(3)` 與 `English::idiom`。
2. **Anki Reviewer 模板與音訊渲染器 (`js/renderer.js`)**：
   - 支援 `{{Field}}`、`{{#Field}}...{{/Field}}`、`{{^Field}}...{{/Field}}`、`{{FrontSide}}`、`{{text:Field}}`、`{{type:Field}}`（打字比對輸入框）、`{{cloze:Field}}`（克漏字）、`{{tts en_US:Field}}` 與 `[sound:xxx.mp3]`。
   - 優先播放真實 `.mp3` 音訊，離線無音訊檔時自動 fallback 至 iOS Safari 內建離線語音合成（Web Speech API `speechSynthesis`）。
3. **Anki SM-2 / v3 間隔重複排程器 (`js/scheduler.js`)**：
   - 支援四鍵評分（`重來 Again` / `困難 Hard` / `良好 Good` / `簡單 Easy`）、按鈕上方下次間隔預覽、單步復原 (`Undo`)，並自動將卡片狀態與 `revlog` 持久化至 iOS `IndexedDB` 與 `localStorage`。
4. **純前端 `.apkg` / `.colpkg` / `.anki2` / `.json` 離線解析匯入 (`js/sqlite-apkg.js`)**：
   - 零外部相依性，在瀏覽器內直接實作 ZIP 解壓縮 (`DecompressionStream`)、SQLite 3 Table/Index B-Tree 讀取器與 Anki v18 Protobuf 解碼器。

## 在 iPhone / iPad 上安裝與離線使用

### 方式 A：透過 GitHub Pages 或區網伺服器「加入主畫面」（最推薦）

1. **本機 / 區網啟動伺服器**：
   ```bash
   python3 server.py --port 8766
   ```
2. 在 iPhone **Safari** 開啟區網網址（或 GitHub Pages 網址 `https://colaman7014.github.io/anki-ios-pwa/`）。
3. 點擊 Safari 底部「**分享 (Share)**」$\rightarrow$「**加入主畫面 (Add to Home Screen)**」。
4. Service Worker (`sw.js`) 會將應用程式與牌組完整快取至手機本機，之後即使開啟飛航模式亦可 100% 離線背卡。

### 方式 B：單一 HTML 獨立檔 (`dist/anki-ios-offline.html`)

- `dist/anki-ios-offline.html` 將所有 CSS、JavaScript 與 E62 3,011 張卡片封裝為單一 HTML 檔案（約 1 MB），可透過 AirDrop 傳送並使用支援本地 HTML 的閱讀器（如 Documents by Readdle 或 Koder）離線開啟。

## 開發與測試

```bash
# 重新由唯讀 SQLite 快照建置資料包與單檔 HTML
python3 scripts/build_pwa.py

# 執行自動化測試 (驗證雙資料包解壓、模板渲染、SM-2 排程與純 JS SQLite3 B-Tree 讀取器)
node tests/test_pwa.js
```
