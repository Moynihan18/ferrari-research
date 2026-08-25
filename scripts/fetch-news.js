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

const BATCH_SIZE = 8;
const CURSOR_MODEL = process.env.CURSOR_MODEL || null;
const CLI_TIMEOUT_MS = 3 * 60 * 1000;

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

function runCursorAgent(prompt) {
  // --trust: required in non-interactive CI
  // --force: auto-approve tool use (agent should not need web tools here)
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
      throw new Error(
        'Cursor CLI ("agent") not found on PATH. Install it first: curl https://cursor.com/install -fsS | bash'
      );
    }
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
    throw new Error(`Cursor CLI exited with an error:\n${detail}`);
  }

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

function formatCandidates(company, items) {
  if (!items.length) return `(no search hits for ${company.name})`;
  return items
    .map(
      (it, i) =>
        `  ${i + 1}. date=${it.date || 'unknown'} | source=${it.source}\n` +
        `     title: ${it.title}\n` +
        `     url: ${it.url || 'null'}\n` +
        `     snippet: ${it.snippet || ''}`
    )
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

  const prompt = `You are researching account news for a sales team at Modular, an AI inference/compute infrastructure company. Today's date is ${today}.

You are given SEARCH CANDIDATES already fetched from Google News RSS for each company. Do NOT attempt web search, browsing, or tool use — use only the candidates below. If a company's candidate list is empty or irrelevant, return an empty news array for that company. Do not invent articles.

From the candidates, select genuinely recent items (prefer last 7-10 days; allow notable items from ~last 60 days if nothing newer). Keep only: acquisitions, funding, leadership (CEO/CTO/VP Eng), product/model launches, partnerships. Cap at 4 items per company, newest first.

For each selected item:
- date: YYYY-MM-DD (from the candidate when possible)
- category: exactly one of acquisition|funding|leadership|product_launch|partnership|other
- title, source, url (prefer the candidate url; null only if missing)
- summary: neutral 1-2 sentences
- sales_relevance: 1 sentence on why a Modular sales rep should care

Respond with ONLY a single raw JSON object — no markdown fences, no commentary:
{
  "companies": [
    {
      "id": "<company id, verbatim>",
      "news": [
        {
          "date": "YYYY-MM-DD",
          "category": "acquisition|funding|leadership|product_launch|partnership|other",
          "title": "string",
          "source": "string",
          "url": "string or null",
          "summary": "string",
          "sales_relevance": "string"
        }
      ]
    }
  ]
}

Include every company id from the list below (empty news arrays are fine).

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
