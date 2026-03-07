/**
 * RFD API Server
 * Serves cached RFD hot deals as JSON.
 * Scrapes on a schedule and on first request.
 */

const express = require('express');
const cors = require('cors');
const { getDeals } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3001;
const SCRAPE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors()); // Allow all origins — lock this down if you go public
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — also keeps Render free tier awake
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Main deals endpoint
app.get('/deals', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await getDeals({ forceRefresh });

    res.set('Cache-Control', 'public, max-age=300'); // browsers can cache 5min
    res.json({
      success: true,
      count: data.deals.length,
      scrapedAt: data.scrapedAt,
      scrapedAtIso: new Date(data.scrapedAt).toISOString(),
      stale: data.stale || false,
      deals: data.deals,
    });
  } catch (err) {
    console.error('GET /deals error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      deals: [],
    });
  }
});

// Force a fresh scrape (useful for testing or webhooks)
app.post('/scrape', async (req, res) => {
  try {
    const data = await getDeals({ forceRefresh: true });
    res.json({ success: true, count: data.deals.length, scrapedAt: data.scrapedAt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Scheduled scrape ──────────────────────────────────────────────────────────
function startScheduler() {
  console.log(`[Scheduler] Scraping every ${SCRAPE_INTERVAL_MS / 60000} minutes`);
  setInterval(async () => {
    try {
      await getDeals({ forceRefresh: true });
    } catch (err) {
      console.error('[Scheduler] Scrape failed:', err.message);
    }
  }, SCRAPE_INTERVAL_MS);
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ RFD API running on http://localhost:${PORT}`);
  console.log(`   GET /deals       — fetch hot deals`);
  console.log(`   GET /deals?refresh=true — force fresh scrape`);
  console.log(`   GET /health      — health check`);

  // Warm up cache on start
  try {
    await getDeals();
    console.log('✅ Initial cache warm-up complete');
  } catch (err) {
    console.warn('⚠️  Initial scrape failed (will retry on next request):', err.message);
  }

  startScheduler();
});
