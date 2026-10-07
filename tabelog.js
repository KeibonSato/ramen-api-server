'use strict';

// 食べログの店舗トップURL（都道府県/エリア/サブエリア/店舗ID まで）。s.tabelog.com 等のサブドメインも許容
const SHOP_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)?tabelog\.com\/[a-z]+\/A\d+\/A\d+\/\d+\//;

// 口コミ・写真などの子ページURLを店舗トップURLに正規化する（食べログの店舗URLでなければそのまま返す）
function normalizeTabelogUrl(url) {
  if (!url) return url;
  const m = SHOP_URL_PATTERN.exec(url);
  return m ? m[0] : url;
}

// 店名の表記ゆれ対策（全角半角の統一・空白除去・小文字化）
function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

// 検索結果から店舗トップURLを選ぶ。タイトルに店名を含む候補を優先し、無ければ最上位の店舗ページを返す
function pickTabelogUrl(results, name) {
  const candidates = (results || []).filter(
    item => item && typeof item.link === 'string' && SHOP_URL_PATTERN.test(item.link)
  );
  if (candidates.length === 0) return null;

  const target = normalizeName(name);
  const matched = target && candidates.find(item => normalizeName(item.title).includes(target));
  return normalizeTabelogUrl((matched || candidates[0]).link);
}

module.exports = { normalizeTabelogUrl, pickTabelogUrl };
