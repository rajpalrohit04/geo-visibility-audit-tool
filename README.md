# GEO Visibility Audit

A command-line tool that checks whether a brand shows up in AI-generated answers across Claude, GPT, Gemini, and Perplexity.

Regular SEO tools tell you where you rank on Google. This tells you something Google Search Console can't: when someone asks an AI model a buyer-intent question in your category, does your brand come up, and how strongly?

You give it a URL. It researches the site, writes a set of realistic non-branded buyer queries, runs every one through the models you have keys for, and scores whether your brand is actively recommended, mentioned in passing, or missing entirely. Then it builds a visibility score, a coverage map by query intent, a competitor table, and a short list of prioritized fixes.

It's free. You bring your own API keys and only pay your own usage.

## What it does

For a given URL, the tool will:

1. **Research the site** (using Claude with web search) and pull out what the product does, who it's for, and its differentiators.
2. **Generate 30 buyer-intent queries** with zero brand names in them, split across positioning, customer problems, case-study pain points, and comparison/evaluation intent. Each query is tagged with an intent cluster.
3. **Run every query** through Claude, GPT, and (optionally) Gemini and Perplexity.
4. **Score each answer** as STRONG (recommended), SOFT (named as trusted/used), MENTION (named in passing), or MISSED (absent).
5. **Build the report**: raw and weighted visibility scores, a coverage map broken down by intent cluster, and a competitor share-of-voice table.
6. **Diagnose and prioritize**: hands everything back to Claude for a set of findings and a top-3 action list, each scored by visibility gap, competitive pressure, and ease of fix.

Output prints to your terminal, and optionally exports to a Google Sheet.

## Requirements

- Node.js 18 or newer
- An Anthropic API key (required)
- An OpenAI API key (required)
- A Gemini and/or Perplexity API key (optional)

Claude and GPT are the baseline. Gemini and Perplexity only run if you add their keys; otherwise they're skipped with no errors.

## Setup

Clone the repo and install dependencies:

```bash
git clone https://github.com/rajpalrohit04/geo-visibility-audit-tool.git
cd geo-visibility-audit-tool
npm install
```

Copy the example env file and add your keys:

```bash
cp .env.example .env
```

Open `.env` and fill in the keys you have:

```
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key

# optional
GEMINI_API_KEY=
PERPLEXITY_API_KEY=
```

Your `.env` is gitignored, so your keys never get committed.

## Usage

Run it against any URL. The tool researches the site and writes its own queries:

```bash
node geo-audit.js https://www.example.com
```

If you'd rather supply your own queries, pass a text file with one query per line:

```bash
node geo-audit.js https://www.example.com --queries your-queries.txt
```

With your own file, the tool skips the research/generation step but still sorts each query into an intent cluster.

## Output

The terminal report has five sections:

- **Visibility scores** — raw (STRONG + SOFT only) and weighted (STRONG ×1.0, SOFT ×0.75, MENTION ×0.25).
- **Coverage map by cluster** — per-model visibility for each intent cluster, so you can see which buyer intents you own and which you've lost.
- **Query results** — every query, with each model's score and a snippet of the evidence.
- **Competitor intelligence** — every other brand the models named, ranked by share of voice. Note this can include infrastructure (Stripe, Node.js, etc.) the models mention alongside real competitors.
- **Findings and top actions** — diagnosed problems and a prioritized fix list.

## Optional: Google Sheets export

To push results into a Google Sheet, add these to your `.env`:

```
GOOGLE_SERVICE_ACCOUNT_FILE=path/to/service-account.json
GOOGLE_SHEET_ID=your-sheet-id
```

You'll need a [Google service account](https://developers.google.com/workspace/guides/create-credentials) with the Sheets API enabled, and the target sheet shared with the service account's email. Leave both blank to skip the export; the terminal report still runs in full.

## Models

Defaults can be overridden in `.env`:

| Provider | Env var | Default |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |
| OpenAI | `OPENAI_MODEL` | `gpt-5.4-mini` |
| Gemini | `GEMINI_MODEL` | `gemini-2.5-flash` |
| Perplexity | `PERPLEXITY_MODEL` | `sonar` |

## A note on cost

Each run makes a number of API calls: site research, query generation, the per-query checks across every active model, competitor extraction, and the final diagnosis. A full 30-query run across two models is usually a few cents to a couple of dollars depending on the models you pick. The terminal output prints an estimated Anthropic cost at the end; other providers bill separately under their own usage.

## License

MIT
