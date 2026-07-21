// Weekly refresh step: synthesizes companies.json + news.json + reo_activity.json into a
// ranked weekly outreach plan with bespoke draft messages, written to data/outreach_plan.json.
// Runs after fetch-reo-activity.js and fetch-news.js.
//
// Requires env var ANTHROPIC_API_KEY.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();
const MODEL = 'claude-opus-4-8';
const TOP_N = 12;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: {
            type: 'string',
            enum: ['acquisition', 'funding', 'leadership', 'product_launch', 'partnership', 'other'],
          },
          why: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['name', 'category', 'why', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const dataDir = path.join(__dirname, '..', 'data');
  const companiesDoc = loadJson(path.join(dataDir, 'companies.json'));
  const newsDoc = loadJson(path.join(dataDir, 'news.json'));
  const reoDoc = loadJson(path.join(dataDir, 'reo_activity.json'));

  const newsById = Object.fromEntries(newsDoc.companies.map(c => [c.id, c.news]));
  const reoById = Object.fromEntries(reoDoc.companies.map(c => [c.id, c.reo]));

  // Pre-rank candidates with a cheap heuristic score so the LLM call only has to
  // reason over a manageable shortlist, not all ~90 companies at once.
  const catWeight = { acquisition: 5, funding: 5, leadership: 4, product_launch: 3, partnership: 3, other: 1 };
  function daysAgo(dateStr) {
    if (!dateStr || dateStr === 'undated') return 999;
    const d = new Date(dateStr);
    return isNaN(d) ? 999 : Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  const scored = companiesDoc.companies.map(c => {
    const items = newsById[c.id] || [];
    const r = reoById[c.id] || { found: false };
    let bestScore = -1;
    for (const item of items) {
      const recency = Math.max(0, 120 - daysAgo(item.date));
      const score = (catWeight[item.category] || 1) * 10 + recency;
      if (score > bestScore) bestScore = score;
    }
    let reoBoost = 0;
    if (r.found) {
      if (r.intent_level === 'High') reoBoost = 30;
      else if (r.intent_level === 'Moderate') reoBoost = 15;
      else reoBoost = 5;
    }
    const customerPenalty = (c.salesforce_status || '').toLowerCase().includes('customer') ? -40 : 0;
    return { company: c, total: bestScore + reoBoost + customerPenalty };
  }).sort((a, b) => b.total - a.total);

  const shortlist = scored.slice(0, TOP_N * 2).map(s => ({
    ...s.company,
    news: newsById[s.company.id] || [],
    reo: reoById[s.company.id] || { found: false },
  }));

  const prompt = `You are prioritizing weekly sales outreach for Modular (an AI inference/compute infrastructure company that sells the MAX inference engine). Today's date is ${new Date().toISOString().slice(0, 10)}.

Below are ${shortlist.length} candidate accounts, each with recent news and Reo.dev engagement signal. Pick the ${TOP_N} best accounts to prioritize for outreach THIS WEEK, ranked most-important first. Prefer accounts with: (1) a clear, recent, sales-relevant news trigger (funding, acquisition, leadership change, product launch), (2) real Reo.dev engagement/intent signal where available, (3) not already a Salesforce "Customer" (expansion plays are lower priority than new-logo prospecting this week unless the signal is exceptional).

For each selected account, write:
- "why": 1-2 sentences on why this account is a priority this week, citing the specific trigger.
- "message": A bespoke, ready-to-send outreach message (roughly 80-130 words) referencing the specific news trigger, connecting it to a plausible infra/inference need, and proposing a concrete next step. Professional, not salesy, no exclamation-point overload.

Candidates (JSON):
${JSON.stringify(shortlist, null, 2)}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const plan = textBlock ? JSON.parse(textBlock.text) : { items: [] };

  const outPath = path.join(dataDir, 'outreach_plan.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), items: plan.items }, null, 2));
  console.log(`Wrote outreach plan with ${plan.items.length} accounts to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
