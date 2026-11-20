// 旅記收藏中繼服務（Google Apps Script 網頁應用程式）
// 旅記網頁不能直接呼叫 Notion API（瀏覽器會擋），所以由這支程式代為轉送。
// Notion 金鑰只放在 Apps Script 的「指令碼屬性」，不會出現在網頁或 GitHub。
//
// 需要設定的指令碼屬性（專案設定 → 指令碼屬性）：
//   NOTION_TOKEN  Notion 整合「旅遊收藏」的金鑰
//   APP_KEY       自己訂的一組密碼，旅記連線時要輸入同一組
// 設定步驟見 gas/README.md。

const TREE_DB = "41e75a8073c581598735d163f176de97"; // 分類樹
const CARD_DB = "41e75a8073c581e0ab66dfbc343c3ca1"; // 收藏卡片
const NOTION_VERSION = "2022-06-28";
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function notion(token, method, path, body) {
  const res = UrlFetchApp.fetch("https://api.notion.com/v1/" + path, {
    method: method.toLowerCase(),
    headers: { Authorization: "Bearer " + token, "Notion-Version": NOTION_VERSION },
    contentType: "application/json",
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  const code = res.getResponseCode();
  if (code >= 400) throw new HttpError(code, "Notion：" + (data.message || code));
  return data;
}

function queryAll(token, db, extra) {
  const out = [];
  let cursor;
  do {
    const body = Object.assign({ page_size: 100 }, extra || {});
    if (cursor) body.start_cursor = cursor;
    const r = notion(token, "POST", "databases/" + db + "/query", body);
    out.push.apply(out, r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (arr) => (arr || []).map((t) => t.plain_text).join("");
const text = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 2000) } }];

function toNode(p) {
  const pr = p.properties || {};
  const rel = (pr["上層分類"] && pr["上層分類"].relation) || [];
  return {
    id: p.id,
    name: plain(pr["名稱"] && pr["名稱"].title) || "（未命名）",
    keywords: plain(pr["關鍵字"] && pr["關鍵字"].rich_text),
    parent: rel.length ? rel[0].id : null,
  };
}

function toCard(p) {
  const pr = p.properties || {};
  const rel = (pr["分類"] && pr["分類"].relation) || [];
  return {
    id: p.id,
    notionUrl: p.url,
    title: plain(pr["標題"] && pr["標題"].title) || "（未命名）",
    source: pr["來源"] && pr["來源"].select ? pr["來源"].select.name : "",
    url: (pr["原始連結"] && pr["原始連結"].url) || "",
    categoryId: rel.length ? rel[0].id : null,
    status: pr["狀態"] && pr["狀態"].status ? pr["狀態"].status.name : "",
    place: plain(pr["地點名稱"] && pr["地點名稱"].rich_text),
    address: plain(pr["地址"] && pr["地址"].rich_text),
    lat: pr["緯度"] ? pr["緯度"].number : null,
    lng: pr["經度"] ? pr["經度"].number : null,
    mapUrl: (pr["地圖連結"] && pr["地圖連結"].url) || "",
    travelId: plain(pr["旅記 ID"] && pr["旅記 ID"].rich_text),
    created: p.created_time,
  };
}

function nodeProps(b) {
  const props = {};
  if (b.name != null) props["名稱"] = { title: text(b.name) };
  if (b.keywords != null) props["關鍵字"] = { rich_text: text(b.keywords) };
  if (b.parent !== undefined) {
    if (b.parent && !ID_RE.test(b.parent)) throw new HttpError(400, "parent 格式錯誤");
    props["上層分類"] = { relation: b.parent ? [{ id: b.parent }] : [] };
  }
  return props;
}

function cardProps(b) {
  const props = {};
  const STATUS = ["待整理", "已整理", "已排入行程", "封存"];
  if (b.status != null) {
    if (!STATUS.includes(b.status)) throw new HttpError(400, "狀態不正確");
    props["狀態"] = { status: { name: b.status } };
  }
  if (b.travelId != null) props["旅記 ID"] = { rich_text: text(b.travelId) };
  if (b.place != null) props["地點名稱"] = { rich_text: text(b.place) };
  if (b.address != null) props["地址"] = { rich_text: text(b.address) };
  if (b.lat !== undefined) props["緯度"] = { number: b.lat == null ? null : Number(b.lat) };
  if (b.lng !== undefined) props["經度"] = { number: b.lng == null ? null : Number(b.lng) };
  if (b.mapUrl != null) props["地圖連結"] = { url: b.mapUrl || null };
  if (b.categoryId !== undefined) {
    if (b.categoryId && !ID_RE.test(b.categoryId)) throw new HttpError(400, "分類格式錯誤");
    props["分類"] = { relation: b.categoryId ? [{ id: b.categoryId }] : [] };
  }
  return props;
}

function handle(req, token) {
  const parts = String(req.path || "").split("/").filter(Boolean);
  const res = parts[0], id = parts[1], method = req.method, body = req.body || {};
  if (parts.length > 2 || (id && !ID_RE.test(id))) throw new HttpError(400, "ID 格式錯誤");

  if (res === "tree" && method === "GET" && !id) return queryAll(token, TREE_DB).map(toNode);
  if (res === "tree" && method === "POST" && !id) {
    if (!body.name) throw new HttpError(400, "缺少名稱");
    return toNode(notion(token, "POST", "pages", { parent: { database_id: TREE_DB }, properties: nodeProps(body) }));
  }
  if (res === "tree" && method === "PATCH" && id) {
    return toNode(notion(token, "PATCH", "pages/" + id, { properties: nodeProps(body) }));
  }
  if (res === "cards" && method === "GET" && !id) {
    return queryAll(token, CARD_DB, { sorts: [{ timestamp: "created_time", direction: "descending" }] }).map(toCard);
  }
  if (res === "cards" && method === "PATCH" && id) {
    return toCard(notion(token, "PATCH", "pages/" + id, { properties: cardProps(body) }));
  }
  throw new HttpError(404, "沒有這個路徑");
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 旅記用 POST（Content-Type: text/plain）送 {key, method, path, body}，避免瀏覽器的跨網域預檢。
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty("NOTION_TOKEN"), appKey = props.getProperty("APP_KEY");
    if (!token || !appKey) throw new HttpError(500, "尚未設定指令碼屬性 NOTION_TOKEN 或 APP_KEY");
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (req.key !== appKey) throw new HttpError(401, "密碼不正確");
    return reply({ ok: true, data: handle(req, token) });
  } catch (err) {
    return reply({ ok: false, status: err.status || 500, error: err.message });
  }
}

// 在瀏覽器直接打開網址時，用來確認部署成功。
function doGet() {
  return reply({ ok: true, message: "旅記收藏中繼服務運作中" });
}
