# RFD API — Self-Hosted RedFlagDeals Scraper

A lightweight Node.js API that scrapes the RedFlagDeals Hot Deals forum every 15 minutes and serves the results as JSON. Free to host on Render.com.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/deals` | Returns cached hot deals as JSON |
| GET | `/deals?refresh=true` | Forces a fresh scrape immediately |
| GET | `/health` | Health check (also keeps server awake) |

### Example Response
```json
{
  "success": true,
  "count": 42,
  "scrapedAt": 1710000000000,
  "scrapedAtIso": "2025-03-07T12:00:00.000Z",
  "stale": false,
  "deals": [
    {
      "id": "rfd_0_1710000000000",
      "source": "rfd",
      "sourceName": "RedFlagDeals",
      "title": "Samsung 65\" 4K QLED TV - $799",
      "store": "Best Buy",
      "currentPrice": 799,
      "wasPrice": 1299,
      "discount": 38,
      "votes": 245,
      "comments": 87,
      "url": "https://forums.redflagdeals.com/...",
      "time": 1710000000000,
      "category": "electronics",
      "isReal": true
    }
  ]
}
```

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Run the server
```bash
npm start
# Server starts on http://localhost:3001
```

### 3. Test the scraper directly
```bash
npm run scrape
```

### 4. Test the API
```bash
curl http://localhost:3001/deals
curl http://localhost:3001/health
```

---

## Deploy to Render.com (Free)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/rfd-api.git
git push -u origin main
```

### Step 2 — Deploy on Render
1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub account and select your `rfd-api` repo
4. Render will auto-detect `render.yaml` — just click **Deploy**
5. Wait ~2 minutes for the first deploy

### Step 3 — Get your API URL
After deployment, Render gives you a URL like:
```
https://rfd-api-xxxx.onrender.com
```

Test it:
```
https://rfd-api-xxxx.onrender.com/deals
https://rfd-api-xxxx.onrender.com/health
```

### Step 4 — Update your frontend
In `canadian-deals.html`, replace the `fetchRFDRSS()` call with:
```js
const YOUR_API_URL = 'https://rfd-api-xxxx.onrender.com'; // your Render URL

async function fetchRFDFromAPI() {
  const res = await fetch(`${YOUR_API_URL}/deals`);
  if (!res.ok) throw new Error(`RFD API: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return { deals: data.deals, source: 'api' };
}
```

---

## Free Tier Notes

- **Render free tier** spins down after 15 min of no traffic
- The built-in scheduler (`setInterval`) pings the scraper every 15 min, keeping the server alive
- If the server does sleep, the first request after wake-up takes ~30 seconds — subsequent requests are instant from cache
- **750 free hours/month** = enough for always-on with one service

## How It Works

```
Every 15 min:
  Server → GET forums.redflagdeals.com/hot-deals-f9/
         → Parse HTML with Cheerio
         → Extract title, store, price, votes, URL
         → Save to data/cache.json

Your frontend → GET /deals → Returns cached JSON instantly
```

Cheerio parses the HTML server-side. Because this runs on a real server (not a browser), Cloudflare's CORS restrictions don't apply — the scraper is treated like a regular HTTP client.

## Troubleshooting

**0 deals returned / scrape blocked:**
RFD occasionally updates their HTML structure or tightens Cloudflare rules. If this happens:
1. Run `npm run scrape` locally to see the error
2. Inspect `forums.redflagdeals.com/hot-deals-f9/` and update the CSS selectors in `src/scraper.js` to match the current HTML

**Render service sleeping:**
The scheduler keeps it awake during normal operation. If you need guaranteed uptime, upgrade to Render's $7/month paid tier, or add an external uptime monitor like [UptimeRobot](https://uptimerobot.com) (free) pointing at `/health`.
