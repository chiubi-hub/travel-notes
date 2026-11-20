// 旅記收藏中繼服務（Google Apps Script 網頁應用程式）
// 旅記網頁不能直接呼叫 Notion API（瀏覽器會擋），所以由這支程式代為轉送。
// Notion 金鑰只放在 Apps Script 的「指令碼屬性」，不會出現在網頁或 GitHub。
//
// 需要設定的指令碼屬性（專案設定 → 指令碼屬性）：
//   NOTION_TOKEN  Notion 整合「旅遊收藏」的金鑰
//   APP_KEY       自己訂的一組密碼，旅記連線時要輸入同一組
// 設定步驟見 gas/README.md。
//
// 預覽圖：旅記先把圖片壓縮成小 JPEG，再交給這支程式用 Notion 的檔案上傳 API 存進卡片的「預覽圖」欄位，
// 所以原本網站的圖片連結過期也不影響。

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

// Notion 回傳的檔案網址約 1 小時後失效，旅記每次讀取都會拿到新的。
function fileUrl(prop) {
  const f = prop && prop.files && prop.files[0];
  if (!f) return "";
  return (f.file && f.file.url) || (f.external && f.external.url) || "";
}

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
    image: fileUrl(pr["預覽圖"]),
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

// ---------- 抓網頁標題（給分類比對用，不會存進卡片） ----------
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(+n); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}
function firstLine(s) {
  const line = String(s || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}
function readMeta(html) {
  const meta = function (prop) {
    const re1 = new RegExp("<meta[^>]+(?:property|name)=[\"']" + prop + "[\"'][^>]*content=[\"']([^\"']*)[\"']", "i");
    const re2 = new RegExp("<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*(?:property|name)=[\"']" + prop + "[\"']", "i");
    const m = html.match(re1) || html.match(re2);
    return m ? decodeEntities(m[1]) : "";
  };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const clean = function (x) { return String(x || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim(); };
  let title = clean(meta("og:title") || (t ? decodeEntities(t[1]) : ""));
  let description = clean(meta("og:description") || meta("description"));
  const m = title.match(/^(.+?) (?:on|在) (Instagram|Threads)[:：]\s*["“]?([\s\S]*?)["”]?$/);
  if (m) {
    const caption = m[3].trim();
    title = (firstLine(caption) || m[1]) + "（" + m[1] + "）";
    if (caption.length > description.length) description = caption;
  } else if (title.indexOf("\n") >= 0) {
    if (!description) description = title;
    title = firstLine(title);
  }
  let image = meta("og:image:secure_url") || meta("og:image") || meta("twitter:image") || meta("twitter:image:src");
  return { title: title, description: description, image: image };
}
function fetchMeta(url) {
  if (!/^https?:\/\//i.test(url || "")) throw new HttpError(400, "網址格式錯誤");
  try {
    const r = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" },
    });
    const m = readMeta(r.getContentText().slice(0, 500000));
    if (m.image && !/^https?:\/\//i.test(m.image)) {
      const base = url.match(/^https?:\/\/[^\/]+/i)[0];
      m.image = m.image.indexOf("//") === 0 ? "https:" + m.image : m.image.charAt(0) === "/" ? base + m.image : "";
    }
    return m;
  } catch (e) {
    return { title: "", description: "", image: "" }; // 抓不到（例如登入牆）就只存連結
  }
}

// ---------- 預覽圖 ----------
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMG = 5 * 1024 * 1024; // Notion 免費方案單檔上限

// 下載網站的預覽圖交給旅記壓縮（瀏覽器不能直接讀別的網站的圖片）
function fetchImage(url) {
  if (!/^https?:\/\//i.test(url || "")) throw new HttpError(400, "圖片網址格式錯誤");
  const r = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" },
  });
  if (r.getResponseCode() >= 400) throw new HttpError(502, "抓不到預覽圖");
  const blob = r.getBlob(), type = String(blob.getContentType() || "").split(";")[0].toLowerCase();
  const bytes = blob.getBytes();
  if (type.indexOf("image/") !== 0) throw new HttpError(415, "不是圖片");
  if (bytes.length > 15 * 1024 * 1024) throw new HttpError(413, "預覽圖太大");
  return { type: type, b64: Utilities.base64Encode(bytes) };
}

// 用 Notion 檔案上傳 API 上傳，回傳 file_upload id
function uploadImage(token, img) {
  const type = String(img.type || "image/jpeg").toLowerCase();
  if (IMG_TYPES.indexOf(type) < 0) throw new HttpError(415, "圖片格式不支援");
  const bytes = Utilities.base64Decode(String(img.b64 || ""));
  if (!bytes.length) throw new HttpError(400, "圖片是空的");
  if (bytes.length > MAX_IMG) throw new HttpError(413, "圖片超過 5MB");
  const name = "preview." + type.split("/")[1].replace("jpeg", "jpg");
  const up = notion(token, "POST", "file_uploads", { mode: "single_part", filename: name, content_type: type });
  const res = UrlFetchApp.fetch("https://api.notion.com/v1/file_uploads/" + up.id + "/send", {
    method: "post",
    headers: { Authorization: "Bearer " + token, "Notion-Version": NOTION_VERSION },
    payload: { file: Utilities.newBlob(bytes, type, name) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 400) {
    let msg = res.getResponseCode();
    try { msg = JSON.parse(res.getContentText()).message || msg; } catch (e) {}
    throw new HttpError(res.getResponseCode(), "Notion 上傳圖片：" + msg);
  }
  return { name: name, id: up.id };
}

function imageProp(token, img) {
  if (!img) return { files: [] };
  const u = uploadImage(token, img);
  return { files: [{ type: "file_upload", file_upload: { id: u.id }, name: u.name }] };
}

function newCard(b) {
  const SOURCES = ["Instagram", "Threads", "網頁", "截圖", "照片", "影片", "其他"];
  const props = {
    "標題": { title: text(b.title || b.url || "未命名收藏") },
    "來源": { select: { name: SOURCES.indexOf(b.source) >= 0 ? b.source : "其他" } },
    "狀態": { status: { name: "待整理" } },
  };
  if (b.url) props["原始連結"] = { url: String(b.url).slice(0, 2000) };
  if (b.categoryId) {
    if (!ID_RE.test(b.categoryId)) throw new HttpError(400, "分類格式錯誤");
    props["分類"] = { relation: [{ id: b.categoryId }] };
  }
  return { parent: { database_id: CARD_DB }, properties: props };
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
  if (res === "meta" && method === "POST" && !id) return fetchMeta(body.url);
  if (res === "image" && method === "POST" && !id) return fetchImage(body.url);
  if (res === "cards" && method === "POST" && !id) {
    const page = newCard(body);
    if (body.image) page.properties["預覽圖"] = imageProp(token, body.image);
    return toCard(notion(token, "POST", "pages", page));
  }
  if (res === "cards" && method === "PATCH" && id) {
    const props = cardProps(body);
    if (body.image !== undefined) props["預覽圖"] = imageProp(token, body.image); // null = 移除
    return toCard(notion(token, "PATCH", "pages/" + id, { properties: props }));
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
