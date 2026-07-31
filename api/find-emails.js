// /api/find-emails.js
//
// Scrapes a website's homepage + common contact/about paths for a
// visible email address. Falls back to common-pattern guesses when
// nothing is found. Designed to run in small batches from the client
// so it never hits serverless execution-time limits, no matter how
// many URLs the user queues up in total.

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us'];

const IGNORED_EMAIL_SUFFIXES = [
  'sentry.io', 'wixpress.com', 'godaddy.com', 'example.com', 'schema.org',
  'w3.org', 'gstatic.com', 'googleapis.com', 'wordpress.org', 'placeholder.com',
];

const IGNORED_FILE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

const PER_REQUEST_MAX_URLS = 15;   // hard cap per API call — keeps each call fast
const FETCH_TIMEOUT_MS = 5000;     // per-page fetch timeout
const SITE_CONCURRENCY = 6;        // how many sites we scrape at once per call

// ---------- helpers ----------

function normalizeUrl(input) {
  if (!input) return null;
  let url = String(input).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function cleanEmail(raw) {
  return raw.toLowerCase().replace(/^["'<]+|["'>.,;]+$/g, '');
}

function extractEmails(html) {
  if (!html) return [];
  const matches = html.match(EMAIL_REGEX) || [];
  const seen = new Set();
  for (const m of matches) {
    const email = cleanEmail(m);
    if (IGNORED_FILE_EXTENSIONS.test(email)) continue;
    if (IGNORED_EMAIL_SUFFIXES.some((d) => email.endsWith(d))) continue;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) continue;
    seen.add(email);
  }
  return [...seen];
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AurenEmailFinder/1.0)' },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeSite(entry) {
  const { name, rawUrl } = entry;
  const origin = normalizeUrl(rawUrl);

  if (!origin) {
    return { name: name || rawUrl, domain: rawUrl, status: 'error', emails: [], guesses: [], error: 'Invalid URL' };
  }

  let domain;
  try {
    domain = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    domain = origin;
  }

  const found = new Set();
  let anyPageReachable = false;

  // 1. Check the homepage first — cheapest case, most sites list an
  //    email right on the page or in the footer.
  const homeHtml = await fetchWithTimeout(origin, FETCH_TIMEOUT_MS);
  if (homeHtml !== null) {
    anyPageReachable = true;
    extractEmails(homeHtml).forEach((e) => found.add(e));
  }

  // 2. If nothing on the homepage, check the remaining contact/about
  //    paths IN PARALLEL (not one-by-one) so a slow or dead path can't
  //    blow out the total request time.
  if (found.size === 0) {
    const remainingPaths = CONTACT_PATHS.filter((p) => p !== '');
    const pageResults = await Promise.all(
      remainingPaths.map((p) => fetchWithTimeout(origin + p, FETCH_TIMEOUT_MS))
    );
    pageResults.forEach((html) => {
      if (html !== null) {
        anyPageReachable = true;
        extractEmails(html).forEach((e) => found.add(e));
      }
    });
  }

  if (found.size > 0) {
    return { name: name || domain, domain, status: 'found', emails: [...found], guesses: [] };
  }

  if (!anyPageReachable) {
    return { name: name || domain, domain, status: 'error', emails: [], guesses: [], error: 'Site unreachable' };
  }

  const guesses = ['info', 'contact', 'admin', 'hello'].map((p) => `${p}@${domain}`);
  return { name: name || domain, domain, status: 'guessed', emails: [], guesses };
}

// Simple concurrency-limited map so we never fire more than N fetch
// chains at once, regardless of how many URLs are in the batch.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

// ---------- handler ----------

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
  if (rawEntries.length === 0) {
    res.status(400).json({ error: 'No entries provided' });
    return;
  }
  if (rawEntries.length > PER_REQUEST_MAX_URLS) {
    res.status(400).json({
      error: `Max ${PER_REQUEST_MAX_URLS} URLs per request — send in batches (the page does this automatically).`,
    });
    return;
  }

  const entries = rawEntries
    .filter((e) => e && e.rawUrl)
    .map((e) => ({ name: (e.name || '').trim(), rawUrl: String(e.rawUrl).trim() }));

  try {
    const results = await mapWithConcurrency(entries, SITE_CONCURRENCY, scrapeSite);
    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error while scraping.' });
  }
};
