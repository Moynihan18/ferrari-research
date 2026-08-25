// Weekly refresh step: researches recent news per account (acquisitions, funding,
// leadership changes, product launches, partnerships) using the Cursor CLI agent
// (headless/print mode) with its own web-search tool, and writes data/news.json.
//
// Requires env var CURSOR_API_KEY and the Cursor CLI installed and on PATH
// (`curl https://cursor.com/install -fsS | bash`; installs both `agent` and
// `cursor-agent` symlinks in ~/.local/bin - either name works). See README.md.
//
// NOTE: as of this writing there's an unresolved community report that Cursor's
// CLI agent can lose access to its web_search tool in headless mode. This script
// cannot verify that itself - if data/news.json starts filling with items that
// have no real source/url, that's the symptom; see README.md for the fallback.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BATCH_SIZE = 8;
const CURSOR_MODEL = process.env.CURSOR_MODEL || null; // e.g. "composer-2.5"; unset = account default
const CLI_TIMEOUT_MS = 3 * 60 * 1000; // a batch may run ~16 web searches

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
  const args = ['-p', '--output-format', 'json'];
  if (CURSOR_MODEL) args.push('--model', CURSOR_MODEL);
  args.push(prompt);

  let stdout;
  try {
    stdout = execFileSync('agent', args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('Cursor CLI ("agent") not found on PATH. Install it first: curl https://cursor.com/install -fsS | bash');
    }
    throw new Error(`Cursor CLI exited with an error: ${e.stderr || e.message}`);
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

async function researchBatch(companies) {
  const list = companies.map(c => `- id: ${c.id} | name: ${c.name} | domain: ${c.domain}`).join('\n');
  const prompt = `You are researching account news for a sales team at Modular, an AI inference/compute infrastructure company. Today's date is ${new Date().toISOString().slice(0, 10)}.

For each company below, use web search to find genuinely recent news (roughly the last 7-10 days, since this runs weekly - but include anything notable from the last ~60 days if nothing more recent exists) covering: acquisitions, funding raises, new leadership (CEO/CTO/VP Eng hires or departures), new product/model launches, or notable partnerships. Also try a LinkedIn-focused search (site:linkedin.com "<company name>") to catch company announcement posts. Do not fabricate news - if you cannot actually find something via search, or search isn't available to you, return an empty news array for that company rather than inventing one. Cap at 4 items per company, newest first.

For each item, classify into exactly one category (acquisition, funding, leadership, product_launch, partnership, other), write a neutral 1-2 sentence summary, and a separate 1-sentence sales_relevance note explaining why a Modular sales rep should care.

Respond with ONLY a single raw JSON object matching this exact shape - no markdown code fences, no explanation before or after, nothing but the JSON:
{
  "companies": [
    {
      "id": "<company id, verbatim from the list below>",
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

Companies:
${list}`;

  const resultText = runCursorAgent(prompt);
  try {
    return JSON.parse(stripCodeFence(resultText));
  } catch (e) {
    console.error('Failed to parse agent output for batch', companies.map(c => c.id), '\nRaw output:', resultText.slice(0, 1000));
    return { companies: [] };
  }
}

async function main() {
  if (!process.env.CURSOR_API_KEY) {
    console.error('CURSOR_API_KEY is not set. Add it as a repo secret (see README.md) before this step can run.');
    process.exit(1);
  }

  const companiesDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'companies.json'), 'utf8'));
  const batches = chunk(companiesDoc.companies, BATCH_SIZE);

  const allResults = [];
  for (const [i, batch] of batches.entries()) {
    console.log(`Researching batch ${i + 1}/${batches.length} (${batch.length} companies)...`);
    const result = await researchBatch(batch);
    allResults.push(...(result.companies || []));
  }

  const outPath = path.join(__dirname, '..', 'data', 'news.json');
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), companies: allResults }, null, 2));
  console.log(`Wrote news for ${allResults.length} companies to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
