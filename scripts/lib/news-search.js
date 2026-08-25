// Lightweight news discovery for CI: Google News RSS (+ Bing / GDELT fallbacks).
// Used by fetch-news.js so the Cursor CLI agent does not need its built-in
// web_search tool (often blocked in headless GitHub Actions runs).
const DEFAULT_UA =
  'Mozilla/5.0 (compatible; FerrariResearchBot/1.0; +https://github.com/Moynihan18/ferrari-research)';

function decodeXmlEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function parseRssItems(xml, limit = 8) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = tagText(block, 'title');
    const link = tagText(block, 'link');
    const pubDate = tagText(block, 'pubDate');
    const source = tagText(block, 'source') || 'News RSS';
    const description = tagText(block, 'description')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    let date = null;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!Number.isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
    }
    items.push({
      title,
      url: link || null,
      source,
      date,
      snippet: description.slice(0, 400),
    });
  }
  return items;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/rss+xml, application/xml, text/xml, application/json, */*',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function searchGoogleNews(query, limit) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return parseRssItems(await fetchText(url), limit);
}

async function searchBingNews(query, limit) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
  return parseRssItems(await fetchText(url), limit).map((it) => ({
    ...it,
    source: it.source === 'News RSS' ? 'Bing News' : it.source,
  }));
}

async function searchGdelt(query, limit) {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
    `&mode=ArtList&maxrecords=${limit}&format=json&sort=DateDesc`;
  const text = await fetchText(url);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const articles = data.articles || data.documents || [];
  return articles.slice(0, limit).map((a) => {
    const seendate = a.seendate || a.seenDate || '';
    // GDELT seendate looks like 20260825T120000Z
    let date = null;
    const m = String(seendate).match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
    return {
      title: a.title || a.Title || '',
      url: a.url || a.url_mobile || null,
      source: a.domain || a.source || 'GDELT',
      date,
      snippet: (a.snippet || a.title || '').slice(0, 400),
    };
  }).filter((it) => it.title);
}

async function searchWithFallbacks(query, limit) {
  const errors = [];
  for (const [name, fn] of [
    ['google-news', searchGoogleNews],
    ['bing-news', searchBingNews],
    ['gdelt', searchGdelt],
  ]) {
    try {
      const items = await fn(query, limit);
      if (items.length) return { items, provider: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { items: [], provider: null, errors };
}

/**
 * Fetch recent news candidates for one company.
 * Returns a de-duped list of { title, url, source, date, snippet }.
 */
async function searchCompanyNews(company, { perQuery = 6, maxItems = 10 } = {}) {
  const queries = [
    `"${company.name}"`,
    `${company.name} (funding OR acquisition OR CEO OR CTO OR launch OR partnership)`,
    company.domain ? `"${company.name}" OR ${company.domain}` : null,
  ].filter(Boolean);

  const seen = new Set();
  const out = [];
  const allErrors = [];

  for (const query of queries) {
    const { items, provider, errors } = await searchWithFallbacks(query, perQuery);
    if (errors) allErrors.push(...errors);
    for (const item of items) {
      const key = (item.url || item.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...item, query, provider });
      if (out.length >= maxItems) return out;
    }
  }

  if (!out.length && allErrors.length) {
    console.warn(`  search warn [${company.id}]: all providers failed — ${allErrors.slice(0, 3).join('; ')}`);
  }
  return out;
}

/**
 * Prefetch news candidates for a batch of companies (parallel, limited concurrency).
 */
async function prefetchBatch(companies, { concurrency = 4 } = {}) {
  const results = {};
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const company = companies[idx];
      results[company.id] = await searchCompanyNews(company);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, () => worker()));
  return results;
}

module.exports = {
  searchCompanyNews,
  prefetchBatch,
  parseRssItems,
};
