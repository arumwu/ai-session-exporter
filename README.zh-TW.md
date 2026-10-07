# AI Session Exporter

[English](README.md)

連結本機既有的 Claude 與 Codex 會話，只匯出選取的人與 AI 文字，並透過原工具接續同一個會話。函式庫、命令列與本機網頁都可獨立使用，不需要 Project Hub。

## 必要條件

Node.js **22.13 以上**，不需要安裝 npm 相依套件。接續會話還需要已安裝的 Claude 或 Codex CLI、原有登入、原始紀錄與工作資料夾。列出與匯出會話不會啟動 AI。

```sh
git clone https://github.com/arumwu/ai-session-exporter.git
cd ai-session-exporter
node bin/session-exporter.js --help
```

## 列出與匯出選取的會話

```sh
node bin/session-exporter.js list --provider codex
node bin/session-exporter.js export --provider codex --id SESSION_ID_FROM_LIST
node bin/session-exporter.js export --provider codex --id SESSION_ID_FROM_LIST --id ANOTHER_ID --format markdown --output selected.md
```

請使用 `list` 回傳的 ID，不要填檔名或自行猜原生會話 UUID。匯出必須明確指定至少一個 `--id`，不會預設匯出全部。預設輸出 JSON 到終端機；`--format markdown` 可產生 UTF-8 文字。`--output` 只建立新檔，不覆寫既有檔案，且必須放在來源紀錄目錄之外。

JSON 包含格式版本、匯出時間、AI 來源、選取 ID、名稱、原工作資料夾及人與 AI 的文字訊息，並附讀取警告。系統或開發者訊息、隱藏推理、工具呼叫與結果、附件、登入憑證與權限設定都不會匯出。匯出檔留在本機；是否分享由你另外決定。

## 本機網頁

```sh
node bin/session-exporter.js serve --data-dir /path/to/private/session-links
```

開啟 `http://127.0.0.1:4747`。所有會話預設未選取，只勾需要的會話；預覽數量與讀取警告後，再確認保存連結。下載 JSON 或 Markdown 時，也只處理目前明確選取的會話。

連結指向原始位置；會話紀錄與工作資料夾都留在原處。私人資料目錄只保存 `_hub/session-links.json` 與傳送收據，不複製會話本文。移除連結只刪除此處的連結資料；來源缺失時保留連結並標示無法讀取。

要續聊時，開啟已保存的連結並手動送出訊息。Claude 接續原生會話 ID；Codex 先讀取並接續同一個 thread，再開始這一回合。原工具使用既有登入與權限，將新回合寫入原始紀錄。需要批准的操作會顯示確認，停止只中斷本次啟動的工具程序。來源缺失、變動或忙碌時會停止，不會改開新會話或分支。

原 App 與此介面使用同一份會話紀錄；重新開啟原會話可在原 App 閱讀，不保證兩個畫面即時同步刷新。確認原工具回傳同一個會話 ID，且原始歷史確實更新後，才標示完成。失敗或重啟後若無法判定訊息是否送達，請先查看原會話，再決定是否重送。

## 來源與儲存位置

| 選項 | 用途 |
| --- | --- |
| `--codex-home DIR` | Codex 紀錄根目錄；未指定時用 `CODEX_HOME` 或 `~/.codex`。 |
| `--codex-sqlite-home DIR` | 獨立的資料庫根目錄；未指定時用 `CODEX_SQLITE_HOME` 或 Codex 紀錄根目錄。 |
| `--claude-desktop-dir DIR` | Claude Desktop 本機資料；未指定時用 `HUB_CLAUDE_DESKTOP_DIR` 或本機 Claude Desktop 目錄。 |
| `--claude-projects-dir DIR` | 與 Desktop 會話對應的 Claude Code 紀錄；未指定時用 `CLAUDE_CONFIG_DIR/projects` 或 `~/.claude/projects`。 |
| `--data-dir DIR` | 私人連結與收據目錄；未指定時用 `AI_SESSION_EXPORTER_HOME` 或 `~/.config/ai-session-exporter`。 |
| `--port PORT` | 本機網頁連接埠，預設 `4747`。 |
| `--host 127.0.0.1\|::1` | 只允許本機連線，預設 `127.0.0.1`。 |

來源路徑只從命令列或環境變數設定，HTTP 請求不能指定讀取路徑。若設定 `HUB_STORAGE_GUARD`，建立或保存私人資料、送出新回合前，都必須取得 `STATUS=OK`。本機規則要求使用資料磁碟時，請指定已掛載的私人資料位置；不會自動退回其他磁碟。

Claude 以 Desktop 群組對照本機可讀的 CLI 紀錄。Codex 整合唯讀 SQLite、會話索引與有上限的紀錄標頭，依證據標示 Desktop／CLI／IDE／未知，並保留封存及子代理資訊。清單可能不完整：SQLite 有待寫入的 journal 時會略過資料庫，改用索引與標頭並顯示警告，避免改動來源的附屬檔案。設定與登入檔不會搬移；原工具規格變更或本機紀錄缺失，可能使會話無法列出或續聊。

選取紀錄採串流讀取，上限為 200 個會話、每檔 128 MiB、總輸入 256 MiB、保留文字 8 MiB、10,000 筆文字訊息。格式不正確、紀錄變動或超過上限時會停止，不會默默截短對話。

## 本機 API 與函式庫

```js
const { sourcesFor, listSessions, exportSessions, formatExport } = require('./lib');
const sources = sourcesFor({ codexHome: '/path/to/codex' });
const inventory = await listSessions(sources, 'codex');
const selected = inventory.providers[0].sessions[0];
const output = await exportSessions(sources, [{ provider: 'codex', id: selected.id }]);
console.log(formatExport(output, 'json'));
```

讀取入口為 `GET /api/session-links`、`/history?id=...`、`/status?id=...`。`/api/session-links/` 下的 JSON POST 入口為 `/preview`、`/apply`、`/remove`、`/export`、`/send`、`/answer`、`/stop`；寫入必須有 `X-Hub: 1`、相同來源及合法的本機 Host。匯出接受 `{ "selected": ["inventory-opaque-id"], "format": "json" }`；這裡使用本機網頁清單的 ID，與 CLI 的固定 ID 不同。不開放 CORS 或遠端監聽；靜態檔案只開放明列的路徑。

## 驗證與授權

```sh
npm test
```

測試使用隔離的虛構資料與模擬工具協定，涵蓋僅讀選取內容、來源不變、過期紀錄、本機 API 防護、同一會話、權限確認及避免重送。測試通過不等於每個版本的原 App 畫面都已驗證即時刷新。

2026-10-07 另以官方內附 Codex **0.160.1** 與 Claude **2.1.289** CLI 實測；兩者都接續同一個原生會話 ID，將下一次回覆保存到原檔，既有紀錄的前段保持不變。測試只使用新建的隔離會話，未匯入既有使用者對話或複製登入憑證。原 App 畫面的即時刷新仍待驗證。

MIT 授權。共用來源模組的出處見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
