// Weekly refresh step: researches recent news per account (acquisitions, funding,
// leadership changes, product launches, partnerships) and writes data/news.json.
//
// Architecture (CI-safe):
//   1. Prefetch candidate articles in Node via Google News RSS (real HTTP from
//      the runner — does not use Cursor's built-in web_search tool).
//   2. Ask the headless Cursor CLI agent to select/classify/summarize those
//      candidates into the news.json schema.
//
// Why: Cursor CLI headless/print mode often returns "Web search was blocked"
// on GitHub Actions. Prefetching outside the agent avoids that failure mode
// while still using CURSOR_API_KEY for the LLM step.
//
// Requires env var CURSOR_API_KEY and the Cursor CLI on PATH
// (`curl https://cursor.com/install -fsS | bash`).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { prefetchBatch } = require('./lib/news-search');

// Smaller batches + longer timeout: CI previously hit spawnSync ETIMEDOUT at 3m
// on the first 8-company classify call.
const BATCH_SIZE = Number(process.env.NEWS_BATCH_SIZE || 3);
const MAX_CANDIDATES_PER_COMPANY = Number(process.env.NEWS_MAX_CANDIDATES || 5);
const CURSOR_MODEL = process.env.CURSOR_MODEL || null;
const CLI_TIMEOUT_MS = Number(process.env.CURSOR_CLI_TIMEOUT_MS || 10 * 60 * 1000);
const CLI_RETRIES = Number(process.env.CURSOR_CLI_RETRIES || 2);

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
  // --trust: required in non-interactive CI
  // --force: auto-approve (agent should not need tools; prompt forbids them)
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

function formatCandidates(company, items) {
  const trimmed = items.slice(0, MAX_CANDIDATES_PER_COMPANY);
  if (!trimmed.length) return `(no search hits for ${company.name})`;
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

async function researchBatch(companies, prefetched) {
  const today = new Date().toISOString().slice(0, 10);
  const sections = companies
    .map((c) => {
      const hits = prefetched[c.id] || [];
      return `### id: ${c.id} | name: ${c.name} | domain: ${c.domain}\n${formatCandidates(c, hits)}`;
    })
    .join('\n\n');

  const prompt = `You are a sales-research classifier for Modular (AI inference/compute infra). Today is ${today}.

IMPORTANT: Do NOT use any tools (no web search, no shell, no browser). Use ONLY the SEARCH CANDIDATES below. Reply with raw JSON only.

For each company, pick up to 4 recent relevant items (funding, acquisition, leadership, product_launch, partnership; prefer last 7-10 days, else ~60 days). Skip noise. Empty news arrays are fine. Do not invent articles.

Each item fields: date (YYYY-MM-DD), category (acquisition|funding|leadership|product_launch|partnership|other), title, source, url (string|null), summary (1-2 sentences), sales_relevance (1 sentence for a Modular rep).

Output shape:
{"companies":[{"id":"<verbatim id>","news":[{"date":"YYYY-MM-DD","category":"funding","title":"...","source":"...","url":"...","summary":"...","sales_relevance":"..."}]}]}

Include every company id listed below.

SEARCH CANDIDATES:
${sections}`;

  const resultText = runCursorAgent(prompt);
  try {
    return JSON.parse(stripCodeFence(resultText));
  } catch (e) {
    console.error(
      'Failed to parse agent output for batch',
      companies.map((c) => c.id),
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
    `fetch-news config: BATCH_SIZE=${BATCH_SIZE}, CLI_TIMEOUT_MS=${CLI_TIMEOUT_MS}, CLI_RETRIES=${CLI_RETRIES}, MAX_CANDIDATES=${MAX_CANDIDATES_PER_COMPANY}`
  );

  const companiesDoc = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'companies.json'), 'utf8')
  );
  const batches = chunk(companiesDoc.companies, BATCH_SIZE);

  const allResults = [];
  for (const [i, batch] of batches.entries()) {
    console.log(`Prefetching news for batch ${i + 1}/${batches.length} (${batch.length} companies)...`);
    const prefetched = await prefetchBatch(batch);
    const hitCounts = batch.map((c) => `${c.id}:${(prefetched[c.id] || []).length}`).join(', ');
    console.log(`  RSS hits: ${hitCounts}`);

    console.log(`Classifying batch ${i + 1}/${batches.length} with Cursor CLI...`);
    const result = await researchBatch(batch, prefetched);
    allResults.push(...(result.companies || []));
  }

  const outPath = path.join(__dirname, '..', 'data', 'news.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), companies: allResults }, null, 2)
  );
  const withNews = allResults.filter((c) => c.news && c.news.length).length;
  console.log(`Wrote news for ${allResults.length} companies (${withNews} with items) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
