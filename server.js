'use strict';

const express    = require('express');
const https      = require('https');
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
  search : 7  * 24 * 60 * 60 * 1000,  //  7日
  videos : 30 * 24 * 60 * 60 * 1000,  // 30日
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
