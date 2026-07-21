// Weekly refresh step: researches recent news per account (acquisitions, funding,
// leadership changes, product launches, partnerships) using Claude with the web_search
// tool, and writes data/news.json.
//
// Requires env var ANTHROPIC_API_KEY.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();
const MODEL = 'claude-opus-4-8';
const BATCH_SIZE = 8;

const NEWS_SCHEMA = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          news: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                category: {
                  type: 'string',
                  enum: ['acquisition', 'funding', 'leadership', 'product_launch', 'partnership', 'other'],
                },
                title: { type: 'string' },
                source: { type: 'string' },
                url: { type: ['string', 'null'] },
                summary: { type: 'string' },
                sales_relevance: { type: 'string' },
              },
              required: ['date', 'category', 'title', 'source', 'url', 'summary', 'sales_relevance'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'news'],
        additionalProperties: false,
      },
    },
  },
  required: ['companies'],
  additionalProperties: false,
};

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function researchBatch(companies) {
  const list = companies.map(c => `- id: ${c.id} | name: ${c.name} | domain: ${c.domain}`).join('\n');
  const prompt = `You are researching account news for a sales team at Modular, an AI inference/compute infrastructure company. Today's date is ${new Date().toISOString().slice(0, 10)}.

For each company below, use web search to find genuinely recent news (roughly the last 7-10 days, since this runs weekly - but include anything notable from the last ~60 days if nothing more recent exists) covering: acquisitions, funding raises, new leadership (CEO/CTO/VP Eng hires or departures), new product/model launches, or notable partnerships. Also try a LinkedIn-focused search (site:linkedin.com "<company name>") to catch company announcement posts. Do not fabricate news - if nothing credible and recent exists, return an empty news array for that company. Cap at 4 items per company, newest first.

For each item, classify into exactly one category (acquisition, funding, leadership, product_launch, partnership, other), write a neutral 1-2 sentence summary, and a separate 1-sentence sales_relevance note explaining why a Modular sales rep should care.

Companies:
${list}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    output_config: { format: { type: 'json_schema', schema: NEWS_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return { companies: [] };
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    console.error('Failed to parse model output for batch', companies.map(c => c.id), e);
    return { companies: [] };
  }
}

async function main() {
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
