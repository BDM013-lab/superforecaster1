// ─────────────────────────────────────────────────────────────────────────────
// Superforecaster Server
// Runs the training loop in the background, saves state to disk,
// and serves a web UI + REST API for asking questions.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const STATE_FILE = path.join(__dirname, "data", "state.json");

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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const saved = JSON.parse(raw);
      state = { ...state, ...saved, isTraining: false, trainPhase: "idle" };
      addLog(`Loaded state: ${state.history.length} sessions, ${state.principles.length} principles.`, "success");
    }
  } catch (e) {
    addLog(`Could not load state file: ${e.message}`, "warn");
  }
}

function saveState() {
  try {
    const toSave = {
      principles:   state.principles,
      domainBiases: state.domainBiases,
      history:      state.history,
      completedIds: state.completedIds,
      framework:    state.framework,
      log:          state.log.slice(-200),
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    addLog(`Save error: ${e.message}`, "error");
  }
}

function addLog(msg, type = "info") {
  const entry = { msg, type, ts: new Date().toISOString() };
  state.log.push(entry);
  if (state.log.length > 300) state.log = state.log.slice(-200);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING DATA
// ─────────────────────────────────────────────────────────────────────────────
const TRAINING_QUESTIONS = [
  // TELECOMMUNICATIONS
  { id:1,  domain:"Telecommunications", difficulty:"Medium", asOf:"2018-06-01", q:"Will T-Mobile and Sprint successfully complete their merger by end of 2020?", context:"Merger announced April 2018 at ~$26B. DOJ and FCC must approve. Several state AGs filed suit to block. T-Mobile CEO John Legere is a vocal advocate. Deal has been pending 14 months.", outcome:true,  resolution:"Merger closed April 1, 2020 after DOJ approved with conditions and court rejected state challenge." },
  { id:2,  domain:"Telecommunications", difficulty:"Hard",   asOf:"2019-01-01", q:"Will a major US carrier launch commercial 5G service available to consumers in 2019?", context:"Verizon launched fixed 5G home broadband Oct 2018 in limited markets. AT&T claims '5G Evolution' but disputed. True mobile 5G handsets not yet available. Standards still debated.", outcome:true,  resolution:"Verizon launched first commercial mobile 5G April 3, 2019. AT&T followed. Coverage was limited but commercially available." },
  { id:3,  domain:"Telecommunications", difficulty:"Medium", asOf:"2014-01-01", q:"Will AT&T acquire DirecTV by end of 2015?", context:"AT&T announced $48.5B offer to acquire DirecTV in May 2014. FCC and DOJ reviewing. AT&T seeks to bundle satellite TV with wireless. Comcast-TWC also pending, raising regulatory bandwidth concerns.", outcome:true,  resolution:"DOJ approved with conditions July 2015. Deal closed July 24, 2015." },
  { id:4,  domain:"Telecommunications", difficulty:"Hard",   asOf:"2017-11-01", q:"Will the FCC's repeal of net neutrality rules survive legal challenges through 2019?", context:"FCC voted 3-2 to repeal Obama-era net neutrality in Dec 2017. 22 state AGs immediately sued. DC Circuit Court timeline uncertain.", outcome:true,  resolution:"DC Circuit upheld FCC repeal Oct 2019. Court mostly upheld rollback, struck only narrow provisions." },
  { id:5,  domain:"Telecommunications", difficulty:"Medium", asOf:"2020-07-01", q:"Will the US government succeed in forcing a sale or ban of TikTok by end of 2020?", context:"Trump issued executive orders demanding ByteDance divest TikTok. Microsoft and Oracle in talks. CFIUS involved. ByteDance challenging in court. 100M US users at stake.", outcome:false, resolution:"No completed sale or ban by end of 2020. Courts blocked enforcement. Biden later rescinded Trump orders." },
  { id:6,  domain:"Telecommunications", difficulty:"Medium", asOf:"2022-02-01", q:"Will Verizon's C-Band 5G rollout proceed without airline safety delays forcing postponement?", context:"FAA raised concerns about C-Band interference with aircraft radar altimeters. AT&T and Verizon spent $68B on spectrum. FAA and FCC at odds. Airlines threatened flight cancellations near airports.", outcome:false, resolution:"Verizon and AT&T voluntarily delayed C-Band launch near airports on Jan 19, 2022 after airline pressure." },
  { id:7,  domain:"Telecommunications", difficulty:"Hard",   asOf:"2015-01-01", q:"Will Comcast complete its acquisition of Time Warner Cable by end of 2015?", context:"$45.2B deal announced Feb 2014. DOJ and FCC reviewing. Critics argue combined entity would control ~30% of US broadband. Comcast offered behavioral remedies.", outcome:false, resolution:"Comcast abandoned merger April 24, 2015 after DOJ signaled it would sue to block." },
  { id:8,  domain:"Telecommunications", difficulty:"Medium", asOf:"2021-01-01", q:"Will US telecom carriers report net subscriber growth in postpaid phone lines for full-year 2021?", context:"2020 saw suppressed switching due to COVID. Pent-up demand building. T-Mobile growing post-Sprint merger. AT&T and Verizon competing aggressively. 5G upgrade cycle beginning.", outcome:true,  resolution:"All three major carriers reported strong postpaid net adds in 2021. T-Mobile added 5.5M, AT&T 3.2M." },
  { id:9,  domain:"Telecommunications", difficulty:"Hard",   asOf:"2022-01-01", q:"Will the DOJ succeed in blocking the merger of Penguin Random House and Simon & Schuster by end of 2022?", context:"DOJ sued to block Nov 2021, arguing harm to book authors. First major publishing merger challenge in decades. Trial began Aug 2022.", outcome:true,  resolution:"Federal judge blocked the merger Oct 31, 2022, ruling it would harm competition for acquiring top books." },
  { id:10, domain:"Telecommunications", difficulty:"Medium", asOf:"2016-06-01", q:"Will SoftBank sell its majority stake in Sprint by end of 2018?", context:"SoftBank owns ~83% of Sprint. Sprint losing subscribers and cash. SoftBank exploring merger options with T-Mobile and Charter. Regulatory environment hostile to consolidation.", outcome:false, resolution:"SoftBank did not sell Sprint by end of 2018. T-Mobile merger deal announced April 2018 but not closed until 2020." },
  // MEDIA
  { id:11, domain:"Media", difficulty:"Medium", asOf:"2018-07-01", q:"Will Disney complete its acquisition of 21st Century Fox's entertainment assets by end of 2019?", context:"Disney announced $52.4B deal Dec 2017, raised to $71.3B after Comcast bid. DOJ approved with conditions June 2018. Comcast dropped rival bid.", outcome:true,  resolution:"Disney closed acquisition of Fox entertainment assets March 20, 2019." },
  { id:12, domain:"Media", difficulty:"Hard",   asOf:"2019-10-01", q:"Will Disney+ reach 50 million subscribers within its first year of launch?", context:"Disney+ launching Nov 12, 2019 at $6.99/month. Disney has massive IP (Marvel, Star Wars, Pixar). Netflix has 160M subs but took years. COVID impact unknown. Bundling with Hulu/ESPN+ planned.", outcome:true,  resolution:"Disney+ reached 50M subscribers by April 2020 — about 5 months in, accelerated by COVID lockdowns." },
  { id:13, domain:"Media", difficulty:"Medium", asOf:"2022-01-01", q:"Will Netflix report a net subscriber loss in Q1 2022?", context:"Netflix guided for +2.5M net adds in Q1 2022. Password sharing crackdown looming, competition intensifying, price hike just implemented. Inflation squeezing consumers.", outcome:true,  resolution:"Netflix reported a loss of 200,000 subscribers in Q1 2022 — first loss in over a decade. Stock fell 35%." },
  { id:14, domain:"Media", difficulty:"Medium", asOf:"2016-10-01", q:"Will AT&T complete its $85B acquisition of Time Warner by end of 2018?", context:"DOJ under Trump administration sued to block, unusual for vertical merger. Trial began Mar 2018. AT&T arguing no competitive harm. Judge deciding without jury.", outcome:true,  resolution:"Judge approved deal unconditionally June 12, 2018. AT&T closed acquisition June 14, 2018." },
  { id:15, domain:"Media", difficulty:"Hard",   asOf:"2020-01-01", q:"Will a major US broadcast network lose primetime ratings leadership to a streaming service in 2020?", context:"Netflix, Hulu, Amazon Prime growing rapidly. Live sports still anchor broadcast. COVID impact on production unknown. Streaming grew from ~25% to ~30% of TV viewing in 2019.", outcome:false, resolution:"Broadcast networks retained primetime leadership in traditional Nielsen ratings in 2020." },
  { id:16, domain:"Media", difficulty:"Medium", asOf:"2021-05-01", q:"Will HBO Max reach 50 million US subscribers by end of 2021?", context:"HBO Max launched May 2020. Day-and-date theatrical releases announced for 2021 boosting awareness. AT&T spin-off to Discovery announced. Price is $14.99/month.", outcome:false, resolution:"HBO Max ended 2021 with ~46.8M domestic subscribers, just short of 50M." },
  { id:17, domain:"Media", difficulty:"Hard",   asOf:"2023-03-01", q:"Will the combined Discovery+/HBO Max streaming service launch by end of 2023?", context:"Warner Bros. Discovery announced combined streaming product after merger closed April 2022. David Zaslav cutting costs aggressively. Technical integration complex. Target 2023 launch announced.", outcome:true,  resolution:"Max (combining HBO Max and Discovery+) launched May 23, 2023 in the US." },
  { id:18, domain:"Media", difficulty:"Medium", asOf:"2017-01-01", q:"Will Snap Inc. have a successful IPO in 2017 (pricing above $14/share and not falling below IPO price within 6 months)?", context:"Snap filed for IPO Feb 2017, targeting $25B valuation. Strong among Gen Z. But Instagram Stories copying core feature. Revenue growing but losses large.", outcome:false, resolution:"Snap IPO'd at $17/share but fell below $17 within weeks and traded well below IPO price by year-end." },
  { id:19, domain:"Media", difficulty:"Medium", asOf:"2024-01-01", q:"Will Paramount Global agree to a merger or acquisition deal by end of 2024?", context:"Paramount struggling with Paramount+ losses. Shari Redstone controls via National Amusements. Skydance Media in talks. Warner Bros. Discovery and Sony also rumored.", outcome:true,  resolution:"Paramount Global and Skydance Media agreed to merger terms July 2024. Deal closed September 2024." },
  { id:20, domain:"Media", difficulty:"Hard",   asOf:"2019-01-01", q:"Will traditional pay-TV lose more than 5 million net subscribers in the US in 2019?", context:"Cord-cutting accelerated in 2018 with ~3M losses. vMVPDs partially offsetting. Skinny bundles growing. Sports rights still anchor pay-TV.", outcome:false, resolution:"Traditional pay-TV lost approximately 4.9M subscribers in 2019 — just below the 5M threshold." },
  // TECHNOLOGY
  { id:21, domain:"Technology", difficulty:"Medium", asOf:"2022-10-01", q:"Will Elon Musk complete his acquisition of Twitter by end of 2022?", context:"Musk offered $54.20/share in April 2022, then tried to exit citing bot concerns. Twitter sued. Musk reversed and agreed to proceed Oct 4. Deal technically signed.", outcome:true,  resolution:"Acquisition closed October 27, 2022. Musk immediately fired top executives and began restructuring." },
  { id:22, domain:"Technology", difficulty:"Hard",   asOf:"2017-01-01", q:"Will Uber be valued at more than $50B in any fundraising round or secondary transaction in 2017?", context:"Uber last valued at $68B in 2016. Multiple scandals: Waymo IP lawsuit, Travis Kalanick controversies. SoftBank rumored to be negotiating a stake at a discount.", outcome:true,  resolution:"SoftBank led $9B investment in Uber at $48B post-money Jan 2018 (agreed late 2017). Valuation above $50B maintained in secondary markets." },
  { id:23, domain:"Technology", difficulty:"Medium", asOf:"2020-08-01", q:"Will Apple become the first US company to reach a $2 trillion market cap in 2020?", context:"Apple hit $1T market cap Aug 2018. COVID initially crashed shares but recovered strongly. Work-from-home driving device sales. Services revenue accelerating. Stock at ~$440 in Aug 2020.", outcome:true,  resolution:"Apple crossed $2 trillion market cap on August 19, 2020 — first US company to do so." },
  { id:24, domain:"Technology", difficulty:"Hard",   asOf:"2021-01-01", q:"Will the US Congress pass comprehensive federal privacy legislation in 2021?", context:"CCPA in California set off calls for federal standard. Multiple bipartisan bills introduced. Tech companies lobbying. Biden administration focused on COVID. Senate filibuster complicates passage.", outcome:false, resolution:"No comprehensive federal privacy law passed in 2021. American Data Privacy and Protection Act also failed to pass in 2022." },
  { id:25, domain:"Technology", difficulty:"Medium", asOf:"2019-06-01", q:"Will Facebook be fined more than $1 billion by the FTC over Cambridge Analytica privacy violations by end of 2019?", context:"FTC and Facebook in settlement talks. Reports of $3-5B fine circulating. FTC's 2012 consent decree provides enforcement basis. Zuckerberg testified to Congress in 2018.", outcome:true,  resolution:"FTC fined Facebook $5 billion in July 2019 — largest privacy fine in FTC history." },
  { id:26, domain:"Technology", difficulty:"Medium", asOf:"2023-01-01", q:"Will Microsoft's $68.7B acquisition of Activision Blizzard close by end of 2023?", context:"Deal announced Jan 2022. FTC filed to block Dec 2022. UK's CMA blocked in April 2023. EU approved with conditions May 2023. US federal judge rejected FTC's injunction July 2023.", outcome:true,  resolution:"Microsoft and Activision restructured the deal. CMA approved revised deal. Acquisition closed October 13, 2023." },
  { id:27, domain:"Technology", difficulty:"Hard",   asOf:"2016-01-01", q:"Will premium VR headsets (Rift, Vive, PSVR) sell more than 2.5 million units globally in 2016?", context:"Oculus Rift shipping Q1 2016, HTC Vive in April, PlayStation VR in October. High price points ($599-$799) a barrier. Content library thin.", outcome:false, resolution:"Premium headsets sold roughly 2.0-2.5M combined in 2016 — at or just below the threshold." },
  { id:28, domain:"Technology", difficulty:"Medium", asOf:"2018-01-01", q:"Will Amazon's market cap exceed $1 trillion at any point in 2018?", context:"Amazon closed 2017 at ~$565B market cap. AWS highly profitable. Alexa/Echo growing. Whole Foods acquisition adding revenue.", outcome:true,  resolution:"Amazon briefly crossed $1 trillion market cap on September 4, 2018." },
  { id:29, domain:"Technology", difficulty:"Medium", asOf:"2022-11-01", q:"Will ChatGPT reach 1 million users within one week of its November 2022 launch?", context:"OpenAI launching ChatGPT Nov 30. GPT-3 well known. AI chatbots gaining attention. Product is free at launch.", outcome:true,  resolution:"ChatGPT hit 1M users in 5 days — fastest consumer product to reach that milestone." },
  { id:30, domain:"Technology", difficulty:"Medium", asOf:"2022-01-01", q:"Will Meta's market cap fall below $500 billion in 2022?", context:"Meta at ~$900B at start of 2022. Metaverse bet burning $10B+/year. Apple's ATT privacy changes hit ad revenue. TikTok competition for youth attention.", outcome:true,  resolution:"Meta fell below $500B in February 2022. Fell as low as ~$260B by November 2022." },
  // LIVE EVENTS
  { id:31, domain:"Live Events", difficulty:"Easy",   asOf:"2020-03-15", q:"Will the Tokyo 2020 Summer Olympics proceed as scheduled in July 2020?", context:"COVID-19 declared pandemic March 11. Japan declared state of emergency. IOC under pressure. Sponsors nervous. Athletes unable to train.", outcome:false, resolution:"Olympics postponed to July 2021 on March 24, 2020 — just 9 days after this forecast date." },
  { id:32, domain:"Live Events", difficulty:"Medium", asOf:"2021-01-01", q:"Will major US concert tours return to full capacity in-person events by summer 2021?", context:"Live Nation and AEG lost billions in 2020. Vaccines rolling out but timeline uncertain. Delta variant not yet known. Many artists rescheduled to 2021.", outcome:false, resolution:"Most large arena/stadium tours did not return to full capacity until summer 2022. Delta variant caused further delays." },
  { id:33, domain:"Live Events", difficulty:"Hard",   asOf:"2019-01-01", q:"Will Live Nation's revenue exceed $12 billion in 2019?", context:"Live Nation reported $10.79B revenue in 2018, up 13%. Ticketing and sponsorship growing. International expansion.", outcome:false, resolution:"Live Nation reported $11.55B in 2019 revenue — strong growth but below $12B threshold." },
  { id:34, domain:"Live Events", difficulty:"Medium", asOf:"2022-01-01", q:"Will live event attendance recover to at least 90% of 2019 levels in North America by end of 2022?", context:"2020 and 2021 devastated by COVID. Pent-up demand enormous. Omicron waning in early 2022. Artists eager to tour. Ticket prices surging.", outcome:true,  resolution:"Live Nation reported North American attendance exceeded 2019 levels in 2022. Full recovery achieved." },
  { id:35, domain:"Live Events", difficulty:"Hard",   asOf:"2023-07-01", q:"Will Taylor Swift's Eras Tour gross more than $1 billion in total revenue by end of 2023?", context:"Eras Tour launched March 2023. Massive ticket demand crashed Ticketmaster. Early reports suggest ~$13-17M per show. 53 US shows plus international announced.", outcome:true,  resolution:"Eras Tour became first tour to gross over $1 billion, crossing the mark in December 2023." },
  { id:36, domain:"Live Events", difficulty:"Medium", asOf:"2021-09-01", q:"Will the NFL's 2021 season proceed without COVID-related game cancellations affecting the playoff structure?", context:"NFL played full 2020 season with some postponements. Vaccines available. League has strict protocols. Delta variant active in fall 2021.", outcome:true,  resolution:"NFL completed 2021 season without COVID-related playoff disruption. Super Bowl LVI held Feb 2022 as planned." },
  { id:37, domain:"Live Events", difficulty:"Medium", asOf:"2016-01-01", q:"Will the 2016 Rio Olympics complete without major security or Zika-related catastrophes?", context:"Zika virus epidemic in Brazil. Construction delays. Political crisis. Venue readiness concerns. Some athletes withdrawing.", outcome:true,  resolution:"Games proceeded without major incidents. Zika fears did not materialize significantly." },
  { id:38, domain:"Live Events", difficulty:"Hard",   asOf:"2018-01-01", q:"Will esports tournament prize pools exceed $100 million industry-wide in 2018?", context:"Dota 2's The International prize pool hit $24M in 2017. Fortnite not yet launched competitively. League of Legends World Championship growing. Overwatch League launching.", outcome:true,  resolution:"Total esports prize money awarded in 2018 exceeded $150M across all games." },
  { id:39, domain:"Live Events", difficulty:"Medium", asOf:"2024-01-01", q:"Will Ticketmaster face significant federal antitrust action or be forced to restructure in 2024?", context:"Senate held hearings Jan 2023 after Taylor Swift Eras Tour debacle. DOJ investigating Live Nation/Ticketmaster. Growing bipartisan anger.", outcome:true,  resolution:"DOJ filed antitrust lawsuit against Live Nation/Ticketmaster in May 2024, seeking to break up the company." },
  { id:40, domain:"Live Events", difficulty:"Hard",   asOf:"2020-06-01", q:"Will the Broadway theater industry fully reopen in New York City by end of 2020?", context:"Broadway shut down March 12, 2020. COVID cases surging. No clear vaccine timeline. Theaters require close seating. Union negotiations complex.", outcome:false, resolution:"Broadway remained closed through all of 2020 and into 2021. Reopened September 14, 2021." },
  // PARKS
  { id:41, domain:"Parks", difficulty:"Medium", asOf:"2020-03-20", q:"Will Disney theme parks in the US remain closed for more than 3 months due to COVID-19?", context:"Disneyland and Walt Disney World closed March 15-16, 2020. COVID accelerating. No vaccine timeline. Parks contribute ~37% of Disney revenue.", outcome:true,  resolution:"Disney World reopened July 11, 2020 (~4 months). Disneyland didn't reopen until April 30, 2021. Both exceeded 3 months." },
  { id:42, domain:"Parks", difficulty:"Hard",   asOf:"2022-01-01", q:"Will Disney's domestic parks report higher per capita guest spending in 2022 than in 2019 (pre-COVID)?", context:"Disney implemented Genie+ replacing free FastPass, park reservations, tiered ticket pricing. Capacity still somewhat constrained. Consumer inflation rising but demand strong.", outcome:true,  resolution:"Disney reported record per-capita spending at domestic parks in fiscal 2022, significantly above 2019 levels." },
  { id:43, domain:"Parks", difficulty:"Medium", asOf:"2019-06-01", q:"Will Star Wars: Galaxy's Edge at Disneyland generate a meaningful increase in park attendance in its first 3 months?", context:"Galaxy's Edge opening May 31, 2019 at Disneyland. Disney's biggest new land ever built. $1B+ investment. Huge advance buzz. But timed entry required.", outcome:false, resolution:"Attendance at Disneyland was flat-to-down in summer 2019. Many regular visitors avoided the crowds." },
  { id:44, domain:"Parks", difficulty:"Hard",   asOf:"2017-01-01", q:"Will Universal's US parks surpass Disney's US parks in total annual attendance by 2020?", context:"Universal added Harry Potter worlds and expanding. Disney US attendance ~50M. Universal US at ~25M. New parks planned. Gap is substantial.", outcome:false, resolution:"Universal did not surpass Disney US parks in attendance by 2020. COVID crushed both. Disney still roughly double Universal." },
  { id:45, domain:"Parks", difficulty:"Medium", asOf:"2023-01-01", q:"Will Disney's Epic Universe theme park in Orlando open by end of 2025?", context:"Epic Universe announced Aug 2019, delayed by COVID. Construction actively underway. Major IP zones announced: Harry Potter, Universal Monsters, Nintendo, and more. Targeted 2025.", outcome:true,  resolution:"Epic Universe opened May 22, 2025, on schedule." },
  { id:46, domain:"Parks", difficulty:"Medium", asOf:"2021-04-01", q:"Will SeaWorld Entertainment return to pre-COVID (2019) annual attendance levels by end of 2022?", context:"SeaWorld attendance was ~22.6M in 2019. COVID crushed 2020. Partial recovery in 2021. New coasters and attractions added. Lingering orca controversy.", outcome:false, resolution:"SeaWorld reported approximately 22.0M attendance in 2022 — close but not quite at 2019's 22.6M level." },
  { id:47, domain:"Parks", difficulty:"Hard",   asOf:"2019-01-01", q:"Will Six Flags' stock price be higher at end of 2021 than at start of 2019 (~$55)?", context:"Six Flags trading at ~$55 in Jan 2019. Expansion into China with partner Riverside Investment. US parks performing steadily. Dividend yield ~5%.", outcome:false, resolution:"Six Flags stock was ~$22 at end of 2021. COVID devastated 2020. China expansion partner defaulted. Dividend suspended." },
  { id:48, domain:"Parks", difficulty:"Medium", asOf:"2015-06-01", q:"Will Shanghai Disneyland open before end of 2016?", context:"Shanghai Disneyland under construction since 2011. Partnership with Shanghai Shendi Group. Multiple delay rumors. Chinese government approvals complex. $5.5B investment.", outcome:true,  resolution:"Shanghai Disneyland opened June 16, 2016, on schedule and within 2016." },
  { id:49, domain:"Parks", difficulty:"Hard",   asOf:"2018-01-01", q:"Will Cedar Fair complete a merger or be acquired by end of 2023?", context:"Cedar Fair has been acquisition speculation target for years. Six Flags rumored as potential acquirer/merger partner. Private equity interest. Cedar Fair strong cash generator.", outcome:true,  resolution:"Cedar Fair and Six Flags Entertainment announced merger May 2023. Deal closed July 2024." },
  { id:50, domain:"Parks", difficulty:"Medium", asOf:"2022-06-01", q:"Will Disney announce a major new theme park destination outside of existing markets before end of 2024?", context:"Disney CEO Bob Chapek under pressure to grow Parks segment. India, Saudi Arabia, and Gulf states rumored. Chapek fired Nov 2022; Iger returned.", outcome:false, resolution:"No new Disney theme park destination outside existing markets was announced by end of 2024." },
];

// ─────────────────────────────────────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────────────────────────────────────
const brier = (p, outcome) => Math.pow(p - (outcome ? 1 : 0), 2);

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 2000) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
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
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');
  const text = raw.slice(start);
  for (const suffix of ['"}}"', '"}"', '}', '"]}', '"]}}"']) {
    try { return JSON.parse(text + suffix); } catch (_) {}
  }
  const lastKey = text.lastIndexOf(',"');
  if (lastKey > 0) {
    try { return JSON.parse(text.slice(0, lastKey) + '}'); } catch (_) {}
  }
  throw new Error('Could not parse JSON: ' + raw.slice(0, 200));
}

async function getForecast(q) {
  const bias = state.domainBiases[q.domain] || 0;
  const biasNote = Math.abs(bias) > 0.02
    ? `\nCALIBRATION: You have been ${bias > 0 ? "overconfident" : "underconfident"} in ${q.domain} by ~${Math.abs(bias * 100).toFixed(0)}pp. Adjust accordingly.`
    : "";
  const principlesText = state.principles.length > 0
    ? `\nLEARNED PRINCIPLES:\n${state.principles.slice(-12).map((p, i) => `${i+1}. ${p}`).join("\n")}`
    : "";

  const raw = await callClaude(
    `You are a superforecaster. It is ${q.asOf}. You only know what was publicly known at that date.
${principlesText}${biasNote}

QUESTION: ${q.q}
CONTEXT: ${q.context}
DOMAIN: ${q.domain} | DIFFICULTY: ${q.difficulty}

Use outside view (base rate) → inside view (specific factors) → steelman opposite side → final probability.

Respond ONLY in JSON:
{"outside_view":"...","inside_view":"...","steelman":"...","principle_applied":"...","probability":0.XX,"reasoning_summary":"one sentence"}`, 800);
  return safeParseJSON(raw);
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
${state.principles.slice(-10).map((p, i) => `${i+1}. ${p}`).join("\n") || "None yet."}

Extract one NEW concrete forecasting principle. Identify calibration error.

Respond ONLY in JSON:
{"new_principle":"...","calibration_error":0.XX,"cognitive_error":"...","verdict":"one sentence"}`, 500);
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

Write a complete system prompt (700-900 words, "You are..." format) for forecasting real future business questions. Embed all principles, calibration corrections, and reasoning process. Plain text only.`, 1200);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAINING LOOP
// ─────────────────────────────────────────────────────────────────────────────
let trainingTimeout = null;

async function runOneQuestion() {
  const remaining = TRAINING_QUESTIONS.filter(q => !state.completedIds.includes(q.id));
  if (remaining.length === 0) {
    addLog("All 50 questions complete — cycling.", "warn");
    state.completedIds = [];
  }

  const pool = remaining.length > 0 ? remaining : TRAINING_QUESTIONS;
  const q = pool[Math.floor(Math.random() * Math.min(pool.length, 5))];

  state.currentQ = { id: q.id, domain: q.domain, difficulty: q.difficulty, q: q.q, asOf: q.asOf };
  state.trainPhase = "forecasting";
  addLog(`→ [${q.domain}] ${q.q.slice(0, 70)}...`, "header");

  let forecast;
  try {
    forecast = await getForecast(q);
    addLog(`   Forecast: ${(forecast.probability * 100).toFixed(0)}% YES — "${forecast.reasoning_summary}"`, "data");
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
  const prevBias = state.domainBiases[q.domain] || 0;
  state.domainBiases[q.domain] = prevBias * 0.7 + pm.calibration_error * 0.3;
  state.history.push({
    id: q.id, domain: q.domain, difficulty: q.difficulty,
    q: q.q, probability: forecast.probability, outcome: q.outcome,
    brier: b, verdict: pm.verdict, principle: pm.new_principle,
    ts: new Date().toISOString(),
  });
  state.completedIds.push(q.id);

  addLog(`   ✓ ${state.history.length} sessions | ${state.principles.length} principles`, "success");

  if (state.history.length % 5 === 0) {
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
  const avgBrier = state.history.length > 0
    ? state.history.reduce((s, h) => s + h.brier, 0) / state.history.length : null;
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

async function runForecastJob(jobId, question, domain, horizon) {
  const job = jobs.get(jobId);

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

Respond ONLY in valid JSON — no markdown, no extra text:
{"outside_view":"...","inside_view":"...","steelman":"...","principles_applied":["..."],"calibration_note":"...","key_facts_used":["...","..."],"bull_case":{"scenario":"...","probability":0.00},"base_case":{"scenario":"...","probability":0.00},"bear_case":{"scenario":"...","probability":0.00},"probability":0.00,"ci_low":0.00,"ci_high":0.00,"key_risks":["...","..."],"what_to_watch":"...","intelligence_summary":"...","summary":"..."}`, 3500);

    const result = safeParseJSON(raw);
    result.intelligence_brief = intelligence;

    job.status = "done";
    job.result = result;
    addLog(`   ✓ Forecast complete: ${(result.probability * 100).toFixed(0)}%`, "success");

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

// ─────────────────────────────────────────────────────────────────────────────
// SERVE UI
// ─────────────────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
loadState();
app.listen(PORT, () => {
  console.log(`\n🔮 Superforecaster running on http://localhost:${PORT}`);
  console.log(`   Training: ${state.history.length} sessions completed`);
  if (!ANTHROPIC_API_KEY) {
    console.warn("   ⚠️  ANTHROPIC_API_KEY not set — set it in Railway environment variables");
  } else {
    // Auto-start training on boot
    startTraining();
    console.log("   ▶ Training loop started automatically");
  }
});
