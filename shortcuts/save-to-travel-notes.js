// 存到旅記 — Scriptable 腳本
// 由 iOS 捷徑「存到旅記」呼叫：接收網址／文字／截圖 OCR 文字，
// 依 Notion「分類樹」的關鍵字自動分類，再到「收藏卡片」建立一張卡片。
// 安裝與捷徑設定步驟見 shortcuts/README.md。

// ================= 設定 =================
// Notion 資料庫 ID（不是金鑰，公開也沒關係；金鑰存在手機的鑰匙圈）
const TREE_DB = "41e75a8073c581598735d163f176de97"; // 分類樹
const CARD_DB = "41e75a8073c581e0ab66dfbc343c3ca1"; // 收藏卡片
const TOKEN_KEY = "travelnotes.notion.token";
const NOTION_VERSION = "2022-06-28";

// ================= 純邏輯（可在電腦上測試） =================
const SEP = " › ";

function firstUrl(s) {
  const m = String(s || "").match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : "";
}

function guessSource(url, ocr) {
  if (!url) return ocr ? "截圖" : "其他";
  const h = url.toLowerCase();
  if (/instagram\.com/.test(h)) return "Instagram";
  if (/threads\.(net|com)/.test(h)) return "Threads";
  if (/youtube\.com|youtu\.be|tiktok\.com|vimeo\.com/.test(h)) return "影片";
  return "網頁";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

function readMeta(html) {
  const meta = (prop) => {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    return m ? decodeEntities(m[1]) : "";
  };
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const clean = (x) => String(x || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
  let title = clean(meta("og:title") || (t ? decodeEntities(t[1]) : ""));
  let description = clean(meta("og:description") || meta("description"));
  // IG／Threads 的標題是「帳號 on Instagram: "整段貼文"」：標題只留帳號＋第一行，整段貼文放進描述
  const m = title.match(/^(.+?) (?:on|在) (Instagram|Threads)[:：]\s*["“]?([\s\S]*?)["”]?$/);
  if (m) {
    const caption = m[3].trim();
    title = (firstLine(caption) || m[1]) + "（" + m[1] + "）";
    if (caption.length > description.length) description = caption;
  } else if (title.includes("\n")) {
    if (!description) description = title;
    title = firstLine(title);
  }
  return { title, description };
}

function firstLine(s) {
  const line = String(s || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

// nodes: [{id, name, keywords: [..], parent: id|null}]
// 回傳 { best: [node...], paths: Map(id -> "a › b › c") }
// 規則：每個節點的分數 = 從根到它這條路徑上，有幾個節點的關鍵字出現在文字裡。
// 只考慮自己有命中的節點；分數最高者勝，同分取較深的；仍同分就全部列出讓使用者選。
function classify(nodes, haystack) {
  const text = String(haystack || "").toLowerCase();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hit = new Set(
    nodes
      .filter((n) => n.keywords.some((k) => k && text.includes(k.toLowerCase())))
      .map((n) => n.id)
  );
  const chain = (n) => {
    const out = [];
    const seen = new Set();
    for (let cur = n; cur && !seen.has(cur.id); cur = byId.get(cur.parent)) {
      seen.add(cur.id);
      out.unshift(cur);
    }
    return out;
  };
  const paths = new Map(nodes.map((n) => [n.id, chain(n).map((x) => x.name).join(SEP)]));
  let best = [];
  let bestScore = 0;
  let bestDepth = 0;
  for (const n of nodes) {
    if (!hit.has(n.id)) continue;
    const c = chain(n);
    const score = c.filter((x) => hit.has(x.id)).length;
    const depth = c.length;
    if (score > bestScore || (score === bestScore && depth > bestDepth)) {
      best = [n];
      bestScore = score;
      bestDepth = depth;
    } else if (score === bestScore && depth === bestDepth) {
      best.push(n);
    }
  }
  return { best, paths };
}

function chunks(s, size) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading(text) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function buildPage({ title, source, url, categoryId, description, text, ocr }) {
  const props = {
    "標題": { title: [{ text: { content: title.slice(0, 2000) } }] },
    "來源": { select: { name: source } },
    "狀態": { status: { name: "待整理" } },
  };
  if (url) props["原始連結"] = { url };
  if (categoryId) props["分類"] = { relation: [{ id: categoryId }] };

  const children = [];
  if (url) children.push({ object: "block", type: "bookmark", bookmark: { url } });
  if (description) children.push(paragraph(description.slice(0, 2000)));
  const extra = String(text || "").trim();
  if (extra && extra !== url) {
    children.push(heading("分享的文字"));
    chunks(extra, 2000).slice(0, 20).forEach((c) => children.push(paragraph(c)));
  }
  if (ocr) {
    children.push(heading("截圖文字"));
    chunks(ocr, 2000).slice(0, 40).forEach((c) => children.push(paragraph(c)));
  }
  return { parent: { database_id: CARD_DB }, properties: props, children };
}

// ================= Scriptable 執行部分 =================
async function notion(token, path, body) {
  const req = new Request("https://api.notion.com/v1/" + path);
  req.method = "POST";
  req.headers = {
    Authorization: "Bearer " + token,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
  req.body = JSON.stringify(body);
  const res = await req.loadJSON();
  const status = req.response && req.response.statusCode;
  if (status === 401) {
    Keychain.remove(TOKEN_KEY);
    throw new Error("Notion 金鑰無效，已清除。下次執行時請重新貼上金鑰。");
  }
  if (status === 404) {
    throw new Error("找不到 Notion 資料庫。請到「旅記收藏」頁面 ⋯ → 連接，選你的整合「旅遊收藏」。");
  }
  if (status && status >= 400) {
    throw new Error("Notion 回應錯誤 " + status + "：" + (res && res.message ? res.message : ""));
  }
  return res;
}

async function getToken() {
  if (Keychain.contains(TOKEN_KEY)) return Keychain.get(TOKEN_KEY);
  const a = new Alert();
  a.title = "第一次使用";
  a.message = "請貼上 Notion 整合「旅遊收藏」的金鑰（ntn_ 或 secret_ 開頭）。只會存在這支手機的鑰匙圈。";
  a.addSecureTextField("Notion 金鑰", "");
  a.addAction("儲存");
  a.addCancelAction("取消");
  if ((await a.presentAlert()) === -1) throw new Error("已取消");
  const t = a.textFieldValue(0).trim();
  if (!t) throw new Error("沒有輸入金鑰");
  Keychain.set(TOKEN_KEY, t);
  return t;
}

async function loadTree(token) {
  const nodes = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notion(token, `databases/${TREE_DB}/query`, body);
    for (const p of res.results || []) {
      const pr = p.properties || {};
      const name = ((pr["名稱"] && pr["名稱"].title) || []).map((t) => t.plain_text).join("");
      const kw = ((pr["關鍵字"] && pr["關鍵字"].rich_text) || []).map((t) => t.plain_text).join("");
      const rel = (pr["上層分類"] && pr["上層分類"].relation) || [];
      nodes.push({
        id: p.id,
        name: name || "（未命名）",
        keywords: [name, ...kw.split(/[,，、]/)].map((k) => k.trim()).filter(Boolean),
        parent: rel.length ? rel[0].id : null,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return nodes;
}

const LAST_KEY = "travelnotes.lastCategory";

// 一層一層點進去的分類選單。
// 起點：有唯一自動建議時，停在建議節點的上一層；否則停在上次選的分類的上一層；都沒有就從最上層開始。
async function chooseCategory(nodes, result, title) {
  const { best, paths } = result;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = (id) => nodes
    .filter((n) => n.parent === id || (!id && n.parent && !byId.has(n.parent)))
    .sort((x, y) => x.name.localeCompare(y.name, "zh-Hant"));
  const suggested = best.length === 1 ? best[0] : null;
  const lastId = Keychain.contains(LAST_KEY) ? Keychain.get(LAST_KEY) : null;
  const anchor = suggested || (lastId && byId.get(lastId)) || null;
  const mark = new Set(best.map((n) => n.id));
  if (lastId) mark.add(lastId);
  let cur = anchor ? byId.get(anchor.parent) || null : null;

  for (;;) {
    const children = kids(cur ? cur.id : null);
    const a = new Alert();
    a.title = cur ? paths.get(cur.id) : "選擇分類";
    a.message = title + (suggested ? "\n建議：" + paths.get(suggested.id) : "");
    const acts = [];
    if (cur) { a.addAction("✓ 存在「" + cur.name + "」"); acts.push({ save: cur }); }
    for (const n of children) {
      const more = kids(n.id).length > 0;
      const star = n === suggested ? "★ " : mark.has(n.id) ? "☆ " : "";
      a.addAction(star + n.name + (more ? "  ›" : ""));
      acts.push(more ? { go: n } : { save: n });
    }
    if (cur) { a.addAction("‹ 回上一層"); acts.push({ go: byId.get(cur.parent) || null, up: true }); }
    a.addAction("先不分類"); acts.push({ none: true });
    a.addCancelAction("取消");
    const i = await a.presentSheet();
    if (i === -1) throw new Error("已取消");
    const act = acts[i];
    if (act.none) return null;
    if (act.save) { Keychain.set(LAST_KEY, act.save.id); return act.save; }
    cur = act.go;
  }
}

async function main() {
  const p = args.shortcutParameter || {};
  const sharedText = [p.text, ...(args.plainTexts || [])].filter(Boolean).join("\n");
  const ocr = String(p.ocr || "").trim();
  const url = firstUrl(p.url) || firstUrl((args.urls || []).join(" ")) || firstUrl(sharedText);
  const source = guessSource(url, ocr);

  let meta = { title: "", description: "" };
  if (url) {
    try {
      const r = new Request(url);
      r.timeoutInterval = 10;
      r.headers = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" };
      meta = readMeta(await r.loadString());
    } catch (e) {
      // 抓不到（例如 IG 登入牆）就只存連結
    }
  }
  const title = meta.title || firstLine(sharedText.replace(url, "")) || firstLine(ocr) || url || "未命名收藏";

  const token = await getToken();
  const nodes = await loadTree(token);
  const haystack = [title, meta.description, sharedText, ocr, url].join("\n");
  const result = classify(nodes, haystack);
  const cat = await chooseCategory(nodes, result, title);

  await notion(token, "pages", buildPage({
    title, source, url,
    categoryId: cat ? cat.id : null,
    description: meta.description,
    text: sharedText, ocr,
  }));
  return `已存到旅記：${title}${cat ? "\n分類：" + result.paths.get(cat.id) : ""}`;
}

// Scriptable 每支腳本都有 module 物件，所以這裡不能用 module.exports 判斷環境，直接執行。
let msg;
try {
  msg = await main();
} catch (e) {
  msg = "沒有存成功：" + e.message;
}
Script.setShortcutOutput(msg);
if (config.runsInApp) {
  // 直接在 Scriptable 裡執行（測試用）時，把結果顯示出來
  const a = new Alert();
  a.title = "存到旅記";
  a.message = msg;
  a.addAction("好");
  await a.presentAlert();
}
Script.complete();
