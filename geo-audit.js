#!/usr/bin/env node
/**
 * GEO Visibility Audit Tool
 * Tests brand visibility across AI models (Claude, GPT, and optionally
 * Gemini and Perplexity) for a set of bottom-of-funnel search queries,
 * then scores citation strength, maps coverage by intent cluster, and
 * surfaces competitor share of voice.
 *
 * Usage:
 *   node geo-audit.js <url> [--queries queries.txt]
 *
 * Setup:
 *   1. cp .env.example .env
 *   2. Fill in ANTHROPIC_API_KEY and OPENAI_API_KEY in .env (required baseline)
 *   3. (Optional) Fill in GEMINI_API_KEY and/or PERPLEXITY_API_KEY to test
 *      those models too. Leave either blank to skip it; the tool runs fine
 *      with just Claude + GPT.
 *   4. (Optional) Fill in GOOGLE_SERVICE_ACCOUNT_FILE and GOOGLE_SHEET_ID
 *      if you want results exported to a Sheet. Without these, the tool
 *      just skips the export step and still prints the full terminal report.
 */

import { loadEnv, requireEnv, optionalEnv } from './config.js';

loadEnv();

// Claude and GPT are the required baseline providers.
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

// Gemini and Perplexity are optional. If a key is missing, that provider
// is skipped for the whole run, same pattern as the Sheets export below.
const GEMINI_API_KEY = optionalEnv('GEMINI_API_KEY');
const PERPLEXITY_API_KEY = optionalEnv('PERPLEXITY_API_KEY');

// Optional: only needed if you want the Google Sheets export step.
const SERVICE_ACCOUNT_FILE = optionalEnv('GOOGLE_SERVICE_ACCOUNT_FILE');
const SHEET_ID = optionalEnv('GOOGLE_SHEET_ID');

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const OPENAI_BASE = 'https://api.openai.com/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PERPLEXITY_BASE = 'https://api.perplexity.ai';

const ANTHROPIC_MODEL = optionalEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-6');
const OPENAI_MODEL = optionalEnv('OPENAI_MODEL', 'gpt-5.4-mini');
const GEMINI_MODEL = optionalEnv('GEMINI_MODEL', 'gemini-2.5-flash');
const PERPLEXITY_MODEL = optionalEnv('PERPLEXITY_MODEL', 'sonar');

/**
 * Central list of which model providers are active this run. Claude and
 * GPT are always on. Gemini / Perplexity join only if their key is set.
 * Every later step (the query loop, coverage map, competitor extraction,
 * terminal report, Sheets export) reads this list instead of hardcoding
 * provider names, so adding a 5th provider later only means adding one
 * entry here plus one `check<Provider>` function.
 */
const PROVIDERS = [
  { key: 'claude', label: 'Claude', model: ANTHROPIC_MODEL, active: true },
  { key: 'gpt', label: 'GPT', model: OPENAI_MODEL, active: true },
  { key: 'gemini', label: 'Gemini', model: GEMINI_MODEL, active: Boolean(GEMINI_API_KEY) },
  { key: 'perplexity', label: 'Perplexity', model: PERPLEXITY_MODEL, active: Boolean(PERPLEXITY_API_KEY) },
].filter((p) => p.active);

let totalInputTokens = 0;
let totalOutputTokens = 0;

// ─── ANSI colours ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
};

function scoreColor(pct) {
  return pct >= 60 ? C.green : pct >= 30 ? C.yellow : C.red;
}

function citationColor(type) {
  switch (type) {
    case 'STRONG':
      return C.green;
    case 'SOFT':
      return C.cyan;
    case 'MENTION':
      return C.yellow;
    default:
      return C.red;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractBrand(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0];
  } catch {
    return url.replace(/^https?:\/\//, '').split(/[./]/)[0];
  }
}

function trunc(str, n) {
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function wrap(text, width, indent) {
  const words = text.split(' ');
  const lines = [];
  let cur = indent;
  for (const word of words) {
    if (cur.length + word.length + 1 > width && cur.trim()) {
      lines.push(cur.trimEnd());
      cur = indent + word + ' ';
    } else {
      cur += word + ' ';
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.join('\n');
}

function progressBar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function brandRegex(brandName) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = brandName.replace(/(?:ai|hq|app|io|co|hub|ly)$/i, '');
  const useStripped = stripped.length >= 4 && stripped !== brandName;
  const pattern = useStripped
    ? `${escape(brandName)}|${escape(stripped)}`
    : escape(brandName);
  return new RegExp(pattern, 'i');
}

// ─── Anthropic API ────────────────────────────────────────────────────────────
async function anthropicRequest(messages, { model, maxTokens = 2048, tools, betaHeader }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (betaHeader) headers['anthropic-beta'] = betaHeader;

  const body = { model, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.usage) {
    totalInputTokens += data.usage.input_tokens || 0;
    totalOutputTokens += data.usage.output_tokens || 0;
  }
  return data;
}

/**
 * Calls the Anthropic API and, only when tools were actually supplied,
 * resumes automatically if the model pauses mid-turn (stop_reason
 * "pause_turn"), which can happen during long-running server-side tool
 * use such as web_search.
 *
 * Bug fix from the original version: the resume loop used to run for
 * EVERY call, including plain text-only calls that never pass `tools`.
 * Since `pause_turn` can only legitimately occur when a tool is in play,
 * looping on it without tools present resent an unchanged conversation
 * with no new turn to advance it, an infinite loop if the API ever
 * returned that stop_reason on a plain call. The loop is now gated on
 * `opts.tools` being present, and capped at a small number of resumes
 * as a hard safety limit either way.
 */
async function anthropicCall(messages, opts) {
  const history = [...messages];
  const MAX_RESUMES = 5;
  let resumes = 0;

  while (true) {
    const resp = await anthropicRequest(history, opts);

    const canResume = Boolean(opts.tools) && resp.stop_reason === 'pause_turn';
    if (canResume && resumes < MAX_RESUMES) {
      history.push({ role: 'assistant', content: resp.content });
      resumes++;
      continue;
    }

    if (resp.stop_reason === 'pause_turn' && resumes >= MAX_RESUMES) {
      throw new Error('Anthropic call paused repeatedly without resolving; aborting to avoid an infinite loop.');
    }

    return resp;
  }
}

function extractText(resp) {
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ─── Step 1a: Cluster loaded queries ──────────────────────────────────────────
async function clusterQueries(queries) {
  const resp = await anthropicCall(
    [
      {
        role: 'user',
        content:
          `Assign each of the following search queries to a cluster based on search intent.\n\n` +
          `Cluster examples (use these or invent your own as appropriate):\n` +
          `Comparison Queries, Integration Queries, Enterprise Use Cases, Core Use Case, ` +
          `Collaboration, Reporting, Workflow Automation\n\n` +
          `Queries:\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n` +
          `Return ONLY a valid JSON array with all ${queries.length} queries:\n` +
          `[{"query": "...", "cluster": "..."}, ...]\n\n` +
          `No explanation, no markdown.`,
      },
    ],
    { model: ANTHROPIC_MODEL, maxTokens: 4000 }
  );

  const text = extractText(resp);
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      if (Array.isArray(result) && result.length > 0) return result;
    } catch {
      /* fall through */
    }
  }
  throw new Error('Failed to parse clustered queries from Claude response');
}

// ─── Step 1b: Auto-generate queries via web research ──────────────────────────
async function researchProduct(url) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const prompt =
    `You are a GEO (Generative Engine Optimization) specialist. Research the product at ${url}.\n\n` +
    `Visit and read:\n` +
    `- Homepage (${url})\n` +
    `- Pricing page if it exists\n` +
    `- Product/features pages if they exist\n` +
    `- Solutions/use-case pages if they exist\n` +
    `- 2–3 case studies or customer stories if they exist\n\n` +
    `Return your response in this exact format:\n\n` +
    `Official brand name: <the exact brand or product name as it appears in the page title or og:title tag>\n\n` +
    `Then a structured summary of at most 500 tokens covering:\n` +
    `1. Product category\n` +
    `2. Key features\n` +
    `3. Target customers\n` +
    `4. Main use cases\n` +
    `5. Case study problems solved\n` +
    `6. Key differentiators\n\n` +
    `Plain text only. No JSON, no markdown headers.`;

  const resp = await anthropicCall([{ role: 'user', content: prompt }], {
    model: ANTHROPIC_MODEL,
    maxTokens: 650,
    tools,
    betaHeader: 'web-search-2025-03-05',
  });

  const text = extractText(resp);
  const nameMatch = text.match(/^Official brand name:\s*(.+)/im);
  const officialBrandName = nameMatch ? nameMatch[1].trim() : null;
  const summary = text.replace(/^Official brand name:.*\n?/im, '').trim();

  return { summary, officialBrandName };
}

async function fetchOfficialBrandName(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogTitle =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogTitle) return ogTitle[1].trim();
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title) return title[1].trim();
  } catch {
    /* ignore */
  }
  return null;
}

async function generateQueries(url) {
  const { summary, officialBrandName } = await researchProduct(url);

  const prompt =
    `You are a GEO (Generative Engine Optimization) specialist.\n\n` +
    `Here is a structured summary of the product:\n\n${summary}\n\n` +
    `Generate exactly 30 bottom-of-funnel search queries split as follows:\n` +
    `- 10 queries based on the company's own positioning and marketing language\n` +
    `- 10 queries based on real customer problems and use cases\n` +
    `- 4 queries based on specific problems solved in case studies (if fewer exist, use additional problem-based queries)\n` +
    `- 6 queries based on your judgment: comparison intent, integration intent, buyer evaluation intent, enterprise concerns, missing positioning opportunities, etc.\n\n` +
    `Also assign each query a cluster based on intent. Cluster examples:\n` +
    `Comparison Queries, Integration Queries, Enterprise Use Cases, Core Use Case, ` +
    `Collaboration, Reporting, Workflow Automation\n\n` +
    `Hard rules:\n` +
    `- Zero branded keywords — no company name, product name, or any variation\n` +
    `- No company names of any kind\n` +
    `- No how-to phrasing\n` +
    `- High purchase intent — someone ready to evaluate or buy\n` +
    `- Natural language, 3–8 words per query\n\n` +
    `Return ONLY a valid JSON array of exactly 30 objects. No explanation, no markdown.\n` +
    `[{"query": "...", "cluster": "..."}, ...]`;

  const resp = await anthropicCall([{ role: 'user', content: prompt }], {
    model: ANTHROPIC_MODEL,
    maxTokens: 4000,
  });

  const text = extractText(resp);
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      if (Array.isArray(result) && result.length > 0) {
        return { queriesWithClusters: result, officialBrandName };
      }
    } catch {
      /* fall through */
    }
  }
  throw new Error('Failed to parse generated queries from Claude response');
}

// ─── Step 2: Citation detection (no LLM calls) ────────────────────────────────
function detectCitation(text, brandName) {
  const re = brandRegex(brandName);
  if (!re.test(text)) {
    return { cited: false, citationType: 'MISSED', evidence: '' };
  }

  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const evidenceSentences = sentences.filter((s) => re.test(s));
  const evidence = evidenceSentences.slice(0, 2).join(' ').trim();

  const strongRe =
    /\b(recommend(?:ed)?|suggest(?:ed)?|best|top|ideal|perfect|option|alternative|great|excellent|strong choice|worth considering)\b/i;
  const softRe =
    /\b(used by|trusted by|popular among|known for|designed for|built for|leading|widely used|commonly used|recognized for|chosen by|adopted by|preferred by)\b/i;

  if (strongRe.test(evidence)) return { cited: true, citationType: 'STRONG', evidence };
  if (softRe.test(evidence)) return { cited: true, citationType: 'SOFT', evidence };
  return { cited: false, citationType: 'MENTION', evidence };
}

// ─── Step 2: Competitor extraction (Claude-powered) ──────────────────────────
async function extractCompetitorsWithClaude(queryResults) {
  const allText = queryResults
    .flatMap((r) => PROVIDERS.map((p) => r[p.key]?.rawText || ''))
    .filter(Boolean)
    .join('\n\n---\n\n');

  const prompt =
    'Here are AI model responses to various queries. Extract ONLY brand names, product names, ' +
    'software tool names, and company names. Do not include generic English words, verbs, ' +
    'adjectives, technical acronyms, or common nouns. Return a JSON object where keys are the ' +
    'extracted brand/product names and values are the number of times they appear across all ' +
    'responses.\n\nResponses:\n' +
    allText;

  const resp = await anthropicCall([{ role: 'user', content: prompt }], {
    model: ANTHROPIC_MODEL,
    maxTokens: 2000,
  });

  const text = extractText(resp);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

// ─── Step 2: Model calls ──────────────────────────────────────────────────────
async function checkClaude(query) {
  const resp = await anthropicCall([{ role: 'user', content: query }], {
    model: ANTHROPIC_MODEL,
    maxTokens: 700,
  });
  return extractText(resp);
}

async function checkGPT(query) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_completion_tokens: 700,
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function checkGemini(query) {
  const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('\n').trim();
}

async function checkPerplexity(query) {
  const res = await fetch(`${PERPLEXITY_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// Maps provider key -> the function that runs that provider's check.
// Adding a 5th provider later means adding one entry here and one entry
// in the PROVIDERS list above; nothing else in the pipeline needs to change.
const CHECK_FNS = {
  claude: checkClaude,
  gpt: checkGPT,
  gemini: checkGemini,
  perplexity: checkPerplexity,
};

// ─── Step 3: Coverage map (pure logic) ───────────────────────────────────────
function buildCoverageMap(queryResults) {
  const WEIGHTS = { STRONG: 1.0, SOFT: 0.75, MENTION: 0.25, MISSED: 0 };
  const clusters = {};

  for (const r of queryResults) {
    const cl = r.cluster || 'Uncategorized';
    if (!clusters[cl]) {
      clusters[cl] = { total: 0 };
      for (const p of PROVIDERS) {
        clusters[cl][`${p.key}Cited`] = 0;
        clusters[cl][`${p.key}Weighted`] = 0;
        clusters[cl][`${p.key}Mentions`] = 0;
      }
    }
    const c = clusters[cl];
    c.total++;
    for (const p of PROVIDERS) {
      const citation = r[p.key];
      if (!citation) continue;
      c[`${p.key}Weighted`] += WEIGHTS[citation.citationType] || 0;
      if (citation.citationType === 'STRONG' || citation.citationType === 'SOFT') {
        c[`${p.key}Cited`]++;
      }
      if (citation.citationType === 'MENTION') c[`${p.key}Mentions`]++;
    }
  }

  const map = {};
  for (const [cl, d] of Object.entries(clusters)) {
    const entry = { total: d.total };
    let combinedCited = 0;
    for (const p of PROVIDERS) {
      entry[`${p.key}Pct`] = Math.round((d[`${p.key}Cited`] / d.total) * 100);
      entry[`${p.key}WeightedPct`] = Math.round((d[`${p.key}Weighted`] / d.total) * 100);
      entry[`${p.key}Mentions`] = d[`${p.key}Mentions`];
      combinedCited += d[`${p.key}Cited`];
    }
    entry.combinedPct = Math.round((combinedCited / (d.total * PROVIDERS.length)) * 100);
    map[cl] = entry;
  }
  return map;
}

// ─── Step 4: Competitor intelligence ─────────────────────────────────────────
function buildCompetitorIntelligence(freqMap, queryResults, brandName) {
  const entries = Object.entries(freqMap).filter(([, count]) => count >= 2);
  const totalAppearances = entries.reduce((s, [, c]) => s + c, 0);
  const brandRe = new RegExp(brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, frequency]) => {
      const nameRe = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const clusterCounts = {};
      let appearsWithBrand = 0;

      for (const r of queryResults) {
        const texts = PROVIDERS.map((p) => r[p.key]?.rawText || '');
        const cl = r.cluster || 'Uncategorized';
        let seenInQuery = false;

        for (const text of texts) {
          if (!nameRe.test(text)) continue;
          seenInQuery = true;
          if (brandRe.test(text)) appearsWithBrand++;
        }

        if (seenInQuery) clusterCounts[cl] = (clusterCounts[cl] || 0) + 1;
      }

      const dominatesClusters = Object.entries(clusterCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([c]) => c);

      return {
        name,
        frequency,
        shareOfVoice: totalAppearances > 0 ? Math.round((frequency / totalAppearances) * 100) : 0,
        dominatesClusters,
        appearsWithBrand,
      };
    });
}

// ─── Step 5: Diagnosis ────────────────────────────────────────────────────────
async function runDiagnosis(brandName, url, queryResults, coverageMap, competitors, scores) {
  const collectByType = (type) =>
    queryResults
      .flatMap((r) =>
        PROVIDERS.map((p) => {
          const c = r[p.key];
          return c && c.citationType === type && c.evidence
            ? `[${p.label}] "${r.query}": ${c.evidence}`
            : null;
        })
      )
      .filter(Boolean);

  const strongEvidence = collectByType('STRONG');
  const softEvidence = collectByType('SOFT');
  const mentionCtx = collectByType('MENTION');

  const missed = queryResults
    .filter((r) => PROVIDERS.every((p) => r[p.key]?.citationType === 'MISSED'))
    .map((r) => r.query);

  const coverageText = Object.entries(coverageMap)
    .map(
      ([cl, d]) =>
        `  ${cl}: ` +
        PROVIDERS.map((p) => `${p.label} ${d[`${p.key}Pct`]}%`).join(', ') +
        ` (${d.total} queries)`
    )
    .join('\n');

  const competitorText = competitors
    .slice(0, 10)
    .map(
      (c) =>
        `  ${c.name}: ${c.shareOfVoice}% SOV, dominates [${c.dominatesClusters.join(', ')}], ` +
        `appears with brand: ${c.appearsWithBrand}`
    )
    .join('\n');

  const resp = await anthropicCall(
    [
      {
        role: 'user',
        content:
          `You are a GEO (Generative Engine Optimization) expert analyzing brand visibility for "${brandName}" (${url}).\n\n` +
          `Models tested: ${PROVIDERS.map((p) => p.label).join(', ')}\n\n` +
          `RAW VISIBILITY SCORE: ${scores.rawVisibility}%\n` +
          `WEIGHTED VISIBILITY SCORE: ${scores.weightedVisibility}%\n\n` +
          `COVERAGE MAP BY CLUSTER:\n${coverageText}\n\n` +
          `COMPETITOR SHARE OF VOICE:\n${competitorText || '  (none identified)'}\n\n` +
          `STRONG CITATIONS (${strongEvidence.length}):\n` +
          (strongEvidence.slice(0, 6).join('\n') || '  (none)') +
          '\n\n' +
          `SOFT CITATIONS (${softEvidence.length}):\n` +
          (softEvidence.slice(0, 6).join('\n') || '  (none)') +
          '\n\n' +
          `MENTIONS — brand appears but not recommended (${mentionCtx.length}):\n` +
          (mentionCtx.slice(0, 6).join('\n') || '  (none)') +
          '\n\n' +
          `QUERIES MISSED BY ALL MODELS (${missed.length}):\n` +
          (missed.map((q) => `  • ${q}`).join('\n') || '  (none)') +
          '\n\n' +
          `Return ONLY a valid JSON object — no explanation, no markdown:\n` +
          `{\n` +
          `  "findings": [\n` +
          `    {\n` +
          `      "finding": "Short title",\n` +
          `      "evidence": "What the data shows",\n` +
          `      "impact": "Why this matters",\n` +
          `      "recommendation": "Specific actionable fix",\n` +
          `      "opportunityScore": { "visibilityGap": "HIGH|MEDIUM|LOW", "competitivePressure": "HIGH|MEDIUM|LOW", "easeOfFix": "HIGH|MEDIUM|LOW" }\n` +
          `    }\n` +
          `  ],\n` +
          `  "topActions": ["action 1", "action 2", "action 3"]\n` +
          `}\n\n` +
          `Provide 3–5 findings. Prioritize topActions by: high visibility gap + high competitive pressure + high ease of fix.`,
      },
    ],
    { model: ANTHROPIC_MODEL, maxTokens: 3000 }
  );

  const text = extractText(resp);
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const result = JSON.parse(match[0]);
      return { findings: result.findings || [], topActions: result.topActions || [] };
    } catch {
      /* fall through */
    }
  }
  return { findings: [], topActions: [] };
}

// ─── Step 6: Terminal Report ──────────────────────────────────────────────────
function printReport(brandName, url, queryResults, coverageMap, competitors, scores, diagnosis) {
  const cols = Math.min(process.stdout.columns || 80, 120);
  const rule = '─'.repeat(cols);
  const drule = '═'.repeat(cols);

  console.log('\n' + C.bold + C.cyan + drule + C.reset);
  console.log(C.bold + C.cyan + `  GEO VISIBILITY AUDIT  ·  ${brandName.toUpperCase()}` + C.reset);
  console.log(C.dim + `  ${url}` + C.reset);
  console.log(C.dim + `  Models: ${PROVIDERS.map((p) => p.label).join(', ')}` + C.reset);
  console.log(C.bold + C.cyan + drule + C.reset);

  console.log('\n' + C.bold + '  VISIBILITY SCORES' + C.reset);
  console.log('  ' + rule.slice(2));
  const rc = scoreColor(scores.rawVisibility);
  const wc = scoreColor(scores.weightedVisibility);
  console.log(
    `  Raw Visibility      ${rc}${C.bold}${String(scores.rawVisibility).padStart(3)}%${C.reset}  ` +
      `[${rc}${progressBar(scores.rawVisibility)}${C.reset}]  STRONG + SOFT citations only`
  );
  console.log(
    `  Weighted Visibility ${wc}${C.bold}${String(scores.weightedVisibility).padStart(3)}%${C.reset}  ` +
      `[${wc}${progressBar(scores.weightedVisibility)}${C.reset}]  STRONG×1.0, SOFT×0.75, MENTION×0.25`
  );

  console.log('\n' + C.bold + '  COVERAGE MAP BY CLUSTER' + C.reset);
  console.log('  ' + rule.slice(2));
  const maxCL = Math.max(...Object.keys(coverageMap).map((k) => k.length), 10);
  const header =
    `  ${'Cluster'.padEnd(maxCL + 2)}  ` +
    PROVIDERS.map((p) => p.label.padEnd(8)).join(' ') +
    `  Combined  Mentions`;
  console.log(C.dim + header + C.reset);
  console.log('  ' + rule.slice(2));
  for (const [cl, d] of Object.entries(coverageMap)) {
    const mentions = PROVIDERS.reduce((s, p) => s + d[`${p.key}Mentions`], 0);
    const perModel = PROVIDERS.map((p) => {
      const pct = d[`${p.key}Pct`];
      return `${scoreColor(pct)}${String(pct).padStart(3)}%${C.reset}   `;
    }).join(' ');
    console.log(
      `  ${cl.padEnd(maxCL + 2)}  ${perModel}  ` +
        `${scoreColor(d.combinedPct)}${String(d.combinedPct).padStart(3)}%${C.reset}    ` +
        (mentions > 0 ? `${C.yellow}${mentions} mention${mentions !== 1 ? 's' : ''}${C.reset}` : `${C.dim}─${C.reset}`)
    );
  }

  console.log('\n' + C.bold + '  QUERY RESULTS' + C.reset);
  console.log('  ' + rule.slice(2));
  const qHeader =
    `   #  ${'Cluster'.padEnd(22)}  ${'Query'.padEnd(30)}  ` + PROVIDERS.map((p) => p.label.padEnd(9)).join('');
  console.log(C.dim + qHeader + C.reset);
  console.log('  ' + rule.slice(2));

  queryResults.forEach((r, i) => {
    const num = String(i + 1).padStart(2);
    const cluster = trunc(r.cluster || '', 22).padEnd(22);
    const query = trunc(r.query, 30).padEnd(30);
    const statusCols = PROVIDERS.map((p) => {
      const ct = r[p.key]?.citationType || 'MISSED';
      return `${citationColor(ct)}${ct.padEnd(8)}${C.reset} `;
    }).join('');

    console.log(`  ${C.dim}${num}${C.reset}  ${cluster}  ${query}  ${statusCols}`);
    for (const p of PROVIDERS) {
      const ev = r[p.key]?.evidence;
      if (ev) console.log(`       ${C.dim}↳ ${p.label}: ${trunc(ev, cols - 15)}${C.reset}`);
    }
  });

  if (competitors.length > 0) {
    console.log('\n' + C.bold + '  COMPETITOR INTELLIGENCE' + C.reset);
    console.log('  ' + rule.slice(2));
    console.log(C.dim + `  ${'Competitor'.padEnd(18)}  SOV    Freq  W/Brand  Dominant Clusters` + C.reset);
    console.log('  ' + rule.slice(2));
    for (const comp of competitors.slice(0, 15)) {
      console.log(
        `  ${comp.name.padEnd(18)}  ` +
          `${String(comp.shareOfVoice).padStart(3)}%   ` +
          `${String(comp.frequency).padStart(4)}  ` +
          `${String(comp.appearsWithBrand).padStart(7)}  ` +
          `${C.dim}${comp.dominatesClusters.join(', ')}${C.reset}`
      );
    }
  }

  if (diagnosis.findings.length > 0) {
    console.log('\n' + C.bold + '  FINDINGS' + C.reset);
    console.log('  ' + rule.slice(2));
    diagnosis.findings.forEach((f, i) => {
      const os = f.opportunityScore || {};
      const vgc = os.visibilityGap === 'HIGH' ? C.red : os.visibilityGap === 'LOW' ? C.green : C.yellow;
      const cpc =
        os.competitivePressure === 'HIGH' ? C.red : os.competitivePressure === 'LOW' ? C.green : C.yellow;
      const efc = os.easeOfFix === 'HIGH' ? C.green : os.easeOfFix === 'LOW' ? C.red : C.yellow;
      console.log(`\n  ${C.bold}${i + 1}. ${f.finding}${C.reset}`);
      console.log(
        `     ${C.dim}Visibility Gap:${C.reset} ${vgc}${os.visibilityGap || '─'}${C.reset}  ` +
          `${C.dim}Competitive Pressure:${C.reset} ${cpc}${os.competitivePressure || '─'}${C.reset}  ` +
          `${C.dim}Ease of Fix:${C.reset} ${efc}${os.easeOfFix || '─'}${C.reset}`
      );
      if (f.evidence) console.log(wrap(`Evidence: ${f.evidence}`, cols, '     '));
      if (f.impact) console.log(wrap(`Impact: ${f.impact}`, cols, '     '));
      if (f.recommendation) console.log(wrap(`Rec: ${f.recommendation}`, cols, '     '));
    });
  }

  if (diagnosis.topActions.length > 0) {
    console.log('\n' + C.bold + '  TOP 3 ACTIONS THIS QUARTER' + C.reset);
    console.log('  ' + rule.slice(2));
    diagnosis.topActions.slice(0, 3).forEach((action, i) => {
      console.log(wrap(`${i + 1}. ${action}`, cols, '  '));
    });
  }

  console.log('\n' + C.bold + C.cyan + drule + C.reset);
  console.log(C.dim + `  Audit complete  ·  ${new Date().toLocaleString()}` + C.reset);
  console.log(C.bold + C.cyan + drule + C.reset + '\n');
}

// ─── Google Sheets Export (optional) ─────────────────────────────────────────
async function exportToSheets(brandName, url, queryResults, coverageMap, competitors, scores, diagnosis) {
  if (!SERVICE_ACCOUNT_FILE || !SHEET_ID) {
    return { skipped: true };
  }

  const { google } = await import('googleapis');

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(now.getDate()).padStart(2, '0');
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const baseTabName = `${capitalize(brandName)} · ${day} ${month} ${year}`;

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existingTitles = new Set(spreadsheet.data.sheets.map((s) => s.properties.title));

  let tabName = baseTabName;
  let version = 2;
  while (existingTitles.has(tabName)) {
    tabName = `${baseTabName} v${version}`;
    version++;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });

  const rows = [];

  rows.push(['GEO VISIBILITY AUDIT']);
  rows.push(['Brand', brandName]);
  rows.push(['URL', url]);
  rows.push(['Date', `${day} ${month} ${year}`]);
  rows.push(['Models tested', PROVIDERS.map((p) => p.label).join(', ')]);
  rows.push(['Raw Visibility Score', `${scores.rawVisibility}%`]);
  rows.push(['Weighted Visibility Score', `${scores.weightedVisibility}%`]);
  rows.push(['Total Queries', queryResults.length]);
  rows.push([]);

  rows.push(['QUERY RESULTS']);
  rows.push([
    '#',
    'Query',
    'Cluster',
    ...PROVIDERS.flatMap((p) => [`${p.label} Status`, `${p.label} Evidence`]),
  ]);
  queryResults.forEach((r, i) => {
    rows.push([
      i + 1,
      r.query,
      r.cluster || '',
      ...PROVIDERS.flatMap((p) => [r[p.key]?.citationType || 'MISSED', r[p.key]?.evidence || '']),
    ]);
  });
  rows.push([]);

  rows.push(['CLUSTER COVERAGE MAP']);
  rows.push([
    'Cluster',
    'Queries',
    ...PROVIDERS.flatMap((p) => [`${p.label} %`, `${p.label} Weighted %`, `${p.label} Mentions`]),
    'Combined %',
  ]);
  for (const [cl, d] of Object.entries(coverageMap)) {
    rows.push([
      cl,
      d.total,
      ...PROVIDERS.flatMap((p) => [d[`${p.key}Pct`], d[`${p.key}WeightedPct`], d[`${p.key}Mentions`]]),
      d.combinedPct,
    ]);
  }
  rows.push([]);

  rows.push(['COMPETITOR INTELLIGENCE']);
  rows.push(['Competitor', 'Frequency', 'Share of Voice %', 'Dominant Clusters', 'Appears With Brand']);
  for (const c of competitors) {
    rows.push([c.name, c.frequency, c.shareOfVoice, c.dominatesClusters.join(', '), c.appearsWithBrand]);
  }
  rows.push([]);

  rows.push(['FINDINGS']);
  rows.push(['#', 'Finding', 'Evidence', 'Impact', 'Recommendation', 'Visibility Gap', 'Competitive Pressure', 'Ease of Fix']);
  diagnosis.findings.forEach((f, i) => {
    const os = f.opportunityScore || {};
    rows.push([
      i + 1,
      f.finding,
      f.evidence || '',
      f.impact || '',
      f.recommendation || '',
      os.visibilityGap || '',
      os.competitivePressure || '',
      os.easeOfFix || '',
    ]);
  });
  rows.push([]);

  rows.push(['TOP 3 ACTIONS THIS QUARTER']);
  diagnosis.topActions.slice(0, 3).forEach((action, i) => rows.push([i + 1, action]));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  return { skipped: false, tabName };
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { url: null, queriesFile: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--queries' && rest[i + 1]) {
      args.queriesFile = rest[++i];
    } else if (!args.url) {
      args.url = rest[i];
    }
  }
  return args;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { url, queriesFile } = parseArgs(process.argv);
  if (!url) {
    console.error(`\n${C.red}${C.bold}Error:${C.reset} Please provide a URL.\n`);
    console.error('  Usage: node geo-audit.js <url> [--queries queries.txt]');
    console.error('  Example: node geo-audit.js https://linear.app --queries queries.txt');
    console.error('  Example: node geo-audit.js https://linear.app   (auto-generates 30 queries)\n');
    process.exit(1);
  }

  let brandName = extractBrand(url);
  const cols = Math.min(process.stdout.columns || 80, 120);
  const drule = '═'.repeat(cols);

  console.log('\n' + C.bold + C.cyan + drule + C.reset);
  console.log(C.bold + C.cyan + `  GEO VISIBILITY AUDIT  ·  Starting audit for ${url}` + C.reset);
  console.log(C.dim + `  Models in this run: ${PROVIDERS.map((p) => p.label).join(', ')}` + C.reset);
  console.log(C.bold + C.cyan + drule + C.reset);

  let queriesWithClusters;

  if (queriesFile) {
    console.log(C.bold + `[1/5] Loading queries from ${queriesFile}...` + C.reset);
    let rawQueries;
    try {
      const { readFileSync } = await import('fs');
      rawQueries = readFileSync(queriesFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (rawQueries.length === 0) throw new Error('File contains no valid queries');
      console.log(C.green + `      ✓ Loaded ${rawQueries.length} queries` + C.reset);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`\n${C.red}${C.bold}Error:${C.reset} Could not find queries file at ${queriesFile}.\n`);
      } else {
        console.error(C.red + `      ✗ ${err.message}` + C.reset);
      }
      process.exit(1);
    }

    process.stdout.write(C.bold + '      Fetching official brand name...' + C.reset + '\r');
    const fetchedName = await fetchOfficialBrandName(url);
    if (fetchedName) brandName = fetchedName;

    process.stdout.write(C.bold + '      Assigning clusters...              ' + C.reset + '\n');
    try {
      queriesWithClusters = await clusterQueries(rawQueries);
      const clusterCount = new Set(queriesWithClusters.map((q) => q.cluster)).size;
      console.log(C.green + `      ✓ Assigned to ${clusterCount} clusters` + C.reset);
    } catch (err) {
      console.error(C.red + `      ✗ Clustering failed: ${err.message}` + C.reset);
      process.exit(1);
    }
  } else {
    console.log(C.bold + `[1/5] Researching ${url} to generate 30 queries...` + C.reset);
    try {
      const result = await generateQueries(url);
      queriesWithClusters = result.queriesWithClusters;
      if (result.officialBrandName) brandName = result.officialBrandName;
      const clusterCount = new Set(queriesWithClusters.map((q) => q.cluster)).size;
      console.log(
        C.green + `      ✓ Generated ${queriesWithClusters.length} queries across ${clusterCount} clusters` + C.reset
      );
    } catch (err) {
      console.error(C.red + `      ✗ Query generation failed: ${err.message}` + C.reset);
      process.exit(1);
    }
  }

  console.log(C.dim + `\n  Brand: ${C.reset}${C.bold}${brandName}${C.reset}\n`);

  console.log(C.bold + `\n[2/5] Testing visibility across ${queriesWithClusters.length} queries...` + C.reset);
  console.log(C.dim + `      Running each query through ${PROVIDERS.map((p) => p.model).join(', ')}\n` + C.reset);

  const queryResults = [];

  for (let i = 0; i < queriesWithClusters.length; i++) {
    const { query, cluster } = queriesWithClusters[i];
    process.stdout.write(`  ${C.dim}(${i + 1}/${queriesWithClusters.length})${C.reset} ${trunc(query, cols - 14)}\n`);

    const settled = await Promise.allSettled(PROVIDERS.map((p) => CHECK_FNS[p.key](query)));

    const entry = { query, cluster };
    const statusParts = [];

    settled.forEach((result, idx) => {
      const p = PROVIDERS[idx];
      if (result.status === 'rejected') {
        console.error(C.red + `       ${p.label} error: ${result.reason?.message}` + C.reset);
      }
      const text = result.status === 'fulfilled' ? result.value : '';
      const citation = detectCitation(text, brandName);
      entry[p.key] = { ...citation, rawText: text };
      statusParts.push(`${p.label}: ${citationColor(citation.citationType)}${citation.citationType}${C.reset}`);
    });

    queryResults.push(entry);
    process.stdout.write(`       ${statusParts.join('  ')}\n`);
  }

  console.log(C.bold + '\n[3/5] Building coverage map...' + C.reset);
  const coverageMap = buildCoverageMap(queryResults);
  console.log(C.green + `      ✓ ${Object.keys(coverageMap).length} clusters` + C.reset);

  console.log(C.bold + '\n[4/5] Aggregating competitor intelligence...' + C.reset);
  const competitorFreqMap = await extractCompetitorsWithClaude(queryResults);
  const competitors = buildCompetitorIntelligence(competitorFreqMap, queryResults, brandName);
  console.log(C.green + `      ✓ ${competitors.length} competitors identified` + C.reset);

  const WEIGHTS = { STRONG: 1.0, SOFT: 0.75, MENTION: 0.25, MISSED: 0 };
  let citations = 0,
    weightedSum = 0;
  const totalOpps = queryResults.length * PROVIDERS.length;
  for (const r of queryResults) {
    for (const p of PROVIDERS) {
      const ct = r[p.key]?.citationType;
      if (ct === 'STRONG' || ct === 'SOFT') citations++;
      weightedSum += WEIGHTS[ct] || 0;
    }
  }
  const scores = {
    rawVisibility: Math.round((citations / totalOpps) * 100),
    weightedVisibility: Math.round((weightedSum / totalOpps) * 100),
    citations,
    totalOpps,
  };

  console.log(C.bold + '\n[5/5] Running diagnosis...' + C.reset);
  let diagnosis = { findings: [], topActions: [] };
  try {
    diagnosis = await runDiagnosis(brandName, url, queryResults, coverageMap, competitors, scores);
    console.log(C.green + `      ✓ ${diagnosis.findings.length} findings, ${diagnosis.topActions.length} top actions` + C.reset);
  } catch (err) {
    console.error(C.yellow + `      ⚠ Diagnosis failed: ${err.message}` + C.reset);
  }

  printReport(brandName, url, queryResults, coverageMap, competitors, scores, diagnosis);

  const inputCost = (totalInputTokens / 1_000_000) * 3;
  const outputCost = (totalOutputTokens / 1_000_000) * 15;
  console.log(
    C.dim +
      `  Estimated Anthropic API cost: ~$${(inputCost + outputCost).toFixed(2)}` +
      `  (${totalInputTokens.toLocaleString()} input · ${totalOutputTokens.toLocaleString()} output tokens)` +
      `  — other providers billed separately by their own usage.` +
      C.reset +
      '\n'
  );

  try {
    process.stdout.write(C.dim + '  Exporting results to Google Sheets...' + C.reset);
    const result = await exportToSheets(brandName, url, queryResults, coverageMap, competitors, scores, diagnosis);
    if (result.skipped) {
      console.log(
        '\r' +
          C.dim +
          '  Skipped Google Sheets export (GOOGLE_SERVICE_ACCOUNT_FILE / GOOGLE_SHEET_ID not set).' +
          C.reset +
          '\n'
      );
    } else {
      console.log('\r' + C.green + `  ✓ Exported to sheet tab: "${result.tabName}"` + C.reset + '\n');
    }
  } catch (err) {
    console.log('\r' + C.yellow + `  ⚠ Sheets export failed: ${err.message}` + C.reset + '\n');
  }
}

main().catch((err) => {
  console.error(`\n${C.red}${C.bold}Fatal error:${C.reset} ${err.message}\n`);
  process.exit(1);
});
