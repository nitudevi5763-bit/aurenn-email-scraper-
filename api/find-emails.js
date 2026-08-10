// /api/find-emails.js
//
// Scrapes a website's homepage + common contact/about paths for a
// visible email address. Falls back to common-pattern guesses when
// nothing is found. For every lead that ends up with a real or
// guessed email, it also asks Gemini to draft a short personalized
// pitch email using a snippet of that business's own site copy.
//
// Designed to run in small batches from the client so it never hits
// serverless execution-time limits, no matter how many URLs the user
// queues up in total.

// ============================================================
// BUSINESS BRAIN — everything the AI needs to know about Auren.ai.
// Edit this whenever your offer, pricing, or tone changes — nothing
// else in this file needs to change.
// ============================================================
const BUSINESS_BRAIN = {
  agencyName: 'Auren.ai',
  offerHeadline: 'Custom Website + AI Assistant bundle',
  price: '₹8,999',
  whatItIncludes: [
    'A modern, professional business website',
    'An embedded AI chatbot/receptionist trained on their own services, pricing, and FAQs',
    '24/7 lead capture — answers customer questions and books appointments even after hours',
  ],
  proofPoints: [
    'Live AI receptionist demo for a visa/immigration consultancy',
    'Live AI assistant demo for a dental clinic',
    'Live AI assistant demo for an interior design studio',
  ],
  tone: 'Direct, no fluff, founder-to-founder. Short sentences. No corporate buzzwords. Sound like a real person who looked at their specific business, not a mail-merge.',
  emailRules: [
    '80-120 words maximum',
    'First line must reference something specific and true about their business or website — never a generic opener',
    'One clear gap/opportunity, not a laundry list',
    'Soft call-to-action — offer to send a short demo link, not "book a call"',
    'No exclamation marks, no emojis, no "Hope this finds you well"',
  ],
};

// gemini-2.5-flash is on Google's retirement list for Oct 2026 — using
// their current recommended low-cost, high-volume model instead.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us'];

const IGNORED_EMAIL_SUFFIXES = [
  'sentry.io', 'wixpress.com', 'godaddy.com', 'example.com', 'schema.org',
  'w3.org', 'gstatic.com', 'googleapis.com', 'wordpress.org', 'placeholder.com',
];

const IGNORED_FILE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

const PER_REQUEST_MAX_URLS = 12;   // lowered slightly — Gemini calls add time per site
const FETCH_TIMEOUT_MS = 5000;     // per-page fetch timeout
const SITE_CONCURRENCY = 5;        // how many sites we scrape + draft at once per call

// ---------- scraping helpers (unchanged) ----------

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

function extractTextSample(html, maxLen = 1200) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
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

// ---------- NEW: Gemini email drafting ----------

function buildPrompt(name, domain, pageTextSample) {
  return `
You are writing a cold outreach email on behalf of ${BUSINESS_BRAIN.agencyName}.

BUSINESS CONTEXT:
- Offer: ${BUSINESS_BRAIN.offerHeadline} at ${BUSINESS_BRAIN.price}
- What's included: ${BUSINESS_BRAIN.whatItIncludes.join('; ')}
- Proof points you can reference if relevant: ${BUSINESS_BRAIN.proofPoints.join('; ')}

TONE:
${BUSINESS_BRAIN.tone}

RULES (follow exactly):
${BUSINESS_BRAIN.emailRules.map((r) => `- ${r}`).join('\n')}

LEAD DETAILS:
- Business name: ${name}
- Website: ${domain}
${pageTextSample ? `- Snippet of their website text: "${pageTextSample.slice(0, 500)}"` : '- (no website text available — keep it general but still specific to their industry)'}

Return ONLY valid JSON, no markdown, no code fences, in this exact shape:
{"subject": "...", "body": "..."}
`.trim();
}

// Returns { ok: true, subject, body } on success, or
// { ok: false, error: "<human-readable reason>" } on failure — never
// silently swallows the problem, so we can see exactly what broke.
async function generatePitchEmail(name, domain, pageTextSample, apiKey) {
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set on the server' };

  let res;
  try {
    res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(name, domain, pageTextSample) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    console.error('Gemini fetch failed:', err.message);
    return { ok: false, error: `Network error calling Gemini: ${err.message}` };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Gemini API error', res.status, errBody);
    return { ok: false, error: `Gemini API returned ${res.status}: ${errBody.slice(0, 200)}` };
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (!rawText) {
    const blockReason = data.promptFeedback?.blockReason;
    console.error('Gemini returned no text.', JSON.stringify(data).slice(0, 300));
    return { ok: false, error: blockReason ? `Gemini blocked the response: ${blockReason}` : 'Gemini returned an empty response' };
  }

  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.subject || !parsed.body) {
      return { ok: false, error: 'Gemini response was missing subject/body' };
    }
    return { ok: true, subject: parsed.subject, body: parsed.body };
  } catch (err) {
    console.error('Failed to parse Gemini JSON:', cleaned.slice(0, 300));
    return { ok: false, error: 'Could not parse Gemini\'s response as JSON' };
  }
}

// ---------- scrape + draft, per site ----------

async function scrapeSite(entry, geminiApiKey) {
  const { name, rawUrl } = entry;
  const origin = normalizeUrl(rawUrl);

  if (!origin) {
    return { name: name || rawUrl, domain: rawUrl, status: 'error', emails: [], guesses: [], pitchEmail: null, error: 'Invalid URL' };
  }

  let domain;
  try {
    domain = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    domain = origin;
  }

  const found = new Set();
  let anyPageReachable = false;
  let pageTextSample = '';

  // 1. Check the homepage first.
  const homeHtml = await fetchWithTimeout(origin, FETCH_TIMEOUT_MS);
  if (homeHtml !== null) {
    anyPageReachable = true;
    extractEmails(homeHtml).forEach((e) => found.add(e));
    pageTextSample = extractTextSample(homeHtml);
  }

  // 2. If nothing on the homepage, check remaining contact/about paths in parallel.
  if (found.size === 0) {
    const remainingPaths = CONTACT_PATHS.filter((p) => p !== '');
    const pageResults = await Promise.all(
      remainingPaths.map((p) => fetchWithTimeout(origin + p, FETCH_TIMEOUT_MS))
    );
    pageResults.forEach((html) => {
      if (html !== null) {
        anyPageReachable = true;
        extractEmails(html).forEach((e) => found.add(e));
        if (!pageTextSample) pageTextSample = extractTextSample(html);
      }
    });
  }

  const bestNameForPrompt = name || domain;

  if (found.size > 0) {
    const pitchResult = await generatePitchEmail(bestNameForPrompt, domain, pageTextSample, geminiApiKey);
    const pitchEmail = pitchResult.ok ? { subject: pitchResult.subject, body: pitchResult.body } : null;
    const pitchError = pitchResult.ok ? null : pitchResult.error;
    return { name: bestNameForPrompt, domain, status: 'found', emails: [...found], guesses: [], pitchEmail, pitchError };
  }

  if (!anyPageReachable) {
    return { name: bestNameForPrompt, domain, status: 'error', emails: [], guesses: [], pitchEmail: null, pitchError: null, error: 'Site unreachable' };
  }

  const guesses = ['info', 'contact', 'admin', 'hello'].map((p) => `${p}@${domain}`);
  const pitchResult = await generatePitchEmail(bestNameForPrompt, domain, pageTextSample, geminiApiKey);
  const pitchEmail = pitchResult.ok ? { subject: pitchResult.subject, body: pitchResult.body } : null;
  const pitchError = pitchResult.ok ? null : pitchResult.error;
  return { name: bestNameForPrompt, domain, status: 'guessed', emails: [], guesses, pitchEmail, pitchError };
}

// Simple concurrency-limited map.
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

  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  try {
    const results = await mapWithConcurrency(
      entries,
      SITE_CONCURRENCY,
      (entry) => scrapeSite(entry, geminiApiKey)
    );
    res.status(200).json({ results, geminiEnabled: Boolean(geminiApiKey) });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error while scraping.' });
  }
};
