'use strict';

const express    = require('express');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const zlib       = require('zlib');
const crypto     = require('crypto');
const { promisify } = require('util');
const swaggerUi  = require('swagger-ui-express');
const YAML       = require('yamljs');
const { normalizeTabelogUrl, pickTabelogUrl } = require('./tabelog');

const gzipAsync = promisify(zlib.gzip);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Swagger UI
const swaggerDocument = YAML.load('./swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ─────────────────────────────────────────
//  共通ユーティリティ
// ─────────────────────────────────────────

/** 環境変数を0以上の数値として読む（未設定・不正ならデフォルト） */
function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function inc(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** 同じキーの処理が同時に走っている間は1回だけ実行し、結果を共有する（Google課金の重複防止） */
const inflight = new Map();
function dedupe(key, fn) {
  const running = inflight.get(key);
  if (running) return running;
  const promise = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** 一時ファイルに書いてからrenameする（読み込み側に書きかけを見せない） */
async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

// ─────────────────────────────────────────
//  インメモリキャッシュ
// ─────────────────────────────────────────
const CACHE_TTL_MS = {
  search             : 7  * 24 * 60 * 60 * 1000,  //  7日
  videos             : 30 * 24 * 60 * 60 * 1000,  // 30日
  placesNearby       : 7  * 24 * 60 * 60 * 1000,  //  7日（24時間→7日に延長）
  placesDetails      : 30 * 24 * 60 * 60 * 1000,  // 30日（7日→30日に延長）
  placesAutocomplete : 24 * 60 * 60 * 1000,        // 24時間
  tabelogSearch      : 90 * 24 * 60 * 60 * 1000,  // 90日（食べログURLは変わりにくい）
  tabelogNotFound    : 7  * 24 * 60 * 60 * 1000,  //  7日（見つからなかった店の再検索を抑える）
};

/** @type {Map<string, {data: any, expiresAt: number}>} */
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttlMs) {
  // 一度消してから入れ直し、Mapの挿入順を「最終更新が古い順」に保つ
  cache.delete(key);
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// メモリ使用量の上限（種類ごと）。超えたら最終更新が古いものから削除する
const CACHE_LIMITS = [
  { prefix: 'places:nearby:',       max: 3000  },
  { prefix: 'places:details:',      max: 20000 },
  { prefix: 'places:autocomplete:', max: 5000  },
  { prefix: 'tabelog:',             max: 20000 },
  { prefix: 'search:',              max: 3000  },
  { prefix: 'videos:',              max: 5000  },
];

// Googleの next_page_token → 1ページ目のキャッシュキー（2ページ目をキャッシュするための対応表）
const PAGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const pageTokens = new Map();

function rememberPageToken(token, key) {
  pageTokens.set(token, { key, expiresAt: Date.now() + PAGE_TOKEN_TTL_MS });
}

function cacheSweep() {
  const now = Date.now();
  const groups = new Map(CACHE_LIMITS.map(l => [l.prefix, []]));
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) {
      cache.delete(key);
      continue;
    }
    const limit = CACHE_LIMITS.find(l => key.startsWith(l.prefix));
    if (limit) groups.get(limit.prefix).push(key);
  }
  for (const limit of CACHE_LIMITS) {
    const keys = groups.get(limit.prefix);
    for (let i = 0; i < keys.length - limit.max; i++) cache.delete(keys[i]);
  }
  for (const [token, info] of pageTokens) {
    if (now > info.expiresAt) pageTokens.delete(token);
  }
  for (const [k, w] of ipWindows) {
    if (now - w.start > 2 * 60 * 1000) ipWindows.delete(k);
  }
}
setInterval(cacheSweep, 10 * 60 * 1000).unref();

// ─────────────────────────────────────────
//  Google課金ガード（1日の上限・IPごとの上限）
//  ※ キャッシュにヒットした場合は数えない。Googleへ実際に問い合わせる回数だけを制限する。
//  ※ 0を指定した制限は無効。環境変数で調整できる（Azureのアプリ設定）。
// ─────────────────────────────────────────
const DAILY_LIMIT = {
  nearby      : envInt('LIMIT_NEARBY_PER_DAY',       800),
  details     : envInt('LIMIT_DETAILS_PER_DAY',     2000),
  autocomplete: envInt('LIMIT_AUTOCOMPLETE_PER_DAY', 4000),
  photo       : envInt('LIMIT_PHOTO_PER_DAY',        4000),
};
const IP_LIMIT_PER_MIN = {
  nearby      : envInt('LIMIT_NEARBY_PER_IP_MIN',       20),
  details     : envInt('LIMIT_DETAILS_PER_IP_MIN',      30),
  autocomplete: envInt('LIMIT_AUTOCOMPLETE_PER_IP_MIN', 60),
  photo       : envInt('LIMIT_PHOTO_PER_IP_MIN',       120),
};

const stats = { startedAt: new Date().toISOString(), hit: {}, miss: {}, skip: {}, upstream: {}, blocked: {} };
const daily = { date: '', counts: {} };
const ipWindows = new Map();

/** 日本時間の日付（YYYY-MM-DD） */
function jstDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = (typeof xff === 'string' && xff.length)
    ? xff.split(',')[0].trim()
    : ((req.socket && req.socket.remoteAddress) || 'unknown');
  // Azure は "IPv4:ポート" 形式で付与することがある
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.split(':')[0];
  return ip;
}

/** Googleへ問い合わせてよいか判定し、許可する場合は回数を加算する */
function allowUpstream(kind, ip) {
  const today = jstDate();
  if (daily.date !== today) {
    daily.date = today;
    daily.counts = {};
  }
  const dailyMax = DAILY_LIMIT[kind];
  if (dailyMax && (daily.counts[kind] || 0) >= dailyMax) {
    inc(stats.blocked, `${kind}:daily`);
    return { ok: false, reason: 'daily_limit' };
  }
  const ipMax = IP_LIMIT_PER_MIN[kind];
  if (ipMax) {
    const k = `${ip}|${kind}`;
    const now = Date.now();
    let w = ipWindows.get(k);
    if (!w || now - w.start >= 60 * 1000) {
      w = { start: now, count: 0 };
      ipWindows.set(k, w);
    }
    if (w.count >= ipMax) {
      inc(stats.blocked, `${kind}:ip`);
      return { ok: false, reason: 'ip_limit' };
    }
    w.count++;
  }
  daily.counts[kind] = (daily.counts[kind] || 0) + 1;
  inc(stats.upstream, kind);
  console.log(`[upstream] ${kind} (today=${daily.counts[kind]})`);
  return { ok: true };
}

function sendLimited(res, reason) {
  return res
    .set('Retry-After', reason === 'ip_limit' ? '60' : '3600')
    .status(429)
    .json({ error: 'rate_limited', reason });
}

// ─────────────────────────────────────────
//  保存先（キャッシュ・写真）
//  優先順位: 環境変数 DATA_DIR → /home（書き込めるとき）→ $HOME
//  ・Azure App Service(Linux)で再起動・デプロイ後も残るのは /home だけ。
//    $HOME が別の場所を指していても、/home を明示的に使うようにする。
//  ・起動のたびに印（boot_info.json）を読み書きして、保存先が再起動後も残っているかを確認できるようにする
//    （起動ログ、ヘルスチェック `/` の storage、管理用 `/cache/stats` で確認）
// ─────────────────────────────────────────
function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return { dir: process.env.DATA_DIR, source: 'DATA_DIR' };
  if (isWritableDir('/home')) return { dir: '/home', source: '/home' };
  if (process.env.HOME) return { dir: process.env.HOME, source: 'HOME' };
  return { dir: '/home', source: 'fallback' };
}

const { dir: DATA_DIR, source: DATA_DIR_SOURCE } = resolveDataDir();
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

const storage = {
  dataDir: DATA_DIR,
  source: DATA_DIR_SOURCE,
  writable: false,
  bootCount: 1,
  restoredFromPreviousRun: false, // 前回起動時の印が残っていた＝保存先が再起動後も残っている
  firstBootAt: new Date().toISOString(),
  previousBootAt: null,
};

(function recordBoot() {
  const file = path.join(DATA_DIR, 'boot_info.json');
  try {
    if (fs.existsSync(file)) {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      storage.restoredFromPreviousRun = true;
      storage.bootCount = (Number(prev.count) || 0) + 1;
      storage.firstBootAt = prev.firstBootAt || storage.firstBootAt;
      storage.previousBootAt = prev.lastBootAt || null;
    }
    fs.writeFileSync(file, JSON.stringify({
      count: storage.bootCount,
      firstBootAt: storage.firstBootAt,
      lastBootAt: new Date().toISOString(),
    }));
    storage.writable = true;
  } catch (e) {
    storage.writable = false;
    storage.error = e.message;
  }
  console.log(`[storage] dataDir=${DATA_DIR} (source=${DATA_DIR_SOURCE}) writable=${storage.writable} `
    + `boot=#${storage.bootCount} restoredFromPreviousRun=${storage.restoredFromPreviousRun} previousBoot=${storage.previousBootAt}`
    + (storage.error ? ` error=${storage.error}` : ''));
})();

// ─────────────────────────────────────────
//  写真キャッシュ設定
// ─────────────────────────────────────────
const PHOTO_CACHE_DIR    = path.join(DATA_DIR, 'photo_cache');
const PHOTO_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日
const PHOTO_CACHE_CONTROL = 'public, max-age=2592000'; // 端末側でも30日キャッシュさせる

try { fs.mkdirSync(PHOTO_CACHE_DIR, { recursive: true }); } catch (_) {}

// ─────────────────────────────────────────
//  Google Places API ヘルパー
// ─────────────────────────────────────────
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// HTTPSリクエストでリダイレクトを1段階追跡してバッファを返す
function fetchWithRedirect(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const location = res.headers['location'];
        if (!location) return reject(new Error('redirect with no location header'));
        res.resume();
        return resolve(fetchWithRedirect(location, depth + 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode   : res.statusCode,
        contentType  : res.headers['content-type'] || 'image/jpeg',
        data         : Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

function placesFetch(path) {
  return new Promise((resolve, reject) => {
    const url = PLACES_BASE + path + '&key=' + encodeURIComponent(process.env.GOOGLE_PLACES_API_KEY || '');
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────
//  YouTube API ヘルパー
// ─────────────────────────────────────────
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube API を GET で呼び出し JSON を返す
 * @param {string} path  例: '/search?part=snippet&...'
 * @returns {Promise<{status: number, body: any}>}
 */
function ytFetch(path) {
  return new Promise((resolve, reject) => {
    const url = YT_BASE + path + '&key=' + encodeURIComponent(process.env.YOUTUBE_API_KEY || '');
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────
//  SerpAPI ヘルパー
// ─────────────────────────────────────────
const SERP_API_BASE = 'https://serpapi.com/search.json';
// SerpAPIが応答しない場合にリクエストがハングし続けないための上限
const SERP_API_TIMEOUT_MS = 25000;

function serpApiFetch(query) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.SERP_API_KEY || '';
    const qs     = new URLSearchParams({
      api_key : apiKey,
      engine  : 'google',
      q       : query,
      num     : '10',
      hl      : 'ja',
      gl      : 'jp',
    }).toString();
    const url = `${SERP_API_BASE}?${qs}`;
    https.get(url, { signal: AbortSignal.timeout(SERP_API_TIMEOUT_MS) }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, body: {} });
        }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────
//  キャッシュ永続化（/home に保存。Azure App Service の /home は再起動後も消えない）
//  ・変更があったときだけ、一定時間おきにまとめて非同期で書き出す
//  ・SIGTERM（停止・再起動）時は同期で書き出してから終了する
//  ・details / tabelog は従来のファイル名・形式のまま（既存データをそのまま読み込める）
// ─────────────────────────────────────────
const PERSIST_TARGETS = [
  { prefix: 'places:details:', file: path.join(DATA_DIR, 'details_cache.json'),   gzip: false, max: 20000, delayMs: envInt('PERSIST_DELAY_SMALL_MS', 15 * 1000) },
  { prefix: 'tabelog:',        file: path.join(DATA_DIR, 'tabelog_cache.json'),    gzip: false, max: 20000, delayMs: envInt('PERSIST_DELAY_SMALL_MS', 15 * 1000) },
  // 周辺検索は1件が大きいため gzip 圧縮し、書き出し間隔も長めにする
  { prefix: 'places:nearby:',  file: path.join(DATA_DIR, 'nearby_cache.json.gz'),  gzip: true,  max: 3000,  delayMs: envInt('PERSIST_DELAY_NEARBY_MS', 3 * 60 * 1000) },
];

function loadPersistedCaches() {
  const now = Date.now();
  for (const t of PERSIST_TARGETS) {
    try {
      if (!fs.existsSync(t.file)) continue;
      let buf = fs.readFileSync(t.file);
      if (t.gzip) buf = zlib.gunzipSync(buf);
      const entries = JSON.parse(buf.toString('utf8'));
      let loaded = 0;
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.expiresAt > now) {
          cache.set(key, entry);
          loaded++;
        }
      }
      console.log(`cache restored: ${loaded} entries (${t.prefix}) from ${path.basename(t.file)}`);
    } catch (e) {
      console.error(`cache load error (${t.prefix}):`, e.message);
    }
  }
}

function snapshotFor(target) {
  const entries = [];
  for (const [key, val] of cache) {
    if (key.startsWith(target.prefix)) entries.push([key, val]);
  }
  return JSON.stringify(Object.fromEntries(entries.slice(-target.max)));
}

const persistTimers = new Map();

function schedulePersist(prefix) {
  if (persistTimers.has(prefix)) return;
  const target = PERSIST_TARGETS.find(t => t.prefix === prefix);
  if (!target) return;
  const timer = setTimeout(async () => {
    persistTimers.delete(prefix);
    try {
      let buf = Buffer.from(snapshotFor(target), 'utf8');
      if (target.gzip) buf = await gzipAsync(buf);
      await writeFileAtomic(target.file, buf);
    } catch (e) {
      console.error(`cache save error (${prefix}):`, e.message);
    }
  }, target.delayMs);
  timer.unref();
  persistTimers.set(prefix, timer);
}

function flushPersistSync() {
  for (const target of PERSIST_TARGETS) {
    try {
      let buf = Buffer.from(snapshotFor(target), 'utf8');
      if (target.gzip) buf = zlib.gzipSync(buf);
      fs.writeFileSync(target.file, buf);
    } catch (e) {
      console.error(`cache flush error (${target.prefix}):`, e.message);
    }
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushPersistSync();
    process.exit(0);
  });
}

loadPersistedCaches();

// ─────────────────────────────────────────
//  ルート
// ─────────────────────────────────────────

// ヘルスチェック
app.get('/', (_req, res) => {
  res.json({
    status  : 'ok',
    message : 'ramen-api-server is running',
    cache   : `${cache.size} entries`,
    // 保存先が再起動後も残っているかの確認用（パスは出さない）。
    // 再起動して bootCount が増え、restoredFromPreviousRun が true なら保存先は残っている
    storage : {
      writable                : storage.writable,
      bootCount               : storage.bootCount,
      restoredFromPreviousRun : storage.restoredFromPreviousRun,
    },
  });
});

/**
 * YouTube search プロキシ（キャッシュ付き）
 *
 * GET /youtube/search?q=SUSURU+TV+一蘭&maxResults=5&order=relevance&type=video
 *
 * クエリパラメータをそのまま YouTube search.list に転送する。
 * APIキーはサーバー環境変数から付与するのでクライアントから渡す必要なし。
 */
app.get('/youtube/search', async (req, res) => {
  const params = { ...req.query };
  delete params.key; // クライアントからのキーは無視

  if (!params.q) {
    return res.status(400).json({ error: 'q is required' });
  }

  // パラメータをアルファベット順で並べてキャッシュキーを安定させる
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const cacheKey = `search:${sorted}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.set('X-Cache', 'HIT').json(cached);
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'YOUTUBE_API_KEY is not configured on server' });
  }

  const qs = new URLSearchParams({ ...params, part: params.part || 'snippet' }).toString();
  try {
    const { status, body } = await ytFetch(`/search?${qs}`);
    if (status === 200 && !body.error) {
      cacheSet(cacheKey, body, CACHE_TTL_MS.search);
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * YouTube videos プロキシ（キャッシュ付き）
 *
 * GET /youtube/videos?id=ABC123,DEF456&part=snippet,contentDetails
 */
app.get('/youtube/videos', async (req, res) => {
  const params = { ...req.query };
  delete params.key;

  if (!params.id) {
    return res.status(400).json({ error: 'id is required' });
  }

  // id リストをソートしてキャッシュキーを安定させる
  const ids = params.id.split(',').map(s => s.trim()).filter(Boolean).sort().join(',');
  const cacheKey = `videos:${ids}:${params.part || 'snippet'}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.set('X-Cache', 'HIT').json(cached);
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'YOUTUBE_API_KEY is not configured on server' });
  }

  const qs = new URLSearchParams({ ...params, id: ids }).toString();
  try {
    const { status, body } = await ytFetch(`/videos?${qs}`);
    if (status === 200 && !body.error) {
      cacheSet(cacheKey, body, CACHE_TTL_MS.videos);
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
//  Places API ルート
// ─────────────────────────────────────────

const EMPTY_NEARBY = { status: 'ZERO_RESULTS', results: [], html_attributions: [] };
const EMPTY_AUTOCOMPLETE = { status: 'ZERO_RESULTS', predictions: [] };

// 日本国内の座標だけ検索する（世界中の座標を叩かれて課金されるのを防ぐ。ALLOW_OUTSIDE_JAPAN=1 で無効化）
const ALLOW_OUTSIDE_JAPAN = process.env.ALLOW_OUTSIDE_JAPAN === '1';

function parseLocation(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function isInJapan({ lat, lng }) {
  return lat >= 20 && lat <= 46.5 && lng >= 122 && lng <= 154.5;
}

// 検索半径を250m刻み（切り上げ）にそろえる。
// アプリは画面サイズから半径を1m単位で算出するため、そのままだとキャッシュキーがほぼ一致しない。
const NEARBY_RADIUS_STEP = 250;
function bucketRadius(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1500;
  return Math.min(50000, Math.max(NEARBY_RADIUS_STEP, Math.ceil(n / NEARBY_RADIUS_STEP) * NEARBY_RADIUS_STEP));
}

// サーバーが発行する2ページ目用トークン（Googleのトークンは短時間で失効するため、キャッシュ済みの2ページ目を引くための印）
const SRV_TOKEN_PREFIX = 'srv:';
function encodeSrvToken(key) {
  return SRV_TOKEN_PREFIX + Buffer.from(key, 'utf8').toString('base64url');
}
function decodeSrvToken(token) {
  try {
    const key = Buffer.from(token.slice(SRV_TOKEN_PREFIX.length), 'base64url').toString('utf8');
    return key.startsWith('places:nearby:') ? key : null;
  } catch (_) {
    return null;
  }
}

/** キャッシュ済みの1ページ目を返す。2ページ目がキャッシュ済みなら、それを引ける印を付ける */
function withNextPageToken(cachedBody, cacheKey) {
  const out = { ...cachedBody };
  delete out.next_page_token;
  if (cacheGet(`${cacheKey}:p2`) !== null) {
    out.next_page_token = encodeSrvToken(cacheKey);
  }
  return out;
}

/** 2ページ目（pagetoken）の取得 */
async function handleNearbyNextPage(req, res, token) {
  // サーバー発行トークン: キャッシュ済みの2ページ目を返す（Googleは呼ばない）
  if (token.startsWith(SRV_TOKEN_PREFIX)) {
    const baseKey = decodeSrvToken(token);
    const p2 = baseKey ? cacheGet(`${baseKey}:p2`) : null;
    if (p2) {
      inc(stats.hit, 'nearby:p2');
      return res.set('X-Cache', 'HIT').json(p2);
    }
    return res.set('X-Cache', 'SKIP').json(EMPTY_NEARBY);
  }

  // Googleのトークン: 同じ1ページ目から取得済みの2ページ目があればそれを返す
  const known = pageTokens.get(token);
  const baseKey = known && Date.now() <= known.expiresAt ? known.key : null;
  if (baseKey) {
    const p2 = cacheGet(`${baseKey}:p2`);
    if (p2) {
      inc(stats.hit, 'nearby:p2');
      return res.set('X-Cache', 'HIT').json(p2);
    }
  }

  inc(stats.miss, 'nearby:p2');
  const ip = clientIp(req);
  try {
    const result = await dedupe(`nearby:p2:${token}`, async () => {
      const gate = allowUpstream('nearby', ip);
      if (!gate.ok) return { blocked: gate.reason };
      return placesFetch(`/nearbysearch/json?${new URLSearchParams({ pagetoken: token }).toString()}`);
    });
    if (result.blocked) return sendLimited(res, result.blocked);

    const { status, body } = result;
    if (baseKey && status === 200 && body.status === 'OK') {
      const p2Body = { ...body };
      delete p2Body.next_page_token; // 次回以降は使えないトークンなので保存しない
      cacheSet(`${baseKey}:p2`, p2Body, CACHE_TTL_MS.placesNearby);
      schedulePersist('places:nearby:');
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * 周辺ラーメン店検索（7日キャッシュ）
 * GET /places/nearbysearch?location=35.7,139.7&radius=1500&keyword=ラーメン&language=ja
 */
app.get('/places/nearbysearch', async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  // 許可したパラメータだけをGoogleへ渡す（クライアントからのkey等は無視）
  const params = pick(req.query, ['location', 'radius', 'keyword', 'language', 'type', 'pagetoken']);

  // 2ページ目以降は使い捨てトークンで取得する
  if (params.pagetoken) return handleNearbyNextPage(req, res, String(params.pagetoken));

  // アプリ起動時のウォームアップ（radius=1）はGoogleを呼ばずに即返す
  const rawRadius = Number(params.radius);
  if (Number.isFinite(rawRadius) && rawRadius <= 1) {
    inc(stats.skip, 'nearby:warmup');
    return res.set('X-Cache', 'SKIP').json(EMPTY_NEARBY);
  }

  const loc = parseLocation(params.location);
  if (!loc) return res.status(400).json({ error: 'location is required (lat,lng)' });
  if (!ALLOW_OUTSIDE_JAPAN && !isInJapan(loc)) {
    inc(stats.skip, 'nearby:outside_japan');
    return res.set('X-Cache', 'SKIP').json(EMPTY_NEARBY);
  }

  // 半径を丸め、キャッシュと同じ条件でGoogleに問い合わせる
  const radius = bucketRadius(params.radius);
  params.radius = String(radius);

  // lat/lng をタイル単位（約890m）でグループ化してキャッシュ
  const latTile = Math.floor(loc.lat / 0.008);
  const lngTile = Math.floor(loc.lng / 0.008);
  const cacheKey = `places:nearby:${latTile}_${lngTile}:${radius}:${params.keyword || ''}:${params.language || ''}:${params.type || ''}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    inc(stats.hit, 'nearby');
    return res.set('X-Cache', 'HIT').json(withNextPageToken(cached, cacheKey));
  }

  inc(stats.miss, 'nearby');
  const ip = clientIp(req);
  const qs = new URLSearchParams(params).toString();
  try {
    const result = await dedupe(cacheKey, async () => {
      const gate = allowUpstream('nearby', ip);
      if (!gate.ok) return { blocked: gate.reason };
      return placesFetch(`/nearbysearch/json?${qs}`);
    });
    if (result.blocked) return sendLimited(res, result.blocked);

    const { status, body } = result;
    if (status === 200 && (body.status === 'OK' || body.status === 'ZERO_RESULTS')) {
      const cachedBody = { ...body };
      delete cachedBody.next_page_token; // トークンは短時間で失効するため保存しない
      cacheSet(cacheKey, cachedBody, CACHE_TTL_MS.placesNearby);
      if (body.next_page_token) rememberPageToken(body.next_page_token, cacheKey);
      schedulePersist('places:nearby:');
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 店舗詳細は安価な基本項目（Basic Data）に統一する。
// 基本項目はいくつ取っても課金は同じなので、1店舗1回の問い合わせ・1キャッシュに集約する。
// それ以外のフィールド（rating / opening_hours など課金の高いもの）の要求は無視する。
const STANDARD_DETAIL_FIELDS = 'place_id,name,formatted_address,photos,geometry';

/**
 * 店舗詳細取得（30日キャッシュ）
 * GET /places/details?place_id=XXX&fields=place_id,name,...&language=ja
 */
app.get('/places/details', async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  const placeId = typeof req.query.place_id === 'string' ? req.query.place_id : '';
  if (!placeId) return res.status(400).json({ error: 'place_id is required' });
  if (!/^[A-Za-z0-9_-]{10,400}$/.test(placeId)) return res.status(400).json({ error: 'place_id is invalid' });

  const language = typeof req.query.language === 'string' && /^[A-Za-z-]{2,10}$/.test(req.query.language)
    ? req.query.language
    : 'ja';

  // 既存のキャッシュ（standardフィールド・日本語）とキーの形式を合わせて、永続化済みデータをそのまま使う
  const cacheKey = language === 'ja'
    ? `places:details:${placeId}:${STANDARD_DETAIL_FIELDS}`
    : `places:details:${placeId}:${STANDARD_DETAIL_FIELDS}:${language}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    inc(stats.hit, 'details');
    return res.set('X-Cache', 'HIT').json(cached);
  }

  inc(stats.miss, 'details');
  const ip = clientIp(req);
  const qs = new URLSearchParams({ place_id: placeId, fields: STANDARD_DETAIL_FIELDS, language }).toString();
  try {
    const result = await dedupe(cacheKey, async () => {
      const gate = allowUpstream('details', ip);
      if (!gate.ok) return { blocked: gate.reason };
      return placesFetch(`/details/json?${qs}`);
    });
    if (result.blocked) return sendLimited(res, result.blocked);

    const { status, body } = result;
    if (status === 200 && body.status === 'OK') {
      cacheSet(cacheKey, body, CACHE_TTL_MS.placesDetails);
      schedulePersist('places:details:');
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// オートコンプリートは候補の取りこぼしを避けるため、短すぎる入力（アプリが付ける「ラーメン」を除いて2文字未満）はGoogleを呼ばない
const AUTOCOMPLETE_MIN_CHARS = envInt('AUTOCOMPLETE_MIN_CHARS', 2);

/**
 * 店舗名オートコンプリート（24時間キャッシュ）
 * GET /places/autocomplete?input=一蘭&language=ja
 */
app.get('/places/autocomplete', async (req, res) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  const params = pick(req.query, ['input', 'types', 'components', 'language', 'sessiontoken']);

  if (typeof params.input !== 'string' || !params.input) return res.status(400).json({ error: 'input is required' });

  const core = params.input.replace(/\s*ラーメン\s*$/u, '').trim();
  if ([...core].length < AUTOCOMPLETE_MIN_CHARS) {
    inc(stats.skip, 'autocomplete:short');
    return res.set('X-Cache', 'SKIP').json(EMPTY_AUTOCOMPLETE);
  }

  // 全角/半角・大文字小文字・空白の違いは同じ入力として扱う
  const normalized = params.input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const cacheKey = `places:autocomplete:${normalized}:${params.language || 'ja'}:${params.types || ''}:${params.components || ''}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    inc(stats.hit, 'autocomplete');
    return res.set('X-Cache', 'HIT').json(cached);
  }

  inc(stats.miss, 'autocomplete');
  const ip = clientIp(req);
  const qs = new URLSearchParams(params).toString();
  try {
    const result = await dedupe(cacheKey, async () => {
      const gate = allowUpstream('autocomplete', ip);
      if (!gate.ok) return { blocked: gate.reason };
      return placesFetch(`/autocomplete/json?${qs}`);
    });
    if (result.blocked) return sendLimited(res, result.blocked);

    const { status, body } = result;
    if (status === 200 && (body.status === 'OK' || body.status === 'ZERO_RESULTS')) {
      cacheSet(cacheKey, body, CACHE_TTL_MS.placesAutocomplete);
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 写真の幅は決まった段階にそろえる（幅違いのリクエストごとに課金されるのを防ぐ）
const PHOTO_WIDTHS = [100, 200, 400, 800, 1600];
function normalizePhotoWidth(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 400;
  return PHOTO_WIDTHS.find(w => n <= w) || 1600;
}

/**
 * 店舗写真（ファイルキャッシュ付き・90日TTL）
 * GET /places/photo?photo_reference=XXX&maxwidth=400
 *
 * キャッシュHIT: /home/photo_cache/ からファイルを直接返す
 * キャッシュMISS: Google Places Photo APIから取得しファイル保存後に返す
 */
app.get('/places/photo', async (req, res) => {
  const photo_reference = typeof req.query.photo_reference === 'string' ? req.query.photo_reference : '';
  if (!photo_reference) return res.status(400).json({ error: 'photo_reference is required' });
  if (photo_reference.length < 20 || photo_reference.length > 2000) {
    return res.status(400).json({ error: 'photo_reference is invalid' });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  // ファイル名: photo_reference の記号をアンダースコアに変換して安全なパスにする
  const mw       = String(normalizePhotoWidth(req.query.maxwidth));
  const safeRef  = photo_reference.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cacheFile = path.join(PHOTO_CACHE_DIR, `${safeRef}_${mw}`);

  // キャッシュHIT確認（ファイルのmtimeで90日TTLを判定）
  try {
    const stat = await fs.promises.stat(cacheFile);
    if (Date.now() - stat.mtimeMs < PHOTO_CACHE_TTL_MS) {
      const data = await fs.promises.readFile(cacheFile);
      inc(stats.hit, 'photo');
      return res.set('X-Cache', 'HIT').set('Content-Type', 'image/jpeg').set('Cache-Control', PHOTO_CACHE_CONTROL).send(data);
    }
  } catch (_) { /* キャッシュなし */ }

  inc(stats.miss, 'photo');
  const ip = clientIp(req);

  // キャッシュMISS: Googleから取得（リダイレクト追跡）。同じ写真を同時に何件要求されても取得は1回だけ
  const googleUrl = `${PLACES_BASE}/photo?photo_reference=${encodeURIComponent(photo_reference)}&maxwidth=${mw}&key=${apiKey}`;
  try {
    const result = await dedupe(`photo:${cacheFile}`, async () => {
      const gate = allowUpstream('photo', ip);
      if (!gate.ok) return { blocked: gate.reason };
      const fetched = await fetchWithRedirect(googleUrl);
      if (fetched.statusCode === 200 && fetched.data.length > 0) {
        try { await writeFileAtomic(cacheFile, fetched.data); } catch (_) { /* ディスク書き込み失敗は無視 */ }
      }
      return fetched;
    });
    if (result.blocked) return sendLimited(res, result.blocked);

    const { statusCode, contentType, data } = result;
    if (statusCode === 200 && data.length > 0) {
      return res.set('X-Cache', 'MISS').set('Content-Type', contentType).set('Cache-Control', PHOTO_CACHE_CONTROL).send(data);
    }
    return res.status(statusCode).send(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
//  食べログ検索ルート
// ─────────────────────────────────────────

/**
 * 食べログURL検索（90日キャッシュ・全ユーザー共有）
 *
 * GET /tabelog/search?place_id=XXX&name=一蘭&address=福岡県福岡市
 *
 * レスポンス: { url: "https://tabelog.com/..." } or { url: null }
 */
app.get('/tabelog/search', async (req, res) => {
  const { place_id, name, address } = req.query;

  if (!place_id && !name) {
    return res.status(400).json({ error: 'place_id or name is required' });
  }

  const apiKey = process.env.SERP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'SERP_API_KEY is not configured on server' });
  }

  // place_id をキャッシュキーに使うことで全ユーザー共有・API消費を最小化
  const cacheKey = `tabelog:${place_id || name}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    // 過去に口コミページ等のURLが保存されていても、店舗トップURLに正規化して返す
    return res.set('X-Cache', 'HIT').json({ url: normalizeTabelogUrl(cached.url) });
  }

  // "site:tabelog.com 店名 住所" で検索
  const query = `site:tabelog.com ${name || ''}${address ? ' ' + address : ''}`.trim();

  try {
    const { status, body } = await serpApiFetch(query);

    // 429: SerpAPI月間クォータ超過 → クライアントにそのまま返してリトライ抑制
    if (status === 429) {
      return res.status(429).set('X-Cache', 'MISS').json({ error: 'quota_exceeded' });
    }

    // 検索結果ゼロはエラー文言付きの200で返るため、エラーではなく「見つからなかった」として扱う
    const noResults = status === 200 && typeof body.error === 'string'
      && /hasn't returned any results/i.test(body.error);
    if (!noResults && (status !== 200 || body.error)) {
      return res.status(status).set('X-Cache', 'MISS').json({ url: null });
    }

    const tabelogUrl = pickTabelogUrl(body.organic_results, name);

    const result = { url: tabelogUrl };
    // 見つかった場合は90日、見つからなかった場合は7日キャッシュし、ファイルに永続化
    const ttl = tabelogUrl ? CACHE_TTL_MS.tabelogSearch : CACHE_TTL_MS.tabelogNotFound;
    cacheSet(cacheKey, result, ttl);
    schedulePersist('tabelog:');

    return res.set('X-Cache', 'MISS').json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// キャッシュ・課金ガードの状況確認（管理用）
// ADMIN_TOKEN を設定し、ヘッダー x-admin-token（または ?token=）で渡した場合のみキー一覧まで返す。
// 未設定・不一致のときは件数のみ。
function isAdmin(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const given = String(req.get('x-admin-token') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/cache/stats', (req, res) => {
  if (!isAdmin(req)) return res.json({ count: cache.size });

  const now = Date.now();
  const entries = [];
  for (const [key, val] of cache.entries()) {
    entries.push({
      key,
      expiresIn: Math.round((val.expiresAt - now) / 1000) + 's',
    });
  }
  res.json({
    count: cache.size,
    stats,
    today: { date: daily.date, upstream: daily.counts, limits: DAILY_LIMIT },
    storage,
    entries,
  });
});

// ─────────────────────────────────────────
//  起動
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ramen-api-server listening on port ${PORT}`);
});
