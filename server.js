'use strict';

const express    = require('express');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const swaggerUi  = require('swagger-ui-express');
const YAML       = require('yamljs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Swagger UI
const swaggerDocument = YAML.load('./swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ─────────────────────────────────────────
//  インメモリキャッシュ
// ─────────────────────────────────────────
const CACHE_TTL_MS = {
  search             : 7  * 24 * 60 * 60 * 1000,  //  7日
  videos             : 30 * 24 * 60 * 60 * 1000,  // 30日
  placesNearby       : 24 * 60 * 60 * 1000,        // 24時間
  placesDetails      : 7  * 24 * 60 * 60 * 1000,  //  7日
  placesAutocomplete : 24 * 60 * 60 * 1000,        // 24時間
  tabelogSearch      : 90 * 24 * 60 * 60 * 1000,  // 90日（食べログURLは変わりにくい）
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
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ─────────────────────────────────────────
//  Google Places API ヘルパー
// ─────────────────────────────────────────
const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

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

function serpApiFetch(query) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.SERP_API_KEY || '';
    const qs     = new URLSearchParams({
      api_key : apiKey,
      engine  : 'google',
      q       : query,
      num     : '1',
      hl      : 'ja',
      gl      : 'jp',
    }).toString();
    const url = `${SERP_API_BASE}?${qs}`;
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
//  ルート
// ─────────────────────────────────────────

// ヘルスチェック
app.get('/', (_req, res) => {
  res.json({
    status  : 'ok',
    message : 'ramen-api-server is running',
    cache   : `${cache.size} entries`,
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

/**
 * 周辺ラーメン店検索（24時間キャッシュ）
 * GET /places/nearbysearch?location=35.7,139.7&radius=1500&keyword=ラーメン&language=ja
 */
app.get('/places/nearbysearch', async (req, res) => {
  const params = { ...req.query };
  delete params.key;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  let cacheKey = null;
  if (!params.pagetoken && params.location) {
    // lat/lng をタイル単位（約890m）でグループ化してキャッシュ
    const [lat, lng] = params.location.split(',').map(Number);
    const latTile = Math.floor(lat / 0.008);
    const lngTile = Math.floor(lng / 0.008);
    cacheKey = `places:nearby:${latTile}_${lngTile}:${params.radius || '1500'}`;
  }
  // pagetoken は使い捨てなのでキャッシュしない

  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return res.set('X-Cache', 'HIT').json(cached);
  }

  const qs = new URLSearchParams(params).toString();
  try {
    const { status, body } = await placesFetch(`/nearbysearch/json?${qs}`);
    if (cacheKey && status === 200 && (body.status === 'OK' || body.status === 'ZERO_RESULTS')) {
      cacheSet(cacheKey, body, CACHE_TTL_MS.placesNearby);
    }
    return res.status(status).set('X-Cache', cacheKey ? 'MISS' : 'SKIP').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 店舗詳細取得（7日キャッシュ）
 * GET /places/details?place_id=XXX&fields=place_id,name,...&language=ja
 */
app.get('/places/details', async (req, res) => {
  const params = { ...req.query };
  delete params.key;

  if (!params.place_id) return res.status(400).json({ error: 'place_id is required' });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  const cacheKey = `places:details:${params.place_id}:${params.fields || 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.set('X-Cache', 'HIT').json(cached);

  const qs = new URLSearchParams(params).toString();
  try {
    const { status, body } = await placesFetch(`/details/json?${qs}`);
    if (status === 200 && body.status === 'OK') {
      cacheSet(cacheKey, body, CACHE_TTL_MS.placesDetails);
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 店舗名オートコンプリート（24時間キャッシュ）
 * GET /places/autocomplete?input=一蘭&language=ja
 */
app.get('/places/autocomplete', async (req, res) => {
  const params = { ...req.query };
  delete params.key;

  if (!params.input) return res.status(400).json({ error: 'input is required' });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  const cacheKey = `places:autocomplete:${params.input}:${params.language || 'ja'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.set('X-Cache', 'HIT').json(cached);

  const qs = new URLSearchParams(params).toString();
  try {
    const { status, body } = await placesFetch(`/autocomplete/json?${qs}`);
    if (status === 200 && (body.status === 'OK' || body.status === 'ZERO_RESULTS')) {
      cacheSet(cacheKey, body, CACHE_TTL_MS.placesAutocomplete);
    }
    return res.status(status).set('X-Cache', 'MISS').json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 店舗写真（APIキーを隠してリダイレクト）
 * GET /places/photo?photo_reference=XXX&maxwidth=400
 */
app.get('/places/photo', (req, res) => {
  const { photo_reference, maxwidth } = req.query;
  if (!photo_reference) return res.status(400).json({ error: 'photo_reference is required' });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not configured on server' });

  const redirectUrl = `${PLACES_BASE}/photo?photo_reference=${photo_reference}&maxwidth=${maxwidth || 400}&key=${apiKey}`;
  res.redirect(redirectUrl);
});

// ─────────────────────────────────────────
//  食べログキャッシュ永続化（/home に保存）
// ─────────────────────────────────────────

// Azure App Service の /home は再起動後も消えない永続ストレージ
const TABELOG_CACHE_FILE = path.join(process.env.HOME || '/home', 'tabelog_cache.json');

// 起動時にファイルからキャッシュを復元
function loadTabelogCacheFromFile() {
  try {
    if (!fs.existsSync(TABELOG_CACHE_FILE)) return;
    const raw = fs.readFileSync(TABELOG_CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.expiresAt > now) {
        cache.set(key, entry);
        loaded++;
      }
    }
    console.log(`tabelog cache restored: ${loaded} entries from file`);
  } catch (e) {
    console.error('tabelog cache load error:', e.message);
  }
}

// 食べログキャッシュのみファイルに書き出す
function saveTabelogCacheToFile() {
  try {
    const tabelogEntries = {};
    for (const [key, val] of cache.entries()) {
      if (key.startsWith('tabelog:')) {
        tabelogEntries[key] = val;
      }
    }
    fs.writeFileSync(TABELOG_CACHE_FILE, JSON.stringify(tabelogEntries), 'utf8');
  } catch (e) {
    console.error('tabelog cache save error:', e.message);
  }
}

loadTabelogCacheFromFile();

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
    return res.set('X-Cache', 'HIT').json(cached);
  }

  // "site:tabelog.com 店名 住所" で検索
  const query = `site:tabelog.com ${name || ''}${address ? ' ' + address : ''}`.trim();

  try {
    const { status, body } = await serpApiFetch(query);

    // 429: SerpAPI月間クォータ超過 → クライアントにそのまま返してリトライ抑制
    if (status === 429) {
      return res.status(429).set('X-Cache', 'MISS').json({ error: 'quota_exceeded' });
    }

    if (status !== 200 || body.error) {
      return res.status(status).set('X-Cache', 'MISS').json({ url: null });
    }

    const results = body.organic_results || [];
    // tabelog.com/[都道府県]/A[エリア]/A[サブエリア]/[店舗ID]/ の形式のURLを優先
    const tabelogUrl = results
      .map(item => item.link)
      .find(link => /tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//.test(link)) || null;

    const result = { url: tabelogUrl };
    // URLが見つかった場合のみキャッシュしてファイルに永続化
    if (tabelogUrl) {
      cacheSet(cacheKey, result, CACHE_TTL_MS.tabelogSearch);
      saveTabelogCacheToFile();
    }

    return res.set('X-Cache', 'MISS').json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// キャッシュ状況確認（管理用）
app.get('/cache/stats', (_req, res) => {
  const now = Date.now();
  const entries = [];
  for (const [key, val] of cache.entries()) {
    entries.push({
      key,
      expiresIn: Math.round((val.expiresAt - now) / 1000) + 's',
    });
  }
  res.json({ count: cache.size, entries });
});

// ─────────────────────────────────────────
//  起動
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ramen-api-server listening on port ${PORT}`);
});
