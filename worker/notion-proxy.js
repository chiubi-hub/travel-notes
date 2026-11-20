// 旅記收藏中繼服務（Cloudflare Worker）
// 旅記網頁不能直接呼叫 Notion API（瀏覽器會擋），所以由這支小程式代為轉送。
// Notion 金鑰只放在 Cloudflare 的環境變數裡，不會出現在網頁或 GitHub。
//
// 需要設定的環境變數（Cloudflare → Worker → 設定 → 變數和機密）：
//   NOTION_TOKEN  （機密）Notion 整合「旅遊收藏」的金鑰
//   APP_KEY       （機密）自己訂的一組密碼，旅記連線時要輸入同一組
// 部署步驟見 worker/README.md。

const TREE_DB = "41e75a8073c581598735d163f176de97"; // 分類樹
const CARD_DB = "41e75a8073c581e0ab66dfbc343c3ca1"; // 收藏卡片
const NOTION_VERSION = "2022-06-28";
const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-App-Key",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function notion(env, method, path, body) {
  const res = await fetch("https://api.notion.com/v1/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, "Notion：" + (data.message || res.status));
  return data;
}

async function queryAll(env, db, extra = {}) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100, ...extra };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(env, "POST", `databases/${db}/query`, body);
    out.push(...r.results);
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

async function handle(req, env) {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const [res, id] = parts;
  if (id && !ID_RE.test(id)) throw new HttpError(400, "ID 格式錯誤");
  const body = req.method === "POST" || req.method === "PATCH" ? await req.json().catch(() => ({})) : null;

  if (res === "tree" && req.method === "GET" && !id) {
    return (await queryAll(env, TREE_DB)).map(toNode);
  }
  if (res === "tree" && req.method === "POST" && !id) {
    if (!body.name) throw new HttpError(400, "缺少名稱");
    const p = await notion(env, "POST", "pages", { parent: { database_id: TREE_DB }, properties: nodeProps(body) });
    return toNode(p);
  }
  if (res === "tree" && req.method === "PATCH" && id) {
    return toNode(await notion(env, "PATCH", "pages/" + id, { properties: nodeProps(body) }));
  }
  if (res === "cards" && req.method === "GET" && !id) {
    const pages = await queryAll(env, CARD_DB, { sorts: [{ timestamp: "created_time", direction: "descending" }] });
    return pages.map(toCard);
  }
  if (res === "cards" && req.method === "PATCH" && id) {
    return toCard(await notion(env, "PATCH", "pages/" + id, { properties: cardProps(body) }));
  }
  throw new HttpError(404, "沒有這個路徑");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.APP_KEY || !env.NOTION_TOKEN) return json({ error: "Worker 尚未設定 NOTION_TOKEN 或 APP_KEY" }, 500);
    if (req.headers.get("X-App-Key") !== env.APP_KEY) return json({ error: "密碼不正確" }, 401);
    try {
      return json(await handle(req, env));
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  },
};
