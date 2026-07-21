// Weekly refresh step: pulls live Reo.dev signals for every account in data/companies.json
// and writes data/reo_activity.json.
//
// Requires env vars:
//   REO_API_KEY      - Data-out API key from Reo Settings -> Configurations -> API Keys
//   REO_SEGMENT_ID    - id of a Reo segment/list that contains (a superset of) these accounts,
//                       used to resolve domain -> account_id. See README for setup.
//
// Reo's public REST API (https://developers.reo.dev/) only exposes raw activity events and
// segment/account listings - not the richer computed engagement scoring available inside the
// Reo product. This script computes a comparable summary (event counts, last-seen date,
// distinct developers) from the raw activity feed.
const fs = require('fs');
const path = require('path');

const REO_BASE_URL = 'https://integration.reo.dev';
const REO_API_KEY = process.env.REO_API_KEY;
const REO_SEGMENT_ID = process.env.REO_SEGMENT_ID;
const LOOKBACK_DAYS = 90;

async function reoGet(pathname) {
  const res = await fetch(`${REO_BASE_URL}${pathname}`, {
    headers: { 'x-api-key': REO_API_KEY },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const waitMs = body.waitMs || 5000;
    await new Promise(r => setTimeout(r, waitMs));
    return reoGet(pathname);
  }
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, status: res.status };
  }
  return res.json();
}

async function buildDomainToAccountMap(segmentId) {
  const map = {};
  let page = 1;
  for (;;) {
    const data = await reoGet(`/segment/${segmentId}/accounts?page=${page}`);
    if (data.error || !Array.isArray(data.data || data.accounts || data)) {
      const rows = data.data || data.accounts || (Array.isArray(data) ? data : []);
      if (!rows.length) break;
    }
    const rows = data.data || data.accounts || (Array.isArray(data) ? data : []);
    if (!rows.length) break;
    for (const row of rows) {
      const domain = (row.account_domain || row.domain || '').toLowerCase();
      if (domain) map[domain] = row;
    }
    page += 1;
    if (page > 50) break; // safety cap
  }
  return map;
}

function summarizeActivities(activities) {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const recent = activities.filter(a => new Date(a.activity_date).getTime() >= cutoff);
  const devIds = new Set(recent.map(a => a.developer_id).filter(Boolean));
  const lastDate = activities.reduce((max, a) => {
    const t = new Date(a.activity_date).getTime();
    return t > max ? t : max;
  }, 0);
  return {
    total_events_90d: recent.length,
    unique_developers_90d: devIds.size,
    last_activity_date: lastDate ? new Date(lastDate).toISOString().slice(0, 10) : null,
  };
}

async function main() {
  if (!REO_API_KEY || !REO_SEGMENT_ID) {
    console.error('REO_API_KEY and REO_SEGMENT_ID must be set. Skipping Reo refresh (writing empty result).');
    const outPath = path.join(__dirname, '..', 'data', 'reo_activity.json');
    fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), companies: [] }, null, 2));
    return;
  }

  const companiesDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'companies.json'), 'utf8'));
  const domainMap = await buildDomainToAccountMap(REO_SEGMENT_ID);

  const results = [];
  for (const company of companiesDoc.companies) {
    const domain = company.domain.toLowerCase();
    const accountRow = domainMap[domain];
    if (!accountRow) {
      results.push({ id: company.id, reo: { found: false, note: 'Domain not present in the configured Reo segment.' } });
      continue;
    }
    const accountId = accountRow.id || accountRow.account_id;
    const activitiesResp = await reoGet(`/account/${accountId}/activities`);
    if (activitiesResp.error) {
      results.push({
        id: company.id,
        reo: { found: true, customer_fit_score: accountRow.customer_fit_score || null, note: `Activities fetch failed: ${activitiesResp.error}` },
      });
      continue;
    }
    const activities = Array.isArray(activitiesResp) ? activitiesResp : (activitiesResp.data || []);
    const summary = summarizeActivities(activities);
    results.push({
      id: company.id,
      reo: {
        found: true,
        customer_fit_score: accountRow.customer_fit_score || null,
        developer_stage: accountRow.developer_activity || accountRow.developer_stage || null,
        engagement_score: null,
        intent_level: summary.total_events_90d > 20 ? 'High' : summary.total_events_90d > 0 ? 'Moderate' : 'Low',
        last_activity_date: summary.last_activity_date,
        total_events_90d: summary.total_events_90d,
        open_roles: null,
        note: `${summary.unique_developers_90d} distinct developer(s) active in the last ${LOOKBACK_DAYS} days.`,
      },
    });
  }

  const outPath = path.join(__dirname, '..', 'data', 'reo_activity.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), companies: results }, null, 2));
  console.log(`Wrote Reo activity for ${results.length} companies to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
