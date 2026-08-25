// Weekly refresh step: researches recent competitive moves (pricing, product
// launches, funding, partnerships, customer wins, published benchmarks,
// leadership changes) for the fixed list of inference/ML-platform competitors
// in data/competitors.json, and writes data/competitor_news.json.
//
// Same CI-safe architecture as fetch-news.js:
//   1. Prefetch candidate articles in Node via Google News RSS (+ fallbacks).
//   2. Ask the headless Cursor CLI agent to select/classify/summarize those
//      candidates - it is not asked to search the web itself.
//
// Requires env var CURSOR_API_KEY and the Cursor CLI on PATH
// (`curl https://cursor.com/install -fsS | bash`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { prefetchBatch } = require('./lib/news-search');

const BATCH_SIZE = Number(process.env.COMPETITOR_BATCH_SIZE || 3);
const MAX_CANDIDATES_PER_COMPETITOR = Number(process.env.COMPETITOR_MAX_CANDIDATES || 5);
const CURSOR_MODEL = process.env.CURSOR_MODEL || null;
const CLI_TIMEOUT_MS = Number(process.env.CURSOR_CLI_TIMEOUT_MS || 10 * 60 * 1000);
const CLI_RETRIES = Number(process.env.CURSOR_CLI_RETRIES || 2);

// Competitive moves we care about are different from account sales signals -
// no CEO/CTO hiring noise, but pricing and published benchmarks matter a lot.
const SEARCH_KEYWORDS = ['pricing', 'launch', 'benchmark', 'funding', 'partnership', 'acquisition'];

const CATEGORIES = ['pricing', 'product_launch', 'funding', 'partnership', 'customer_win', 'benchmark_perf', 'leadership', 'other'];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function isTimeoutError(e) {
  return e && (e.code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(String(e.message)) || /ETIMEDOUT/i.test(String(e.stderr)));
}

function runCursorAgentOnce(prompt) {
  const args = ['-p', '--trust', '--force', '--output-format', 'json'];
  if (CURSOR_MODEL) args.push('--model', CURSOR_MODEL);
  args.push(prompt);

  const started = Date.now();
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
      throw new Error(
        'Cursor CLI ("agent") not found on PATH. Install it first: curl https://cursor.com/install -fsS | bash'
      );
    }
    const err = new Error(
      `Cursor CLI exited with an error:\n${[e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim()}`
    );
    err.code = e.code;
    throw err;
  }
  console.log(`  Cursor CLI finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Cursor CLI did not return valid JSON on stdout: ${String(stdout).slice(0, 500)}`);
  }
  if (envelope.is_error) {
    throw new Error(`Cursor agent reported an error: ${envelope.result || JSON.stringify(envelope)}`);
  }
  if (typeof envelope.result !== 'string') {
    throw new Error(
      `Unexpected Cursor CLI output shape (no string "result" field): ${JSON.stringify(envelope).slice(0, 500)}`
    );
  }
  return envelope.result;
}

function runCursorAgent(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= CLI_RETRIES + 1; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`  Retrying Cursor CLI (attempt ${attempt}/${CLI_RETRIES + 1})...`);
      }
      return runCursorAgentOnce(prompt);
    } catch (e) {
      lastErr = e;
      if (!isTimeoutError(e) || attempt > CLI_RETRIES) throw e;
      console.warn(`  Cursor CLI timed out after ${CLI_TIMEOUT_MS / 1000}s; will retry.`);
    }
  }
  throw lastErr;
}

function formatCandidates(competitor, items) {
  const trimmed = items.slice(0, MAX_CANDIDATES_PER_COMPETITOR);
  if (!trimmed.length) return `(no search hits for ${competitor.name})`;
  return trimmed
    .map((it, i) => {
      const snippet = (it.snippet || '').slice(0, 180);
      return (
        `  ${i + 1}. [${it.date || 'unknown'}] ${it.source}: ${it.title}\n` +
        `     url: ${it.url || 'null'}` +
        (snippet ? `\n     snippet: ${snippet}` : '')
      );
    })
    .join('\n');
}

async function researchBatch(competitors, prefetched) {
  const today = new Date().toISOString().slice(0, 10);
  const sections = competitors
    .map((c) => {
      const hits = prefetched[c.id] || [];
      return `### id: ${c.id} | name: ${c.name} | category: ${c.category}\n${formatCandidates(c, hits)}`;
    })
    .join('\n\n');

  const prompt = `You are a competitive-intelligence analyst for Modular, which sells the MAX inference engine. Today is ${today}. The companies below are inference/ML-platform COMPETITORS, not sales prospects.

IMPORTANT: Do NOT use any tools (no web search, no shell, no browser). Use ONLY the SEARCH CANDIDATES below. Reply with raw JSON only.

For each competitor, pick up to 4 recent items that matter competitively (prefer last 7-10 days, else ~60 days): pricing changes, new product/feature launches, funding rounds, partnerships (chip vendors, model providers, cloud marketplaces), notable customer wins/case studies, published benchmarks or performance claims, or leadership changes. Skip generic PR fluff. Empty news arrays are fine. Do not invent items.

Each item fields: date (YYYY-MM-DD), category (one of: ${CATEGORIES.join('|')}), title, source, url (string|null), summary (1-2 sentences, neutral), competitive_takeaway (1 sentence: what this means for Modular's competitive position - e.g. a pricing pressure point, a benchmark claim worth checking, a customer segment they're winning).

Output shape:
{"companies":[{"id":"<verbatim id>","news":[{"date":"YYYY-MM-DD","category":"pricing","title":"...","source":"...","url":"...","summary":"...","competitive_takeaway":"..."}]}]}

Include every competitor id listed below.

SEARCH CANDIDATES:
${sections}`;

  const resultText = runCursorAgent(prompt);
  try {
    return JSON.parse(stripCodeFence(resultText));
  } catch (e) {
    console.error(
      'Failed to parse agent output for batch',
      competitors.map((c) => c.id),
      '\nRaw output:',
      resultText.slice(0, 1000)
    );
    return { companies: [] };
  }
}

async function main() {
  if (!process.env.CURSOR_API_KEY) {
    console.error(
      'CURSOR_API_KEY is not set. Add it as a repo secret (see README.md) before this step can run.'
    );
    process.exit(1);
  }

  console.log(
    `fetch-competitor-news config: BATCH_SIZE=${BATCH_SIZE}, CLI_TIMEOUT_MS=${CLI_TIMEOUT_MS}, CLI_RETRIES=${CLI_RETRIES}, MAX_CANDIDATES=${MAX_CANDIDATES_PER_COMPETITOR}`
  );

  const competitorsDoc = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'competitors.json'), 'utf8')
  );
  const batches = chunk(competitorsDoc.competitors, BATCH_SIZE);

  const allResults = [];
  for (const [i, batch] of batches.entries()) {
    console.log(`Prefetching news for batch ${i + 1}/${batches.length} (${batch.length} competitors)...`);
    const prefetched = await prefetchBatch(batch, { keywords: SEARCH_KEYWORDS });
    const hitCounts = batch.map((c) => `${c.id}:${(prefetched[c.id] || []).length}`).join(', ');
    console.log(`  RSS hits: ${hitCounts}`);

    console.log(`Classifying batch ${i + 1}/${batches.length} with Cursor CLI...`);
    const result = await researchBatch(batch, prefetched);
    allResults.push(...(result.companies || []));
  }

  const outPath = path.join(__dirname, '..', 'data', 'competitor_news.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), companies: allResults }, null, 2)
  );
  const withNews = allResults.filter((c) => c.news && c.news.length).length;
  console.log(`Wrote competitor news for ${allResults.length} competitors (${withNews} with items) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
