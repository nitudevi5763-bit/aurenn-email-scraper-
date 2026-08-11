// /api/find-emails.js
//
// Two lead types, two different pitches:
//   1. URL leads (existing behavior) — scrapes homepage/contact pages
//      for an email. These businesses ALREADY have a website, so the
//      draft email pitches the AI Assistant ADD-ON only.
//   2. Name-only leads (new) — no website, so there's nothing to
//      scrape directly. Instead it searches the web (via Google Custom
//      Search) for any public listing (directory, Facebook page, etc.)
//      that might show a contact email. The draft email pitches the
//      full Website + AI Assistant BUNDLE.
//
// Designed to run in small batches from the client so it never hits
// serverless execution-time limits, no matter how many entries the
// user queues up in total.

// ============================================================
// BUSINESS BRAIN — everything the AI needs to know about Auren.ai.
// Edit this whenever your offers, pricing, or tone change — nothing
// else in this file needs to change.
// ============================================================
const BUSINESS_BRAIN = {
  agencyName: 'Auren.ai',

  // Pitched to leads that ALREADY have a website (found via URL).
  offerAiOnly: {
    headline: 'AI Assistant add-on for your existing website',
    price: '₹6,999',
    whatItIncludes: [
      'An AI chatbot/receptionist embedded directly on their current website',
      'Trained on their own services, pricing, and FAQs',
      '24/7 lead capture — answers customer questions and books appointments even after hours',
    ],
  },

  // Pitched to leads with NO website (found via name-only search).
  offerBundle: {
    headline: 'Custom Website + AI Assistant bundle',
    price: '₹8,999',
    whatItIncludes: [
      'A modern, professional business website',
      'An embedded AI chatbot/receptionist trained on their own services, pricing, and FAQs',
      '24/7 lead capture — answers customer questions and books appointments even after hours',
    ],
  },

  proofPoints: [
    'Live AI receptionist demo for a visa/immigration consultancy',
    'Live AI assistant demo for a dental clinic',
    'Live AI assistant demo for an interior design studio',
  ],

  tone: 'Direct, no fluff, founder-to-founder. Short sentences. No corporate buzzwords. Sound like a real person who looked at their specific business, not a mail-merge.',

  emailRules: [
    '80-120 words maximum',
    'First line must reference something specific and true about their business — never a generic opener',
    'One clear gap/opportunity, not a laundry list',
    'Soft call-to-action — offer to send a short demo link, not "book a call"',
    'No exclamation marks, no emojis, no "Hope this finds you well"',
  ],
};

// gemini-2.5-flash is on Google's retirement list for Oct 2026 — using
// their current recommended low-cost, high-volume model instead.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const CUSTOM_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us'];

const IGNORED_EMAIL_SUFFIXES = [
  'sentry.io', 'wixpress.com', 'godaddy.com', 'example.com', 'schema.org',
  'w3.org', 'gstatic.com', 'googleapis.com', 'wordpress.org', 'placeholder.com',
  'facebook.com', 'fb.com', 'justdial.com',
];

const IGNORED_FILE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

const PER_REQUEST_MAX_ENTRIES = 12; // lowered — Gemini/search calls add time per entry
const FETCH_TIMEOUT_MS = 5000;      // per-page fetch timeout
const CONCURRENCY = 3;              // kept modest so Gemini's free-tier RPM limit isn't burst through
const NAME_SEARCH_RESULTS_TO_CHECK = 4; // how many search results to try per name-only lead

// ---------- shared scraping helpers ----------

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

// ---------- Gemini email drafting ----------

function buildPrompt({ name, domain, pageTextSample, hasWebsite }) {
  const offer = hasWebsite ? BUSINESS_BRAIN.offerAiOnly : BUSINESS_BRAIN.offerBundle;

  const pitchAngle = hasWebsite
    ? "They already have a website — pitch ONLY the AI Assistant add-on. Do NOT mention building them a new website, they don't need one."
    : "They do NOT have their own website (we only found them via a directory/social listing) — pitch the full Website + AI Assistant bundle, framed around how much business they're likely losing without a proper site and 24/7 lead capture.";

  return `
You are writing a cold outreach email on behalf of ${BUSINESS_BRAIN.agencyName}.

BUSINESS CONTEXT:
- Offer: ${offer.headline} at ${offer.price}
- What's included: ${offer.whatItIncludes.join('; ')}
- Proof points you can reference if relevant: ${BUSINESS_BRAIN.proofPoints.join('; ')}

PITCH ANGLE FOR THIS LEAD:
${pitchAngle}

TONE:
${BUSINESS_BRAIN.tone}

RULES (follow exactly):
${BUSINESS_BRAIN.emailRules.map((r) => `- ${r}`).join('\n')}

LEAD DETAILS:
- Business name: ${name}
${hasWebsite ? `- Website: ${domain}` : '- No website found — only appears in directory/social listings'}
${pageTextSample ? `- Snippet of text found about them: "${pageTextSample.slice(0, 500)}"` : '- (no extra text available — keep it general but still specific to their industry)'}

Return ONLY valid JSON, no markdown, no code fences, in this exact shape:
{"subject": "...", "body": "..."}
`.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns { ok: true, subject, body } on success, or
// { ok: false, error: "<human-readable reason>" } on failure — never
// silently swallows the problem, so we can see exactly what broke.
// Retries once on 429 (rate limit) since that's usually a transient
// per-minute burst, not a real quota exhaustion.
async function generatePitchEmail(promptParams, apiKey, attempt = 1) {
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not set on the server' };

  let res;
  try {
    res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(promptParams) }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    console.error('Gemini fetch failed:', err.message);
    return { ok: false, error: `Network error calling Gemini: ${err.message}` };
  }

  if (res.status === 429 && attempt < 2) {
    const retryAfterHeader = res.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Math.min(Number(retryAfterHeader) * 1000, 4000) : 3000;
    console.error(`Gemini 429 — retrying once after ${waitMs}ms`);
    await sleep(waitMs);
    return generatePitchEmail(promptParams, apiKey, attempt + 1);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Gemini API error', res.status, errBody);
    const friendly = res.status === 429
      ? 'Gemini free-tier rate limit hit (too many requests per minute) — this lead will get a draft on the next run.'
      : `Gemini API returned ${res.status}: ${errBody.slice(0, 200)}`;
    return { ok: false, error: friendly };
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
    return { ok: false, error: "Could not parse Gemini's response as JSON" };
  }
}

async function draftFor(promptParams, geminiApiKey) {
  const pitchResult = await generatePitchEmail(promptParams, geminiApiKey);
  return {
    pitchEmail: pitchResult.ok ? { subject: pitchResult.subject, body: pitchResult.body } : null,
    pitchError: pitchResult.ok ? null : pitchResult.error,
  };
}

// ---------- MODE 1: URL leads (has a website) ----------

async function scrapeSite(entry, geminiApiKey) {
  const { name, rawUrl } = entry;
  const origin = normalizeUrl(rawUrl);

  if (!origin) {
    return { name: name || rawUrl, domain: rawUrl, hasWebsite: true, status: 'error', emails: [], guesses: [], pitchEmail: null, pitchError: null, error: 'Invalid URL' };
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

  const homeHtml = await fetchWithTimeout(origin, FETCH_TIMEOUT_MS);
  if (homeHtml !== null) {
    anyPageReachable = true;
    extractEmails(homeHtml).forEach((e) => found.add(e));
    pageTextSample = extractTextSample(homeHtml);
  }

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

  const bestName = name || domain;

  if (found.size > 0) {
    const { pitchEmail, pitchError } = await draftFor(
      { name: bestName, domain, pageTextSample, hasWebsite: true },
      geminiApiKey
    );
    return { name: bestName, domain, hasWebsite: true, status: 'found', emails: [...found], guesses: [], pitchEmail, pitchError };
  }

  if (!anyPageReachable) {
    return { name: bestName, domain, hasWebsite: true, status: 'error', emails: [], guesses: [], pitchEmail: null, pitchError: null, error: 'Site unreachable' };
  }

  const guesses = ['info', 'contact', 'admin', 'hello'].map((p) => `${p}@${domain}`);
  const { pitchEmail, pitchError } = await draftFor(
    { name: bestName, domain, pageTextSample, hasWebsite: true },
    geminiApiKey
  );
  return { name: bestName, domain, hasWebsite: true, status: 'guessed', emails: [], guesses, pitchEmail, pitchError };
}

// ---------- MODE 2: name-only leads (no website) ----------

async function searchByName(name, apiKey, cx) {
  const url = `${CUSTOM_SEARCH_URL}?key=${apiKey}&cx=${cx}&num=${NAME_SEARCH_RESULTS_TO_CHECK}&q=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Custom Search API returned ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.items || []).map((item) => ({ link: item.link, title: item.title, snippet: item.snippet || '' }));
}

async function scrapeNameOnlyLead(entry, geminiApiKey, searchApiKey, searchCx) {
  const { name } = entry;

  if (!searchApiKey || !searchCx) {
    return {
      name, domain: null, hasWebsite: false, status: 'error',
      emails: [], guesses: [], pitchEmail: null, pitchError: null,
      error: 'GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_CX not set — needed to search for businesses by name.',
    };
  }

  let searchResults;
  try {
    searchResults = await searchByName(name, searchApiKey, searchCx);
  } catch (err) {
    return { name, domain: null, hasWebsite: false, status: 'error', emails: [], guesses: [], pitchEmail: null, pitchError: null, error: err.message };
  }

  const found = new Set();
  let sourceDomain = null;
  let pageTextSample = '';

  for (const result of searchResults) {
    const html = await fetchWithTimeout(result.link, FETCH_TIMEOUT_MS);
    if (!html) continue;
    const emails = extractEmails(html);
    if (emails.length > 0) {
      emails.forEach((e) => found.add(e));
      try { sourceDomain = new URL(result.link).hostname.replace(/^www\./, ''); } catch {}
      pageTextSample = extractTextSample(html) || result.snippet;
      break; // stop at the first listing that actually has an email
    }
    if (!pageTextSample) pageTextSample = result.snippet || extractTextSample(html);
  }

  if (found.size > 0) {
    const { pitchEmail, pitchError } = await draftFor(
      { name, domain: `listed via ${sourceDomain}`, pageTextSample, hasWebsite: false },
      geminiApiKey
    );
    return { name, domain: `via ${sourceDomain} (no own website)`, hasWebsite: false, status: 'found', emails: [...found], guesses: [], pitchEmail, pitchError };
  }

  if (searchResults.length === 0) {
    return { name, domain: null, hasWebsite: false, status: 'error', emails: [], guesses: [], pitchEmail: null, pitchError: null, error: 'No search results found for this name — try adding the city.' };
  }

  // No email found anywhere, but we can still draft the pitch for
  // manual sending (WhatsApp, or once you find an email by hand).
  const { pitchEmail, pitchError } = await draftFor(
    { name, domain: null, pageTextSample, hasWebsite: false },
    geminiApiKey
  );
  return {
    name, domain: 'no website — no public email found', hasWebsite: false, status: 'guessed',
    emails: [], guesses: [], pitchEmail, pitchError,
  };
}

// ---------- concurrency + handler ----------

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
  if (rawEntries.length > PER_REQUEST_MAX_ENTRIES) {
    res.status(400).json({
      error: `Max ${PER_REQUEST_MAX_ENTRIES} entries per request — send in batches (the page does this automatically).`,
    });
    return;
  }

  // Each entry is either { name, rawUrl } (has a website) or
  // { name, rawUrl: null } (name-only — no website).
  const entries = rawEntries
    .filter((e) => e && (e.rawUrl || e.name))
    .map((e) => ({
      name: (e.name || '').trim(),
      rawUrl: e.rawUrl ? String(e.rawUrl).trim() : null,
    }));

  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const searchApiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || '';
  const searchCx = process.env.GOOGLE_CUSTOM_SEARCH_CX || '';

  try {
    const results = await mapWithConcurrency(entries, CONCURRENCY, (entry) =>
      entry.rawUrl
        ? scrapeSite(entry, geminiApiKey)
        : scrapeNameOnlyLead(entry, geminiApiKey, searchApiKey, searchCx)
    );
    res.status(200).json({
      results,
      geminiEnabled: Boolean(geminiApiKey),
      nameSearchEnabled: Boolean(searchApiKey && searchCx),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error while scraping.' });
  }
};
