// One-time aggregation: merges the 8 parallel research-batch JSON files produced this
// session into data/news.json and data/reo_activity.json. Not part of the weekly pipeline
// (fetch-reo-activity.js and fetch-news.js write those files directly going forward) - this
// script only exists to seed the first real dataset from the manual research pass.
const fs = require('fs');
const path = require('path');

const SCRATCH = process.argv[2];
if (!SCRATCH) {
  console.error('Usage: node aggregate-research.js <scratch-dir>');
  process.exit(1);
}

const newsCompanies = [];
const reoCompanies = [];

for (let i = 0; i < 8; i++) {
  const p = path.join(SCRATCH, `research_batch_${i}.json`);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const c of doc.companies) {
    newsCompanies.push({ id: c.id, news: c.news || [] });
    reoCompanies.push({ id: c.id, reo: c.reo || { found: false } });
  }
}

const generatedAt = new Date().toISOString();

fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'news.json'),
  JSON.stringify({ generated_at: generatedAt, companies: newsCompanies }, null, 2)
);
fs.writeFileSync(
  path.join(__dirname, '..', 'data', 'reo_activity.json'),
  JSON.stringify({ generated_at: generatedAt, companies: reoCompanies }, null, 2)
);

console.log(`Wrote news.json (${newsCompanies.length}) and reo_activity.json (${reoCompanies.length})`);
