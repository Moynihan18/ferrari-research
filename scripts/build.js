// Weekly refresh orchestrator: runs the full pipeline in order. Used by the
// GitHub Actions workflow (.github/workflows/weekly-refresh.yml) and available
// locally via `npm run refresh`.
const { execFileSync } = require('child_process');
const path = require('path');

const steps = ['fetch-reo-activity.js', 'fetch-news.js', 'generate-outreach-plan.js'];

for (const step of steps) {
  console.log(`\n=== Running ${step} ===`);
  execFileSync(process.execPath, [path.join(__dirname, step)], { stdio: 'inherit' });
}

console.log('\nWeekly refresh complete.');
