# 旅記「收藏」分頁的中繼服務（Cloudflare Worker）

旅記網頁不能直接讀取 Notion，因為瀏覽器會擋下這種請求。所以我們放一支小程式 [notion-proxy.js](notion-proxy.js) 在 Cloudflare 上，由它代替網頁跟 Notion 溝通。

- Cloudflare 免費方案每天可以呼叫 10 萬次，個人使用綽綽有餘。
- Notion 金鑰只存在 Cloudflare，不會出現在網頁或 GitHub 上。
- 旅記連線時，需要輸入你自己設定的一組密碼（APP_KEY）。

建議用 Mac 的瀏覽器操作，整個過程大約 10 分鐘。

## 1. 註冊 Cloudflare

到 <https://dash.cloudflare.com/sign-up> 用 Email 註冊一個免費帳號，然後完成信箱驗證。

## 2. 建立 Worker

1. 登入後，從左側選單進入 **Workers 和 Pages**（新版介面可能放在「運算 / Compute」底下）。
2. 按 **建立**，選 **從 Hello World 開始**（Start with Hello World）。
3. 名稱填 `travel-notes`，再按 **部署**。

## 3. 貼上程式

1. 部署完成後，按 **編輯程式碼**。
2. 把左邊編輯器裡原本的內容全部刪掉。
3. 打開 [notion-proxy.js 原始碼（raw）](https://raw.githubusercontent.com/chiubi-hub/travel-notes/main/worker/notion-proxy.js)，全選、拷貝，貼進編輯器。
4. 按右上角 **部署**。

## 4. 設定金鑰和密碼

回到這個 Worker 的頁面，進入 **設定 → 變數和機密**，新增下面兩個項目，**類型都選「機密」（Secret）**：

| 名稱 | 值 |
|---|---|
| `NOTION_TOKEN` | Notion 整合「旅遊收藏」的金鑰（就是捷徑用的同一把，`ntn_` 或 `secret_` 開頭） |
| `APP_KEY` | 自己訂一組密碼，例如一串英文加數字，旅記連線時會用到 |

兩個都存好後，再按一次 **部署**，讓設定生效。

## 5. 在旅記連線

1. 回到 Worker 頁面，拷貝上方的網址，格式是 `https://travel-notes.你的子網域.workers.dev`。
2. 打開旅記，切到最左邊的「**收藏**」分頁。
3. 貼上網址、輸入 APP_KEY 密碼，按「連接」。

連線成功後，就會看到你的分類樹和卡片。

## 常見問題

| 畫面上的訊息 | 原因 |
|---|---|
| 密碼不正確 | 旅記填的密碼和 APP_KEY 不一樣 |
| Worker 尚未設定 NOTION_TOKEN 或 APP_KEY | 第 4 步的變數還沒設定，或設定後沒有重新部署 |
| Notion：Could not find database… | 「旅記收藏」頁面沒有連接「旅遊收藏」整合 |
| 連線失敗 | 網址貼錯了，記得要 `https://` 開頭 |
