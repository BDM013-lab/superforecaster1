# 🔮 Business Superforecaster

Autonomous AI agent that trains itself 24/7 on historical business events
across Telecommunications, Media, Live Events, Parks, and Technology.

---

## Deploy to Railway (GUI — no command line needed)

### Step 1 — Get your Anthropic API key
1. Go to **console.anthropic.com**
2. Click **API Keys** in the left sidebar
3. Click **Create Key**, give it a name, copy it somewhere safe

### Step 2 — Put the files on GitHub
1. Go to **github.com** and sign in (or create a free account)
2. Click the **+** button → **New repository**
3. Name it `superforecaster`, keep it Private, click **Create repository**
4. On the next screen click **uploading an existing file**
5. Drag ALL the files from this folder into the upload area:
   - `server.js`
   - `package.json`
   - `public/index.html`
   - (create a folder called `public` first, then upload `index.html` into it)
6. Click **Commit changes**

### Step 3 — Deploy on Railway
1. Go to **railway.app** and sign in with your GitHub account
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `superforecaster` repository
4. Railway will detect it's a Node.js app and deploy automatically
5. Wait ~2 minutes for the first deploy to finish

### Step 4 — Add your API key
1. In Railway, click on your project → click the **service** box
2. Click the **Variables** tab
3. Click **New Variable**
4. Set Name: `ANTHROPIC_API_KEY`
5. Set Value: (paste your Anthropic API key)
6. Click **Add** — Railway will automatically restart the server

### Step 5 — Get your URL
1. Click the **Settings** tab in your Railway service
2. Under **Networking**, click **Generate Domain**
3. Copy the URL (something like `superforecaster-production.up.railway.app`)
4. Open it in any browser — your forecaster is live!

---

## How it works

- **Training starts automatically** when the server boots
- It works through 50 historical business questions, scoring itself with Brier scores
- After every question it extracts a new forecasting principle
- Every 5 questions it regenerates a complete learned framework
- All state is saved to `data/state.json` on the server
- You can pause/resume training from the web UI at any time

## Using the web UI

1. Open your Railway URL in any browser
2. **Train tab** — watch the agent train in real time, see the live log
3. **Ask tab** — type any future business question, select domain + horizon, click Forecast
4. The more it trains, the better its forecasts get

## Costs

- **Railway**: Free tier gives 500 hours/month. ~$5/month for always-on
- **Anthropic API**: Each training question costs ~$0.003–0.008. Running 24/7 
  trains ~200–400 questions/day = ~$1–3/day. Set a spend limit at 
  console.anthropic.com → **Billing** → **Usage Limits** to stay in control.

## Tips

- Set a monthly Anthropic spend limit of $30–50 to start
- The agent cycles through all 50 questions and then starts over with new learning
- Training improves fastest in the first 50–100 sessions
- You can bookmark the URL on your phone to ask questions anywhere
