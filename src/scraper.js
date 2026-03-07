/**
 * RFD Scraper
 * Scrapes RedFlagDeals hot deals forum and returns structured deal objects.
 * Uses axios + cheerio (no headless browser needed — RFD is server-rendered).
 */

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/cache.json');
const RFD_URL = 'https://forums.redflagdeals.com/hot-deals-f9/';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Retry on network errors / 5xx
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    (err.response && err.response.status >= 500),
});

// Rotate user agents to avoid simple bot detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

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

async function scrapeRFD() {
  console.log(`[${new Date().toISOString()}] Scraping RFD...`);

  const response = await axios.get(RFD_URL, {
    timeout: 15000,
    headers: {
      'User-Agent': randomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://forums.redflagdeals.com/',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const $ = cheerio.load(response.data);
  const deals = [];

  // RFD forum thread rows
  $('li.row.topic').each((i, el) => {
    try {
      const $el = $(el);

      // Title & URL
      const $titleLink = $el.find('h3.topictitle a, a.topic_title_link').first();
      const title = $titleLink.text().trim();
      if (!title) return;

      let url = $titleLink.attr('href') || '';
      if (url && !url.startsWith('http')) {
        url = 'https://forums.redflagdeals.com' + url;
      }

      // Store — RFD titles use [Store Name] prefix
      const storeMatch = title.match(/^\[([^\]]+)\]/);
      const store = storeMatch ? storeMatch[1] : 'RedFlagDeals';
      const cleanTitle = title.replace(/^\[[^\]]+\]\s*/, '');

      // Votes / score
      const votesText = $el.find('.total_count, .vote_count, span.count').first().text().trim();
      const votes = parseInt(votesText.replace(/[^-\d]/g, '')) || 0;

      // Replies/comments
      const repliesText = $el.find('.posts, td.posts, .num_replies').first().text().trim();
      const comments = parseInt(repliesText.replace(/\D/g, '')) || 0;

      // Posted date — try data attribute first, then text
      const dateAttr = $el.find('time').attr('datetime') || $el.find('[data-time]').attr('data-time');
      const dateText = $el.find('.post-time, .topic_date, time').first().text().trim();
      let time = Date.now() - i * 600000; // fallback: stagger by 10min
      if (dateAttr) {
        const parsed = new Date(isNaN(dateAttr) ? dateAttr : parseInt(dateAttr) * 1000);
        if (!isNaN(parsed.getTime())) time = parsed.getTime();
      } else if (dateText) {
        const parsed = new Date(dateText);
        if (!isNaN(parsed.getTime())) time = parsed.getTime();
      }

      // Category tag from RFD's category column
      const categoryText = $el.find('.thread_category, .topic_category, .icon_category').text().trim();

      const { currentPrice, wasPrice, discount } = extractPrices(title);

      deals.push({
        id: `rfd_${i}_${Date.now()}`,
        source: 'rfd',
        sourceName: 'RedFlagDeals',
        title: cleanTitle,
        store,
        description: categoryText || '',
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

  console.log(`[${new Date().toISOString()}] Scraped ${deals.length} deals from RFD`);
  return deals;
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
