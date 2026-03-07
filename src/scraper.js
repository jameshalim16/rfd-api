/**
 * RFD Scraper
 * Uses Puppeteer (headless Chrome) to bypass Cloudflare and scrape
 * RedFlagDeals hot deals forum. Caches results for 15 minutes.
 */

const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/cache.json');
const RFD_URL = 'https://forums.redflagdeals.com/hot-deals-f9/';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectCategory(text) {
  const t = (text || '').toLowerCase();
  if (/\b(gpu|cpu|ssd|nvme|ram|ddr[45]|motherboard|rtx|rx \d|ryzen|intel core|psu|pc build|gaming pc|desktop pc|case fan|cooler|water cool)\b/.test(t)) return 'computers';
  if (/\b(ps5|xbox|nintendo|switch|controller|video game|steam deck|gaming chair|gaming headset)\b/.test(t)) return 'gaming';
  if (/\b(laptop|monitor|tablet|phone|iphone|pixel|galaxy|tv|television|headphone|earbud|speaker|camera|drone|router|wifi|smart home|alexa|google home|apple watch|smartwatch|keyboard|mouse|webcam)\b/.test(t)) return 'electronics';
  if (/\b(washer|dryer|fridge|refrigerator|dishwasher|microwave|oven|vacuum|air fryer|coffee maker|blender|toaster|instant pot|air purifier|dehumidifier)\b/.test(t)) return 'appliances';
  if (/\b(shirt|pants|jacket|shoes|boots|coat|hoodie|dress|jeans|sneaker|nike|adidas|lululemon|clothing|apparel|fashion|socks|underwear)\b/.test(t)) return 'clothing';
  if (/\b(food|grocery|snack|drink|coffee|tea|protein|supplement|restaurant|pizza|uber eats|skip the dishes|doordash|costco food|meal)\b/.test(t)) return 'food';
  return 'other';
}

function extractPrices(text) {
  const matches = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/g) || [];
  const prices = matches
    .map(p => parseFloat(p.replace(/[$,\s]/g, '')))
    .filter(p => p > 0 && p < 100000);
  if (prices.length === 0) return { currentPrice: null, wasPrice: null, discount: null };
  const currentPrice = Math.min(...prices);
  const wasPrice = prices.length > 1 ? Math.max(...prices) : null;
  const discountMatch = text.match(/(\d+)%\s*off/i);
  const discount = discountMatch
    ? parseInt(discountMatch[1])
    : wasPrice && wasPrice > currentPrice
      ? Math.round((1 - currentPrice / wasPrice) * 100)
      : null;
  return { currentPrice, wasPrice: wasPrice !== currentPrice ? wasPrice : null, discount };
}

function parseDeals(html) {
  const $ = cheerio.load(html);
  const deals = [];

  $('li.row.topic').each((i, el) => {
    try {
      const $el = $(el);

      const $titleLink = $el.find('h3.topictitle a, a.topic_title_link').first();
      const title = $titleLink.text().trim();
      if (!title) return;

      let url = $titleLink.attr('href') || '';
      if (url && !url.startsWith('http')) {
        url = 'https://forums.redflagdeals.com' + url;
      }
      if (!url) return;

      const storeMatch = title.match(/^\[([^\]]+)\]/);
      const store = storeMatch ? storeMatch[1] : 'RedFlagDeals';
      const cleanTitle = title.replace(/^\[[^\]]+\]\s*/, '');

      const votesText = $el.find('.total_count, .vote_count, span.count').first().text().trim();
      const votes = parseInt(votesText.replace(/[^-\d]/g, '')) || 0;

      const repliesText = $el.find('.posts, td.posts, .num_replies').first().text().trim();
      const comments = parseInt(repliesText.replace(/\D/g, '')) || 0;

      const dateAttr = $el.find('time').attr('datetime') || $el.find('[data-time]').attr('data-time');
      let time = Date.now() - i * 600000;
      if (dateAttr) {
        const parsed = new Date(isNaN(dateAttr) ? dateAttr : parseInt(dateAttr) * 1000);
        if (!isNaN(parsed.getTime())) time = parsed.getTime();
      }

      const { currentPrice, wasPrice, discount } = extractPrices(title);

      deals.push({
        id: `rfd_${i}_${Date.now()}`,
        source: 'rfd',
        sourceName: 'RedFlagDeals',
        title: cleanTitle,
        store,
        description: '',
        currentPrice,
        wasPrice,
        discount,
        votes,
        comments,
        url,
        time,
        category: detectCategory(title),
        isReal: true,
      });
    } catch (err) {
      console.warn(`Skipping row ${i}:`, err.message);
    }
  });

  return deals;
}

// ── Puppeteer scraper ─────────────────────────────────────────────────────────

async function scrapeRFD() {
  console.log(`[${new Date().toISOString()}] Launching Puppeteer...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-CA,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // Block images/fonts to load faster
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[${new Date().toISOString()}] Navigating to RFD...`);
    await page.goto(RFD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await page.waitForSelector('li.row.topic', { timeout: 10000 }).catch(() => {
      console.warn('Selector li.row.topic not found — Cloudflare may have challenged');
    });

    const html = await page.content();
    const deals = parseDeals(html);
    console.log(`[${new Date().toISOString()}] Scraped ${deals.length} deals`);
    return deals;

  } finally {
    await browser.close();
  }
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

async function getDeals({ forceRefresh = false } = {}) {
  const cache = readCache();
  const now = Date.now();

  if (!forceRefresh && cache && (now - cache.scrapedAt) < CACHE_TTL_MS && cache.deals?.length > 0) {
    console.log(`[${new Date().toISOString()}] Serving ${cache.deals.length} deals from cache`);
    return cache;
  }

  const deals = await scrapeRFD();

  // Even if we got 0 deals (maybe Cloudflare blocked), keep old cache
  if (deals.length === 0 && cache?.deals?.length > 0) {
    console.warn('Scrape returned 0 deals — keeping stale cache');
    return { ...cache, stale: true };
  }

  const payload = { deals, scrapedAt: now, count: deals.length, stale: false };
  writeCache(payload);
  return payload;
}

module.exports = { getDeals };

// Allow running directly: node src/scraper.js
if (require.main === module) {
  getDeals({ forceRefresh: true })
    .then(r => console.log(`Done. ${r.deals.length} deals.`))
    .catch(console.error);
}
