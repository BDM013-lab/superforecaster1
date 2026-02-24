// ─────────────────────────────────────────────────────────────────────────────
// Superforecaster Server
// Runs the training loop in the background, saves state to disk,
// and serves a web UI + REST API for asking questions.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const path    = require("path");
const fetch   = require("node-fetch");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Postgres connection — Railway injects DATABASE_URL automatically
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────────────────────
// STATE — persisted to disk
// ─────────────────────────────────────────────────────────────────────────────
let state = {
  principles:   [],
  domainBiases: {},
  history:      [],
  completedIds: [],
  framework:    null,
  log:          [],
  isTraining:   false,
  currentQ:     null,
  trainPhase:   "idle",
};

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE — creates table on first run, persists state forever
// ─────────────────────────────────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS superforecaster_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function loadState() {
  try {
    await initDB();
    const result = await db.query("SELECT key, value FROM superforecaster_state");
    if (result.rows.length > 0) {
      const saved = {};
      for (const row of result.rows) {
        saved[row.key] = JSON.parse(row.value);
      }
      if (saved.principles)   state.principles   = saved.principles;
      if (saved.domainBiases) state.domainBiases  = saved.domainBiases;
      if (saved.history)      state.history       = saved.history;
      if (saved.completedIds) state.completedIds  = saved.completedIds;
      if (saved.framework)    state.framework     = saved.framework;
      addLog(`Loaded from database: ${state.history.length} sessions, ${state.principles.length} principles.`, "success");
    } else {
      addLog("No saved state found — starting fresh.", "info");
    }
  } catch (e) {
    addLog(`Could not load from database: ${e.message}`, "warn");
  }
}

async function saveState() {
  try {
    const toSave = {
      principles:   state.principles,
      domainBiases: state.domainBiases,
      history:      state.history.slice(-500),
      completedIds: state.completedIds,
      framework:    state.framework,
    };
    for (const [key, value] of Object.entries(toSave)) {
      await db.query(
        `INSERT INTO superforecaster_state (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }
  } catch (e) {
    addLog(`Database save error: ${e.message}`, "error");
  }
}

function addLog(msg, type = "info") {
  const entry = { msg, type, ts: new Date().toISOString() };
  state.log.push(entry);
  if (state.log.length > 300) state.log = state.log.slice(-200);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC TRAINING QUESTION GENERATION
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_CONTEXTS = {
  "Telecommunications": [
    { asOf: "2016-01-01", focus: "AT&T/DirecTV integration, T-Mobile uncarrier moves, cord-cutting early wave, Sprint losses mounting" },
    { asOf: "2018-06-01", focus: "AT&T/Time Warner DOJ fight, Sprint/T-Mobile renewed merger, 5G spectrum auctions beginning" },
    { asOf: "2020-01-01", focus: "T-Mobile/Sprint merger closing, DISH spectrum commitments, 5G launches, COVID broadband surge" },
    { asOf: "2022-01-01", focus: "DISH network buildout deadlines, C-band rollout, cable-wireless convergence, telecom M&A slowdown" },
  ],
  "Media": [
    { asOf: "2016-06-01", focus: "Netflix international expansion, CBS All Access launch, AT&T/Time Warner announced, Verizon/Yahoo" },
    { asOf: "2018-01-01", focus: "Disney/Fox acquisition, Netflix vs HBO spending war, Pandora/Sirius merger, skinny bundle failures" },
    { asOf: "2020-06-01", focus: "COVID theater closures, Disney+/HBO Max/Peacock launches, Quibi launch, streaming subscriber surge" },
    { asOf: "2022-06-01", focus: "Netflix subscriber loss, Warner/Discovery merger, Paramount+ struggles, CNN+ shutdown, ad tiers" },
    { asOf: "2023-06-01", focus: "Hollywood strikes, streaming profitability pressure, Paramount sale talks, password sharing crackdowns" },
  ],
  "Technology": [
    { asOf: "2016-01-01", focus: "Uber growth vs regulation, Apple iPhone supercycle concerns, Twitter stagnation, Yahoo sale process" },
    { asOf: "2018-06-01", focus: "Facebook Cambridge Analytica fallout, Snap struggles, cloud wars, GDPR impact, China rivalry" },
    { asOf: "2020-01-01", focus: "WeWork collapse, Uber/Lyft post-IPO, TikTok rise, antitrust scrutiny, COVID tech boom" },
    { asOf: "2021-06-01", focus: "SPAC boom/bust, chip shortages, Apple privacy changes, crypto boom, metaverse hype" },
    { asOf: "2023-01-01", focus: "ChatGPT/AI boom, Meta metaverse retreat, layoffs wave, cloud slowdown, TikTok ban threats" },
  ],
  "Live Events": [
    { asOf: "2017-01-01", focus: "Live Nation dominance, Fyre Festival fallout, esports investment, sports rights inflation" },
    { asOf: "2020-06-01", focus: "COVID concert shutdowns, venue bankruptcies, virtual events, Ticketmaster antitrust scrutiny" },
    { asOf: "2022-01-01", focus: "Live events recovery, Taylor Swift/Ticketmaster meltdown, Astroworld liability, festival oversupply" },
  ],
  "Parks": [
    { asOf: "2017-01-01", focus: "Disney Shanghai ramp-up, Universal Harry Potter success, SeaWorld Blackfish recovery, pricing power" },
    { asOf: "2020-06-01", focus: "COVID park closures, Disney Genie+ rollout controversy, capacity limits, Universal Epic Universe" },
    { asOf: "2022-01-01", focus: "Park attendance recovery, Disney pricing backlash, DeSantis/Disney dispute, Cedar Fair/Six Flags" },
  ],
};

const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const recentDomains = [];

async function generateTrainingQuestion() {
  const allDomains = Object.keys(DOMAIN_CONTEXTS);
  const available  = allDomains.filter(d => !recentDomains.slice(-3).includes(d));
  const domain     = (available.length > 0 ? available : allDomains)[Math.floor(Math.random() * (available.length > 0 ? available.length : allDomains.length))];
  recentDomains.push(domain);
  if (recentDomains.length > 10) recentDomains.shift();

  const contexts   = DOMAIN_CONTEXTS[domain];
  const ctx        = contexts[Math.floor(Math.random() * contexts.length)];
  const difficulty = DIFFICULTIES[Math.floor(Math.random() * DIFFICULTIES.length)];

  addLog(`   📝 Generating ${difficulty} ${domain} question (as of ${ctx.asOf})...`, "muted");

  const raw = await callClaude(`You are designing a training question for a superforecasting system. Generate ONE specific historical binary (yes/no) question about the TMT industry.

DOMAIN: ${domain}
AS-OF DATE: ${ctx.asOf} (forecaster only knows info up to this date)
PERIOD CONTEXT: ${ctx.focus}
DIFFICULTY: ${difficulty} — ${ difficulty === "Easy" ? "outcome was fairly predictable given context" : difficulty === "Medium" ? "outcome was genuinely uncertain with arguments both ways" : "outcome was surprising or went against consensus at the time" }

Rules:
- Question MUST have definitively resolved YES or NO by early 2025
- Name a specific company, metric, or event
- Resolution date should be 6-18 months after ${ctx.asOf}
- Context must only contain information knowable as of ${ctx.asOf}
- Do NOT generate questions about Netflix subscriber counts (they stopped reporting them)

Respond ONLY as valid JSON with no markdown or backticks:
{"domain":"${domain}","difficulty":"${difficulty}","asOf":"${ctx.asOf}","q":"Will [company] [specific action] by [date]?","context":"3-4 sentences of factual context as of ${ctx.asOf}","outcome":true,"resolution":"One sentence: what actually happened and when."}`, 600, "claude-haiku-4-5");

  const q = safeParseJSON(raw);
  if (!q || !q.q || q.outcome === undefined) throw new Error(`Bad generated question: ${JSON.stringify(q)}`);
  q.id = Date.now();
  return q;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────────────────────
const brier = (p, outcome) => Math.pow(p - (outcome ? 1 : 0), 2);

// ─────────────────────────────────────────────────────────────────────────────
// LIVE QUESTION SYSTEM
// Generates forward-looking TMT questions, forecasts them, waits for resolution,
// then scores them exactly like historical training — real out-of-sample learning.
// ─────────────────────────────────────────────────────────────────────────────
async function initLiveQuestionsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS live_questions (
      id SERIAL PRIMARY KEY,
      domain TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT NOT NULL,
      resolution_date DATE NOT NULL,
      forecast_probability REAL,
      forecast_reasoning TEXT,
      outcome BOOLEAN,
      resolution TEXT,
      brier_score REAL,
      principle TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
}

async function generateLiveQuestions(existingQuestions) {
  const today = new Date().toISOString().split("T")[0];
  const in30  = new Date(Date.now() + 30  * 86400000).toISOString().split("T")[0];
  const in60  = new Date(Date.now() + 60  * 86400000).toISOString().split("T")[0];
  const in90  = new Date(Date.now() + 90  * 86400000).toISOString().split("T")[0];

  // Step 1: Search for current TMT news to ground question generation in reality
  addLog("   🔍 Searching for current TMT news to generate grounded questions...", "info");
  let currentNews = "";
  try {
    currentNews = await searchCurrentNews("TMT media technology telecom M&A earnings deals 2026");
  } catch(e) {
    addLog("   ⚠ News search failed, generating without live context", "warn");
  }

  // Build list of existing questions to avoid duplicates
  const existingList = existingQuestions && existingQuestions.length > 0
    ? `
AVOID duplicating these existing questions:
    ? "\nAVOID duplicating these existing questions:\n" + existingQuestions.map(q => "- " + q).join("\n")
")}`
    : "";

  const raw = await callClaude(`You are a superforecasting question designer. Today is ${today}.

CURRENT TMT NEWS (use this to generate grounded, accurate questions):
${currentNews}

Generate 9 specific, binary (yes/no), verifiable forecasting questions about TMT companies that:
1. Have NOT yet resolved as of today ${today}
2. Will definitively resolve by the target date shown
3. Are about real, named companies with specific measurable outcomes
4. Are grounded in the current news above — do not invent metrics that companies no longer report
5. Cover different companies and domains
${existingList}

IMPORTANT: Only ask about metrics companies actually report publicly. For example, Netflix no longer reports subscriber counts — ask about revenue or operating income instead.

Spread questions across these resolution windows (3 questions each):
- Short term (resolves by ${in30}): 3 questions
- Medium term (resolves by ${in60}): 3 questions  
- Long term (resolves by ${in90}): 3 questions

Respond ONLY in a JSON array of 9 objects, each with this shape:
{"domain":"Media|Technology|Telecommunications|Live Events|Parks","question":"Will [company] [specific action] by [date]?","context":"2-3 sentences of current context","resolution_date":"YYYY-MM-DD"}`, 3000);

  const questions = safeParseJSON(raw);
  if (!Array.isArray(questions)) throw new Error("Expected array of questions");
  return questions;
}

async function forecastLiveQuestion(liveQ) {
  // Search for current context then forecast
  const bias = state.domainBiases[liveQ.domain] || 0;
  const biasNote = Math.abs(bias) > 0.02
    ? `\nCALIBRATION: You have been ${bias > 0 ? "overconfident" : "underconfident"} in ${liveQ.domain} by ~${Math.abs(bias * 100).toFixed(0)}pp.`
    : "";
  const principles = state.principles.slice(-6).map((p, i) => `${i+1}. ${p}`).join("\n");

  const raw = await callClaude(`You are a superforecaster. Today: ${new Date().toISOString().split("T")[0]}
${principles ? "\nLEARNED PRINCIPLES:\n" + principles : ""}${biasNote}

QUESTION: ${liveQ.question}
CONTEXT: ${liveQ.context}
DOMAIN: ${liveQ.domain}
RESOLVES BY: ${liveQ.resolution_date}

CRITICAL: This event has NOT yet occurred. Do not assume it has resolved. Forecast the probability it will happen by the resolution date.

Use outside view → inside view → steelman → calibrated probability.

Respond ONLY in JSON:
{"outside_view":"...","inside_view":"...","steelman":"...","probability":0.XX,"reasoning_summary":"one sentence"}`, 1200, "claude-haiku-4-5");

  return safeParseJSON(raw);
}

async function resolveExpiredQuestions() {
  try {
    await initLiveQuestionsTable();
    const today = new Date().toISOString().split("T")[0];

    // Find questions past their resolution date that are still pending
    const expired = await db.query(
      `SELECT * FROM live_questions WHERE status = 'forecasted' AND resolution_date <= $1`,
      [today]
    );

    for (const liveQ of expired.rows) {
      addLog(`   🔍 Checking resolution: "${liveQ.question.slice(0, 60)}..."`, "info");
      try {
        // Search for resolution
        const searchResult = await searchCurrentNews(liveQ.question + " outcome result resolved");

        // Ask Claude to determine if/how it resolved
        const resolutionRaw = await callClaude(`Today is ${new Date().toISOString().split("T")[0]}.

QUESTION: ${liveQ.question}
RESOLUTION DATE: ${liveQ.resolution_date}
SEARCH RESULTS: ${searchResult}

Based on the search results, has this question definitively resolved YES or NO?
If you cannot confirm resolution from the search results, say "unresolved".

Respond ONLY in JSON:
{"resolved": true|false|"unresolved", "outcome": true|false|null, "resolution_description": "what actually happened", "confidence": "high|medium|low"}`, 800, "claude-haiku-4-5");

        const resolution = safeParseJSON(resolutionRaw);

        if (resolution.resolved === "unresolved" || resolution.confidence === "low") {
          addLog(`   ⏳ Not yet resolvable: "${liveQ.question.slice(0, 50)}..."`, "muted");
          // Extend by 14 days and check again
          await db.query(
            `UPDATE live_questions SET resolution_date = resolution_date + INTERVAL '14 days' WHERE id = $1`,
            [liveQ.id]
          );
          continue;
        }

        // Score it
        const forecastP = liveQ.forecast_probability;
        const outcome   = resolution.outcome;
        const b         = brier(forecastP, outcome);

        // Run post-mortem to extract principle
        const fakeQ = {
          q: liveQ.question, domain: liveQ.domain,
          asOf: liveQ.created_at.toISOString().split("T")[0],
          resolution: resolution.resolution_description,
          outcome,
        };
        const fakeForecast = {
          probability: forecastP,
          outside_view: liveQ.forecast_reasoning || "",
          inside_view: "", steelman: "",
        };

        let pm = { new_principle: null, calibration_error: forecastP - (outcome ? 1 : 0), verdict: "" };
        try {
          pm = await getPostMortem(fakeQ, fakeForecast);
        } catch (e) { /* use defaults */ }

        // Save resolution
        await db.query(
          `UPDATE live_questions SET status='resolved', outcome=$1, resolution=$2, brier_score=$3, principle=$4, resolved_at=NOW() WHERE id=$5`,
          [outcome, resolution.resolution_description, b, pm.new_principle, liveQ.id]
        );

        // Feed into main training state
        if (pm.new_principle) {
          state.principles.push("🔴 LIVE: " + pm.new_principle);
          const prevBias = state.domainBiases[liveQ.domain] || 0;
          state.domainBiases[liveQ.domain] = prevBias * 0.7 + pm.calibration_error * 0.3;
          state.history.push({
            id: "live_" + liveQ.id, domain: liveQ.domain, difficulty: "Live",
            q: liveQ.question, probability: forecastP, outcome,
            brier: b, verdict: pm.verdict || "", principle: pm.new_principle,
            ts: new Date().toISOString(), isLive: true,
          });
          saveState();
        }

        addLog(`   ✅ LIVE Q resolved: ${outcome ? "YES" : "NO"} | Brier: ${b.toFixed(3)} | "${liveQ.question.slice(0, 50)}..."`, "success");

      } catch (e) {
        addLog(`   ⚠ Resolution check error: ${e.message}`, "warn");
      }
    }
  } catch (e) {
    addLog(`Live Q resolution error: ${e.message}`, "error");
  }
}

async function seedLiveQuestions() {
  try {
    await initLiveQuestionsTable();

    // Check how many pending/forecasted questions we have
    const count = await db.query(`SELECT COUNT(*) FROM live_questions WHERE status IN ('pending','forecasted')`);
    const active = parseInt(count.rows[0].count);

    // Keep ~9 active questions at all times (3 per time horizon)
    if (active >= 50) return;

    addLog(`   🌱 Generating new live questions (${active} active)...`, "info");
    // Fetch existing question text to avoid semantic duplicates
    const existing = await db.query(`SELECT question FROM live_questions WHERE status IN ('pending','forecasted')`);
    const existingTexts = existing.rows.map(r => r.question);
    const questions = await generateLiveQuestions(existingTexts);

    for (const q of questions) {
      if (!q.question || !q.domain || !q.resolution_date) continue;

      // Insert and immediately forecast
      const insert = await db.query(
        `INSERT INTO live_questions (domain, question, context, resolution_date) VALUES ($1,$2,$3,$4) RETURNING id`,
        [q.domain, q.question, q.context, q.resolution_date]
      );
      const liveQ = { id: insert.rows[0].id, ...q };

      try {
        const forecast = await forecastLiveQuestion(liveQ);
        await db.query(
          `UPDATE live_questions SET status='forecasted', forecast_probability=$1, forecast_reasoning=$2 WHERE id=$3`,
          [forecast.probability, forecast.reasoning_summary, liveQ.id]
        );
        addLog(`   📋 Live Q: "${q.question.slice(0, 60)}..." → ${(forecast.probability*100).toFixed(0)}% YES (resolves ${q.resolution_date})`, "accent");
      } catch (e) {
        addLog(`   ⚠ Live Q forecast error: ${e.message}`, "warn");
      }
    }
  } catch (e) {
    addLog(`Live Q seeding error: ${e.message}`, "error");
  }
}

// Run resolution checks every 6 hours, seed new questions daily
function scheduleLiveQuestions() {
  // Check resolutions every 6 hours
  setInterval(resolveExpiredQuestions, 6 * 60 * 60 * 1000);
  // Seed new questions once per day
  setInterval(seedLiveQuestions, 24 * 60 * 60 * 1000);
  // Run both immediately on startup (after a short delay)
  setTimeout(async () => {
    await resolveExpiredQuestions();
    await seedLiveQuestions();
  }, 15000); // 15s after startup
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 2000, model = "claude-sonnet-4-5") {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content.map(c => c.text || "").join("").replace(/```json\n?|```/g, "").trim();
}

// Robustly parse JSON from a possibly-truncated response
function safeParseJSON(raw) {
  // 1. Direct parse
  try { return JSON.parse(raw); } catch (_) {}

  // 2. Find the opening brace
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');
  let text = raw.slice(start);

  // 3. Try common truncation suffixes
  const suffixes = ['"}', '"},"summary":"..."}', '}', '"}}', '"]}', '"]}}"', '..."}'];
  for (const s of suffixes) {
    try { return JSON.parse(text + s); } catch (_) {}
  }

  // 4. Count open braces and try to close them
  let opens = 0;
  for (const ch of text) {
    if (ch === '{') opens++;
    else if (ch === '}') opens--;
  }
  if (opens > 0) {
    const closed = text + '}'.repeat(opens);
    try { return JSON.parse(closed); } catch (_) {}
    // Also try closing any open string first
    try { return JSON.parse(text + '"' + '}'.repeat(opens)); } catch (_) {}
  }

  // 5. Strip back to last complete key-value pair
  // Find last occurrence of ,"key": pattern and truncate there
  const lastComma = text.lastIndexOf(',"');
  if (lastComma > 10) {
    const truncated = text.slice(0, lastComma) + '}';
    try { return JSON.parse(truncated); } catch (_) {}
  }

  // 6. Extract whatever fields we can using regex
  const result = {};
  const fieldPattern = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|\d+\.?\d*|true|false|null|\[(?:[^\[\]])*\])/g;
  let match;
  while ((match = fieldPattern.exec(text)) !== null) {
    try { result[match[1]] = JSON.parse(match[2]); } catch (_) { result[match[1]] = match[2]; }
  }
  if (Object.keys(result).length > 0) {
    // Ensure probability exists and is valid
    if (result.probability === undefined) result.probability = 0.5;
    if (result.reasoning_summary === undefined) result.reasoning_summary = "Response truncated";
    if (result.summary === undefined) result.summary = "Response truncated — please try again";
    return result;
  }

  throw new Error('Could not parse JSON: ' + raw.slice(0, 200));
}

async function getForecast(q) {
  const bias = state.domainBiases[q.domain] || 0;
  const biasNote = Math.abs(bias) > 0.02
    ? `\nCALIBRATION: You have been ${bias > 0 ? "overconfident" : "underconfident"} in ${q.domain} by ~${Math.abs(bias * 100).toFixed(0)}pp. Adjust accordingly.`
    : "";
  const principlesText = state.principles.length > 0
    ? `\nLEARNED PRINCIPLES:\n${state.principles.slice(-6).map((p, i) => `${i+1}. ${p}`).join("\n")}`
    : "";

  const raw = await callClaude(
    `You are a superforecaster. It is ${q.asOf}. You only know what was publicly known at that date.
${principlesText}${biasNote}

QUESTION: ${q.q}
CONTEXT: ${q.context}
DOMAIN: ${q.domain} | DIFFICULTY: ${q.difficulty}

Use outside view (base rate) → inside view (specific factors) → steelman opposite side → final probability.

IMPORTANT: The "probability" field must be a decimal number between 0.00 and 1.00. Example: 0.65 means 65% chance of YES.

Respond ONLY in JSON:
{"outside_view":"...","inside_view":"...","steelman":"...","principle_applied":"...","probability":0.65,"reasoning_summary":"one sentence"}`, 1000, "claude-sonnet-4-5");
  const parsed = safeParseJSON(raw);
  if (parsed.probability === undefined) {
    addLog(`   ⚠ probability missing from response — keys: ${Object.keys(parsed).join(', ')}`, "warn");
  }
  return parsed;
}

async function getPostMortem(q, forecast) {
  const raw = await callClaude(
    `You are a superforecasting trainer.

QUESTION: ${q.q} (${q.asOf}, ${q.domain})
FORECAST: ${(forecast.probability * 100).toFixed(0)}% YES
OUTCOME: ${q.outcome ? "YES" : "NO"} — ${q.resolution}
BRIER: ${brier(forecast.probability, q.outcome).toFixed(4)}

Reasoning: Outside: ${forecast.outside_view} | Inside: ${forecast.inside_view} | Steelman: ${forecast.steelman}

Existing principles (do not duplicate):
${state.principles.slice(-5).map((p, i) => `${i+1}. ${p}`).join("\n") || "None yet."}

Extract one NEW concrete forecasting principle. Identify calibration error.

Respond ONLY in JSON:
{"new_principle":"...","cognitive_error":"...","verdict":"one sentence"}`, 800, "claude-sonnet-4-5");
  return safeParseJSON(raw);
}

async function generateFramework() {
  const avg = state.history.reduce((s, h) => s + h.brier, 0) / state.history.length;
  return await callClaude(
    `Synthesize a superforecasting system prompt from ${state.history.length} training sessions on Telecom, Media, Live Events, Parks, and Technology.

Avg Brier: ${avg.toFixed(4)}

PRINCIPLES (${state.principles.length}):
${state.principles.map((p, i) => `${i+1}. ${p}`).join("\n")}

DOMAIN BIASES:
${Object.entries(state.domainBiases).map(([d, b]) => `- ${d}: ${b > 0 ? "overconfident" : "underconfident"} by ${Math.abs(b * 100).toFixed(1)}pp`).join("\n")}

Write a complete system prompt (700-900 words, "You are..." format) for forecasting real future business questions. Embed all principles, calibration corrections, and reasoning process. Plain text only.`, 2000);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING LOOP
// ─────────────────────────────────────────────────────────────────────────────
let trainingTimeout = null;

async function runOneQuestion() {
  let q;
  try {
    q = await generateTrainingQuestion();
  } catch(e) {
    addLog(`   ✗ Question generation failed: ${e.message}`, "error");
    return;
  }

  state.currentQ = { id: q.id, domain: q.domain, difficulty: q.difficulty, q: q.q, asOf: q.asOf };
  state.trainPhase = "forecasting";
  addLog(`→ [${q.domain}/${q.difficulty}] ${q.q.slice(0, 70)}...`, "header");

  let forecast;
  try {
    forecast = await getForecast(q);
    // Sanitize probability — model sometimes returns it under a different key or as a string
    if (forecast.probability === undefined || forecast.probability === null) {
      // Try common alternative field names
      forecast.probability = forecast.prob ?? forecast.p ?? forecast.probability_yes ?? 0.5;
    }
    // Ensure it's a valid number between 0 and 1
    forecast.probability = Math.max(0, Math.min(1, parseFloat(forecast.probability) || 0.5));
    addLog(`   Forecast: ${(forecast.probability * 100).toFixed(0)}% YES — "${forecast.reasoning_summary || 'no summary'}"`, "data");
  } catch (e) {
    addLog(`   Forecast error: ${e.message}`, "error");
    return;
  }

  state.trainPhase = "postmortem";
  const b = brier(forecast.probability, q.outcome);
  addLog(`   Outcome: ${q.outcome ? "YES ✓" : "NO ✗"} | Brier: ${b.toFixed(4)}`, b < 0.1 ? "success" : b < 0.2 ? "warn" : "error");

  let pm;
  try {
    pm = await getPostMortem(q, forecast);
    addLog(`   Verdict: "${pm.verdict}"`, "muted");
    addLog(`   New principle: "${pm.new_principle}"`, "accent");
  } catch (e) {
    addLog(`   Post-mortem error: ${e.message}`, "error");
    return;
  }

  // Update state
  state.principles.push(pm.new_principle);
  // Compute calibration error directly from data — don't trust model to calculate it
  // Positive = overconfident (forecast too high), Negative = underconfident
  const computedCalibrationError = forecast.probability - (q.outcome ? 1 : 0);
  const prevBias = state.domainBiases[q.domain] || 0;
  // Slow decay (0.9) so bias signal accumulates meaningfully over many sessions
  state.domainBiases[q.domain] = prevBias * 0.9 + computedCalibrationError * 0.1;
  state.history.push({
    id: q.id, domain: q.domain, difficulty: q.difficulty,
    q: q.q, probability: forecast.probability, outcome: q.outcome,
    brier: b, verdict: pm.verdict, principle: pm.new_principle,
    ts: new Date().toISOString(),
  });
  addLog(`   ✓ ${state.history.length} sessions | ${state.principles.length} principles`, "success");

  if (state.history.length % 25 === 0) {
    addLog(`   ◉ Regenerating framework (${state.history.length} sessions)...`, "accent");
    try {
      state.framework = await generateFramework();
      addLog(`   ✓ Framework updated.`, "success");
    } catch (e) {
      addLog(`   Framework error: ${e.message}`, "error");
    }
  }

  saveState();
}

function scheduleNext() {
  if (!state.isTraining) return;
  state.trainPhase = "idle";
  trainingTimeout = setTimeout(async () => {
    if (!state.isTraining) return;
    try { await runOneQuestion(); } catch (e) { addLog(`Loop error: ${e.message}`, "error"); }
    scheduleNext();
  }, 3000); // 3s between questions
}

function startTraining() {
  if (state.isTraining) return;
  state.isTraining = true;
  addLog("━━━ Training started ━━━", "header");
  scheduleNext();
}

function stopTraining() {
  state.isTraining = false;
  if (trainingTimeout) clearTimeout(trainingTimeout);
  state.trainPhase = "idle";
  addLog("━━━ Training paused ━━━", "warn");
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const validHistory = state.history.filter(h => typeof h.brier === 'number' && !isNaN(h.brier));
  const avgBrier = validHistory.length > 0
    ? validHistory.reduce((s, h) => s + h.brier, 0) / validHistory.length : null;
  res.json({
    isTraining:    state.isTraining,
    trainPhase:    state.trainPhase,
    sessions:      state.history.length,
    principles:    state.principles.length,
    avgBrier,
    domainBiases:  state.domainBiases,
    currentQ:      state.currentQ,
    log:           state.log.slice(-60),
    recentHistory: state.history.slice(-10).reverse(),
    recentPrinciples: state.principles.slice(-10).reverse(),
  });
});

app.post("/api/training/start", (req, res) => {
  startTraining();
  res.json({ ok: true, message: "Training started" });
});

app.post("/api/training/stop", (req, res) => {
  stopTraining();
  res.json({ ok: true, message: "Training paused" });
});

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC JOB SYSTEM
// Browser gets a job ID instantly. Work happens in background.
// Browser polls /api/forecast/:id every 3 seconds until done.
// This avoids Railway's 30-second HTTP timeout entirely.
// ─────────────────────────────────────────────────────────────────────────────
const jobs = new Map(); // jobId -> { status, result, error }

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function searchCurrentNews(question) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const today = new Date().toISOString().split("T")[0];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{
        role: "user",
        content: `Today is ${today}. Search for very recent news about: "${question}". Find the latest articles, announcements, or data. Write a concise 150-word factual summary of what you found. Include specific dates, names, and numbers.`
      }]
    }),
  });

  if (!res.ok) throw new Error(`Search API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const textBlocks = (data.content || []).filter(c => c.type === "text").map(c => c.text);
  return textBlocks.join("\n").trim() || "No search results found.";
}

async function inferDomainAndHorizon(question) {
  // Quickly infer domain and horizon from the question text
  const raw = await callClaude(`Classify this forecasting question:
"${question}"

Respond ONLY in JSON:
{"domain":"Telecommunications|Media|Technology|Live Events|Parks","horizon":"3 months|6 months|1 year|2 years|3-5 years"}`, 200, "claude-haiku-4-5");
  try {
    return safeParseJSON(raw);
  } catch(_) {
    return { domain: "Technology", horizon: "1 year" };
  }
}

async function runForecastJob(jobId, question, domain, horizon) {
  const job = jobs.get(jobId);

  // Auto-detect domain and horizon if not provided
  if (domain === 'auto' || horizon === 'auto') {
    try {
      job.phase = "classifying";
      const inferred = await inferDomainAndHorizon(question);
      if (domain === 'auto') domain = inferred.domain || "Technology";
      if (horizon === 'auto') horizon = inferred.horizon || "1 year";
    } catch(_) {
      domain = domain === 'auto' ? "Technology" : domain;
      horizon = horizon === 'auto' ? "1 year" : horizon;
    }
  }

  const bias = state.domainBiases[domain] || 0;
  const biasNote = Math.abs(bias) > 0.02
    ? `\nCALIBRATION: You have been ${bias > 0 ? "overconfident" : "underconfident"} in ${domain} by ~${Math.abs(bias * 100).toFixed(0)}pp.`
    : "";
  const context = state.framework
    ? `LEARNED FRAMEWORK:\n${state.framework.slice(0, 1200)}`
    : state.principles.length > 0
      ? `LEARNED PRINCIPLES:\n${state.principles.slice(-10).map((p, i) => `${i+1}. ${p}`).join("\n")}`
      : "(No training yet — applying general superforecasting methodology.)";

  try {
    // Step 1: Web search
    job.phase = "searching";
    addLog(`   🔍 Searching: "${question.slice(0, 55)}..."`, "info");
    let intelligence = "";
    try {
      intelligence = await searchCurrentNews(question);
      addLog(`   ✓ Search complete`, "success");
    } catch (e) {
      addLog(`   ⚠ Search unavailable: ${e.message}`, "warn");
      intelligence = "Live search unavailable — using training knowledge only.";
    }

    // Step 2: Forecast
    job.phase = "forecasting";
    addLog(`   🧠 Forecasting...`, "info");
    const raw = await callClaude(`You are a business superforecaster. Today: ${new Date().toISOString().split("T")[0]}

${context}
${biasNote}

QUESTION: ${question}
DOMAIN: ${domain}
HORIZON: ${horizon}

CURRENT NEWS (live web search):
${intelligence}

Treat the news above as your primary factual source — it supersedes your training knowledge on current events.
Apply: outside view (base rate) → inside view (specific current facts) → steelman → calibrated probability.

CRITICAL: Do NOT assume an event has already occurred unless the search results explicitly state it happened, with a specific date and confirmed outcome. If uncertain whether an event has resolved, treat it as still pending and forecast accordingly.

Respond ONLY in valid JSON — no markdown, no extra text:
{"outside_view":"...","inside_view":"...","steelman":"...","principles_applied":["..."],"calibration_note":"...","key_facts_used":["...","..."],"bull_case":{"scenario":"...","probability":0.00},"base_case":{"scenario":"...","probability":0.00},"bear_case":{"scenario":"...","probability":0.00},"probability":0.00,"ci_low":0.00,"ci_high":0.00,"key_risks":["...","..."],"what_to_watch":"...","intelligence_summary":"...","summary":"..."}`, 3500);

    const result = safeParseJSON(raw);
    result.intelligence_brief = intelligence;

    result.domain  = domain;
    result.horizon = horizon;
    job.status = "done";
    job.result = result;
    addLog(`   ✓ Forecast complete: ${(result.probability * 100).toFixed(0)}% [${domain}, ${horizon}]`, "success");

  } catch (e) {
    job.status = "error";
    job.error = e.message;
    addLog(`   ✗ Forecast error: ${e.message}`, "error");
  }
}

// POST — start a forecast job, return job ID immediately
app.post("/api/forecast", (req, res) => {
  const { question, domain, horizon } = req.body;
  if (!question || !domain || !horizon) {
    return res.status(400).json({ error: "question, domain, and horizon are required" });
  }

  const jobId = makeJobId();
  jobs.set(jobId, { status: "running", phase: "starting", result: null, error: null });

  // Fire and forget — runs in background, no timeout risk
  runForecastJob(jobId, question, domain, horizon);

  // Return immediately with job ID
  res.json({ jobId });
});

// GET — poll for job result
app.get("/api/forecast/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.get("/api/framework", (req, res) => {
  res.json({ framework: state.framework });
});

// One-time reset endpoint for domain biases
app.post("/api/admin/reset-biases", async (req, res) => {
  state.domainBiases = {};
  await saveState();
  addLog("Domain biases reset to zero — will rebuild from new training sessions.", "warn");
  res.json({ ok: true, message: "Domain biases cleared. Will rebuild over next ~100 sessions." });
});

app.get("/api/brier-history", (req, res) => {
  // skipFirst lets the UI exclude the Haiku-model sessions (approx sessions 80-300)
  // which had artificially high Brier scores due to model quality
  const skipFirst = parseInt(req.query.skip || '0', 10);
  const allValid = state.history.filter(h => typeof h.brier === 'number' && !isNaN(h.brier));
  const valid = skipFirst > 0 ? allValid.slice(skipFirst) : allValid;
  if (valid.length === 0) return res.json({ points: [], byDomain: {}, total: 0, rawTotal: state.history.length, skipped: skipFirst });

  // Cumulative average — smoothest possible trend line
  // Also compute rolling 30-session average for comparison
  const WINDOW = 30;
  const points = [];
  for (let i = WINDOW - 1; i < valid.length; i++) {
    // Only plot every 5 sessions to reduce density without losing shape
    if ((i + 1) % 5 !== 0 && i !== valid.length - 1) continue;
    const windowSlice = valid.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const avg = windowSlice.reduce((s, h) => s + h.brier, 0) / windowSlice.length;
    // Also compute cumulative avg from start
    const cumulativeAvg = valid.slice(0, i + 1).reduce((s, h) => s + h.brier, 0) / (i + 1);
    points.push({ session: i + 1, avg: parseFloat(avg.toFixed(4)), cumulative: parseFloat(cumulativeAvg.toFixed(4)), ts: valid[i].ts });
  }

  // Per-domain rolling averages (window of 5)
  const domains = [...new Set(valid.map(h => h.domain))];
  const byDomain = {};
  for (const domain of domains) {
    const dh = valid.filter(h => h.domain === domain);
    const dp = [];
    for (let i = 9; i < dh.length; i++) {
      if ((i + 1) % 3 !== 0 && i !== dh.length - 1) continue;
      const windowSlice = dh.slice(Math.max(0, i - 9), i + 1);
      const avg = windowSlice.reduce((s, h) => s + h.brier, 0) / windowSlice.length;
      dp.push({ session: i + 1, avg: parseFloat(avg.toFixed(4)) });
    }
    byDomain[domain] = dp;
  }

  // Calculate actual base rate from history outcomes (YES rate)
  const yesCount = valid.filter(h => h.outcome === true).length;
  const baseRate = valid.length > 0 ? yesCount / valid.length : 0.5;
  // Brier score of always predicting at base rate (the true "random chance" for this question set)
  const baselineBrier = parseFloat((baseRate * Math.pow(1 - baseRate, 2) + (1 - baseRate) * Math.pow(baseRate, 2)).toFixed(4));

  res.json({ points, byDomain, total: valid.length, rawTotal: state.history.length, skipped: skipFirst, current: points[points.length - 1]?.avg || null, baseRate: parseFloat(baseRate.toFixed(3)), baselineBrier });
});

app.get("/api/live-questions", async (req, res) => {
  try {
    await initLiveQuestionsTable();
    const result = await db.query(
      `SELECT * FROM live_questions ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ questions: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVE UI
// ─────────────────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
// Load state from DB first, then start server
loadState().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔮 Superforecaster running on http://localhost:${PORT}`);
    console.log(`   Training: ${state.history.length} sessions, ${state.principles.length} principles`);
    if (!ANTHROPIC_API_KEY) {
      console.warn("   ⚠️  ANTHROPIC_API_KEY not set — set it in Railway environment variables");
    } else {
      startTraining();
      scheduleLiveQuestions();
      console.log("   ▶ Training loop started automatically");
      console.log("   ▶ Live question tracker started");
    }
  });
}).catch(e => {
  console.error("Failed to load state from database:", e.message);
  console.log("Starting anyway with empty state...");
  app.listen(PORT, () => {
    console.log(`\n🔮 Superforecaster running on http://localhost:${PORT}`);
    if (ANTHROPIC_API_KEY) startTraining();
  });
});
