# Anki iOS Offline PWA (`anki-ios-pwa`)

基於 `morluto/rea` (`rea@6.5.0`) 逆向分析 Anki Desktop (`Anki.app` v26.9.3 / `_rsbridge.so` / `_aqt/data/web`) 之 Reviewer 渲染器、SQLite v18 資料庫 (`WITHOUT ROWID` B-Tree + `unicase`) 與 Protobuf 模板設定所打造的 **iOS 全離線背卡 Progressive Web App**。無須購買或安裝付費版 AnkiMobile，即可在 iPhone / iPad Safari「加入主畫面」100% 離線背單字、發音與記錄 SM-2 排程進度。

## 功能特色

1. **完整館藏 + 每個牌組獨立離線音檔包**：
   - 文字資料一次載入（約 4.8 MB），牌組列表預設全部收合，點 ▶ 展開各牌組的子單元。
   - 音檔與圖片（完整館藏約 625 MB）依牌組拆成獨立 `.zip` 牌組包（見下方「離線音檔包」），每個牌組列都有 🔊 標籤顯示該牌組是否已離線，點擊可匯入／移除。
   - 館藏包含 `E62 English2000 全書`（2,912 張）、`E62 Validation`（99 張）、 `4000 Essential English Words` (Book 1–6)、`常春藤` (L1–L3)、`高中核心6000單` (level 1–6)、`英文7000單字`、`英文1600單字`、`新北市正德國中英文2000單字(1)-(3)` 與 `English::idiom`。
2. **Anki Reviewer 模板與音訊渲染器 (`js/renderer.js`)**：
   - 支援 `{{Field}}`、`{{#Field}}...{{/Field}}`、`{{^Field}}...{{/Field}}`、`{{FrontSide}}`、`{{text:Field}}`、`{{type:Field}}`（打字比對輸入框）、`{{cloze:Field}}`（克漏字）、`{{tts en_US:Field}}` 與 `[sound:xxx.mp3]`。
   - 優先播放真實 `.mp3` 音訊，離線無音訊檔時自動 fallback 至 iOS Safari 內建離線語音合成（Web Speech API `speechSynthesis`）。
3. **Anki SM-2 / v3 間隔重複排程器 (`js/scheduler.js`)**：
   - 支援四鍵評分（`重來 Again` / `困難 Hard` / `良好 Good` / `簡單 Easy`）、按鈕上方下次間隔預覽、單步復原 (`Undo`)，並自動將卡片狀態與 `revlog` 持久化至 iOS `IndexedDB` 與 `localStorage`。
4. **純前端 `.apkg` / `.colpkg` / `.anki2` / `.json` 離線解析匯入 (`js/sqlite-apkg.js`)**：
   - 零外部相依性，在瀏覽器內直接實作 ZIP 解壓縮 (`DecompressionStream`)、SQLite 3 Table/Index B-Tree 讀取器與 Anki v18 Protobuf 解碼器。

## 離線音檔包（每個牌組獨立匯入）

```bash
# 依 data/full-bundle.js 的牌組內容，產生每個牌組一包的 zip（輸出至 dist/packs/，不進 git）並更新 data/media-manifest.js
python3 scripts/build_media_packs.py
```

- 每個頂層牌組一包；`4000 Essential English Words`（222 MB）再依 Book 1–6 / Extra 拆開，單包約 35 MB。
- 用 AirDrop 把需要的 zip 傳到 iPhone「檔案」，在 App 牌組列的 🔊 標籤、或「匯入與統計」分頁選取（可一次多選）。匯入採分段讀取，不會把整包讀進記憶體；音檔存於 IndexedDB，飛航模式可播放，也可單獨移除某個牌組。複習進度不受影響。
- 若某卡的音檔不在牌組包內，會自動改用 iOS 內建語音朗讀。`高中核心6000單` 有 4,401 個音檔不在電腦的 Anki 媒體庫中，因此只能語音朗讀。
- 修改 `data/full-bundle.js` 或媒體庫後，請重新執行上述指令，並把 `data/media-manifest.js` 一併提交（App 會用 `version` 提示牌組包有新版）。
- `python3 scripts/build_pwa.py --standalone-only` 可只重建單檔 HTML，不重新讀取 Anki 資料庫。

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
# 重新建置每個牌組的離線音檔包
python3 scripts/build_media_packs.py

# 執行自動化測試 (驗證雙資料包解壓、模板渲染、SM-2 排程與純 JS SQLite3 B-Tree 讀取器)
node tests/test_pwa.js
```
