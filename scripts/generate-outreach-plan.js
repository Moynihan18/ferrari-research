// Weekly refresh step: synthesizes companies.json + news.json + reo_activity.json into a
// ranked weekly outreach plan with bespoke draft messages, written to data/outreach_plan.json.
// Runs after fetch-reo-activity.js and fetch-news.js.
//
// Uses the Cursor CLI agent (headless/print mode) rather than a hosted LLM API - no web
// search is needed here, only synthesis over already-fetched data.
//
// Requires env var CURSOR_API_KEY and the Cursor CLI installed and on PATH
// (`curl https://cursor.com/install -fsS | bash`; installs both `agent` and
// `cursor-agent` symlinks in ~/.local/bin - either name works). See README.md.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOP_N = 12;
const CURSOR_MODEL = process.env.CURSOR_MODEL || null; // e.g. "composer-2.5"; unset = account default
const CLI_TIMEOUT_MS = Number(process.env.CURSOR_CLI_TIMEOUT_MS || 10 * 60 * 1000);

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function runCursorAgent(prompt) {
  const args = ['-p', '--trust', '--force', '--output-format', 'json'];
  if (CURSOR_MODEL) args.push('--model', CURSOR_MODEL);
  args.push(prompt);

  let stdout;
  try {
    stdout = execFileSync('agent', args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('Cursor CLI ("agent") not found on PATH. Install it first: curl https://cursor.com/install -fsS | bash');
    }
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
    throw new Error(`Cursor CLI exited with an error:\n${detail}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Cursor CLI did not return valid JSON on stdout: ${stdout.slice(0, 500)}`);
  }
  if (envelope.is_error) {
    throw new Error(`Cursor agent reported an error: ${envelope.result || JSON.stringify(envelope)}`);
  }
  if (typeof envelope.result !== 'string') {
    throw new Error(`Unexpected Cursor CLI output shape (no string "result" field): ${JSON.stringify(envelope).slice(0, 500)}`);
  }
  return envelope.result;
}

async function main() {
  if (!process.env.CURSOR_API_KEY) {
    console.error('CURSOR_API_KEY is not set. Add it as a repo secret (see README.md) before this step can run.');
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '..', 'data');
  const companiesDoc = loadJson(path.join(dataDir, 'companies.json'));
  const newsDoc = loadJson(path.join(dataDir, 'news.json'));
  const reoDoc = loadJson(path.join(dataDir, 'reo_activity.json'));

  const newsById = Object.fromEntries(newsDoc.companies.map(c => [c.id, c.news]));
  const reoById = Object.fromEntries(reoDoc.companies.map(c => [c.id, c.reo]));

  // Pre-rank candidates with a cheap heuristic score so the agent call only has to
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

Respond with ONLY a single raw JSON object matching this exact shape - no markdown code fences, no explanation before or after, nothing but the JSON:
{
  "items": [
    {
      "name": "string",
      "category": "acquisition|funding|leadership|product_launch|partnership|other",
      "why": "string",
      "message": "string"
    }
  ]
}

Candidates (JSON):
${JSON.stringify(shortlist, null, 2)}`;

  const resultText = runCursorAgent(prompt);
  let plan;
  try {
    plan = JSON.parse(stripCodeFence(resultText));
  } catch (e) {
    console.error('Failed to parse agent output.\nRaw output:', resultText.slice(0, 1000));
    plan = { items: [] };
  }

  const outPath = path.join(dataDir, 'outreach_plan.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), items: plan.items || [] }, null, 2));
  console.log(`Wrote outreach plan with ${(plan.items || []).length} accounts to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
