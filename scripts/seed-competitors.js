// One-time seed: writes the fixed list of inference/ML-platform competitors
// tracked on the Competitive Intel dashboard tab into data/competitors.json.
// Re-run only if the tracked competitor list changes.
const fs = require('fs');
const path = require('path');

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// name: used verbatim in news search queries, so it's specific enough to
// disambiguate (e.g. "NVIDIA Dynamo" rather than just "NVIDIA").
const rows = [
  ['Baseten', 'baseten.co', 'Managed inference platform', 'Serverless GPU inference for custom/open-weight models; strong presence among AI-native startups (OpenEvidence, Mercor, Abridge, Clay, and others serve on Baseten).'],
  ['Fireworks AI', 'fireworks.ai', 'Managed inference platform', 'Fast inference for open and fine-tuned models, with a fireworks-native serving stack; customers include Cursor, Perplexity, Sourcegraph, Cresta.'],
  ['Together AI', 'together.ai', 'Managed inference platform', 'GPU cloud + inference platform for open-weight and fine-tuned models; also sells training/fine-tuning; customers include Decagon, Jasper, Upstage, Arcee AI.'],
  ['Seldon', 'seldon.io', 'MLOps / model-serving platform', 'Kubernetes-native model deployment and monitoring platform (Seldon Core), positioned for enterprise MLOps rather than a hosted-inference marketplace.'],
  ['Modal', 'modal.com', 'Serverless compute / inference platform', 'Serverless GPU compute platform for running arbitrary Python/ML workloads, popular for real-time inference, fine-tuning, and agentic workloads; customers include Runway, Suno, Hume AI, Cognition.'],
  ['Anyscale', 'anyscale.com', 'Distributed compute platform', 'Commercial platform built on Ray for distributed training and inference at scale; positions around scaling AI workloads across large GPU clusters.'],
  ['NVIDIA Dynamo', 'nvidia.com', 'Open-source inference serving framework', 'NVIDIA’s open-source, disaggregated-serving inference framework for large-scale LLM deployment across GPU fleets — a direct architectural competitor to MAX at the framework layer.'],
  ['Google Cloud Vertex AI', 'cloud.google.com', 'Hyperscaler ML platform', 'GCP’s managed ML platform, including Model Garden and endpoints for serving first-party (Gemini) and third-party/open models.'],
  ['AWS SageMaker', 'aws.amazon.com', 'Hyperscaler ML platform', 'AWS’s managed ML platform, including SageMaker Inference (real-time, serverless, and async endpoints) and Bedrock for hosted foundation models.'],
];

const competitors = rows.map(([name, domain, category, description]) => ({
  id: slug(name),
  name,
  domain,
  category,
  description,
}));

const outPath = path.join(__dirname, '..', 'data', 'competitors.json');
fs.writeFileSync(outPath, JSON.stringify({ generated_at: null, competitors }, null, 2));
console.log(`Wrote ${competitors.length} competitors to ${outPath}`);
