/**
 * scrapeService.js
 * Google Maps restaurant scraper with GPT-4o-mini ICP filtering.
 * Full JS port of scrape_restaurants.py (Python reference).
 *
 * Runs in a background async task; callers poll scrapeState for progress.
 */

import { chromium } from 'playwright';
import * as leadsService from './leadsService.js';
import { detectPOS } from './posService.js';
import { evaluateICP } from './icpService.js';

// ── Shared state (one scrape job at a time) ───────────────────────────────────

export const scrapeState = {
  running: false,
  lines: [],
  done: true,
  error: null,
};

function log(line) {
  scrapeState.lines.push(line);
  console.log(line);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Kick off a background scrape job. Throws if one is already running.
 * @param {{ location: string, limit?: number, minScore?: number, reset?: boolean }} opts
 */
export async function startScrape({ location, limit = 20, minScore = 6, reset = false }) {
  if (scrapeState.running) throw new Error('Scrape already in progress');

  Object.assign(scrapeState, { running: true, lines: [], done: false, error: null });

  // Fire-and-forget — intentionally not awaited
  runScrape({ location, limit, minScore, reset })
    .catch((err) => {
      scrapeState.error = err.message;
      log(`\n❌ Fatal error: ${err.message}`);
    })
    .finally(() => {
      scrapeState.running = false;
      scrapeState.done = true;
    });
}

// ── Core scrape logic ─────────────────────────────────────────────────────────

async function runScrape({ location, limit, minScore, reset }) {
  if (reset) {
    await leadsService.deleteBySource(location);
    log(`🔄 Reset complete for '${location}'`);
  }

  const existingUrls = await leadsService.getScrapedUrls(location);
  log(`📊 '${location}'`);
  log(`   Already visited : ${existingUrls.size}`);
  log(`   Requesting now  : ${limit} new (min ICP score: ${minScore}/10)\n`);

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
    });

    const mapsPage    = await context.newPage();
    const websitePage = await context.newPage();

    // ── Load Maps search ──
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(`restaurants ${location}`)}`;
    log('📍 Loading Google Maps search results...');
    await mapsPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await mapsPage.waitForTimeout(4000);

    // Accept cookie consent if it appears
    for (const label of ['Accept all', 'Agree', 'I agree', 'Accept']) {
      try {
        const btn = await mapsPage.$(`button:has-text("${label}")`);
        if (btn) { await btn.click(); await mapsPage.waitForTimeout(1000); break; }
      } catch { /* ignore */ }
    }

    const newUrls = await scrollAndCollectUrls(mapsPage, limit, existingUrls);

    if (newUrls.length === 0) {
      log('⚠  No new listings found. Try reset or a different location.');
      return;
    }

    log(`\n✅ ${newUrls.length} new listings — scraping + ICP filtering...\n`);
    log('─'.repeat(65));

    let matched = 0;
    let rejected = 0;

    for (let i = 0; i < newUrls.length; i++) {
      const url = newUrls[i];
      log(`\n[${String(i + 1).padStart(2, '0')}/${newUrls.length}] Scraping Maps listing...`);

      try {
        await mapsPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      } catch {
        log('    ❌ Failed to load Maps page, skipping.');
        await leadsService.markScraped(location, url.split('?')[0]);
        continue;
      }

      const detail = await extractMapsDetail(mapsPage);
      detail.maps_url = url;
      detail.source   = location;

      log(`    📌 ${detail.name ?? 'Unknown'}`);
      log(`       ⭐ ${detail.rating ?? '?'} | 💬 ${detail.review_count ?? '?'} reviews`);
      log(`       📞 ${detail.phone ?? '—'} | 🌐 ${detail.website ?? '—'}`);

      // ── Fetch website + detect POS ──
      let websiteText = '';
      if (detail.website) {
        log('    🌐 Fetching website...');
        const [text, html] = await fetchWebsite(websitePage, detail.website);
        websiteText = text;
        log(`       → Got ${text.length} chars`);

        const pos = detectPOS(html);
        detail.pos = pos;
        log(
          pos.platform !== 'Unknown'
            ? `       💳 POS: ${pos.allDetected.join(', ')} (${pos.confidence})`
            : '       💳 POS: not detected',
        );
      } else {
        detail.pos = { platform: 'Unknown', confidence: 'none', allDetected: [] };
      }

      // ── ICP evaluation ──
      log('    🤖 Evaluating ICP with GPT-4o-mini...');
      const icp = await evaluateICP(detail, websiteText);
      detail.icp = icp;

      const isMatch = icp.icp_match && icp.score >= minScore;
      const verdict = isMatch ? '✅ MATCH' : '❌ REJECT';
      log(`    ${verdict} — Score: ${icp.score}/10 (busy: ${icp.busy_score}/10, youth: ${icp.youth_score}/10)`);
      log(`       💬 ${icp.reason}`);
      if (icp.menu_signals?.length) {
        log(`       🍔 Signals: ${icp.menu_signals.slice(0, 6).join(', ')}`);
      }

      if (isMatch) {
        await leadsService.upsert(detail);
        matched++;
      } else {
        rejected++;
      }

      await leadsService.markScraped(location, url.split('?')[0]);
      await sleep(500);
    }

    log(`\n${'═'.repeat(65)}`);
    log('  RUN COMPLETE');
    log(`  ✅ ICP matched : ${matched}`);
    log(`  ❌ Rejected    : ${rejected}`);
    log(`${'═'.repeat(65)}\n`);

  } finally {
    await browser.close();
  }
}

// ── Scroll & collect listing URLs ─────────────────────────────────────────────

async function scrollAndCollectUrls(page, need, skipUrls) {
  const seenAll  = new Set();
  const newUrls  = [];

  log(`  ↕  Scrolling to collect ${need} new listings (skipping ${skipUrls.size} already scraped)...`);

  for (let attempt = 0; attempt < 80; attempt++) {
    const links = await page.$$('a[href*="/maps/place/"]');

    for (const el of links) {
      const href = await el.getAttribute('href');
      if (!href) continue;
      const clean = href.split('?')[0];
      if (seenAll.has(clean)) continue;
      seenAll.add(clean);
      if (!skipUrls.has(clean) && !newUrls.includes(href)) {
        newUrls.push(href);
      }
    }

    if (newUrls.length >= need) break;

    try {
      const feed = await page.$('div[role="feed"]');
      if (feed) {
        await feed.evaluate((el) => el.scrollBy(0, 1200));
      } else {
        await page.evaluate(() => window.scrollBy(0, 1200));
      }
    } catch { /* ignore */ }

    await page.waitForTimeout(1500);

    try {
      const endEl = await page.$(
        'span:has-text("end of list"), p:has-text("No more results")',
      );
      if (endEl) { log('  ⚠  Reached end of Maps results.'); break; }
    } catch { /* ignore */ }
  }

  return newUrls.slice(0, need);
}

// ── Google Maps detail extractor ─────────────────────────────────────────────

async function extractMapsDetail(page) {
  const detail = {};

  try {
    await page.waitForSelector('[role="main"]', { timeout: 8000 });
  } catch { /* ignore */ }
  await page.waitForTimeout(2500);

  // NAME
  for (const sel of ['h1.DUwDvf', 'h1[class*="fontHeadline"]', '[role="main"] h1', 'h1']) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = (await el.innerText()).trim();
        if (text) { detail.name = text; break; }
      }
    } catch { /* ignore */ }
  }

  // ADDRESS
  for (const sel of [
    'button[data-item-id="address"]',
    '[data-item-id="address"]',
    'button[aria-label*="Address"]',
    'button[aria-label*="address"]',
  ]) {
    try {
      const el = await page.$(sel);
      if (el) {
        const label = (await el.getAttribute('aria-label')) ?? '';
        const text  = (await el.innerText()).trim();
        const addr  = label.replace(/^Address:\s*/i, '').trim() || text;
        if (addr) { detail.address = addr; break; }
      }
    } catch { /* ignore */ }
  }

  if (!detail.address) {
    try {
      const body = await page.innerText('[role="main"]');
      const m = body.match(/\d+\s+\w[\w\s,.]+(?:Ave|St|Rd|Blvd|Dr|Ln|Way|Ct|Pl|Hwy|Pike|Route)[^\n]*/i);
      if (m) detail.address = m[0].trim();
    } catch { /* ignore */ }
  }

  // PHONE
  for (const sel of [
    'button[data-item-id^="phone:tel"]',
    '[data-item-id^="phone"]',
    'button[aria-label*="Phone"]',
    'button[aria-label*="phone"]',
    'a[href^="tel:"]',
  ]) {
    try {
      const el = await page.$(sel);
      if (el) {
        const label = (await el.getAttribute('aria-label')) ?? '';
        const href  = (await el.getAttribute('href')) ?? '';
        const text  = (await el.innerText()).trim();
        const phone = label.replace(/^Phone:\s*/i, '').trim()
          || href.replace('tel:', '').trim()
          || text;
        if (phone && /\d{3}/.test(phone)) { detail.phone = phone; break; }
      }
    } catch { /* ignore */ }
  }

  if (!detail.phone) {
    try {
      const body = await page.innerText('[role="main"]');
      const phones = body.match(/\(?\d{3}\)?[\s\-.]\d{3}[\s\-.]\d{4}/g);
      if (phones) detail.phone = phones[0].trim();
    } catch { /* ignore */ }
  }

  // WEBSITE
  for (const sel of [
    'a[data-item-id="authority"]',
    '[data-item-id="authority"]',
    'a[aria-label*="website" i]',
    'a[href*="http"]:not([href*="google"]):not([href*="goo.gl"])',
  ]) {
    try {
      const el = await page.$(sel);
      if (el) {
        const href = (await el.getAttribute('href')) ?? '';
        if (href && !href.includes('google') && !href.includes('goo.gl')) {
          detail.website = href.trim();
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // EMAIL
  try {
    const html   = await page.content();
    const emails = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) ?? [];
    const legit  = emails.filter(
      (e) =>
        !['google', 'gstatic', 'schema', 'sentry', 'example', 'wixpress', 'squarespace', 'shopify']
          .some((x) => e.toLowerCase().includes(x)) &&
        !/\.(png|jpg|svg|gif|webp)$/i.test(e),
    );
    if (legit.length) detail.email = legit[0];
  } catch { /* ignore */ }

  // RATING + REVIEW COUNT
  try {
    const bodyText = await page.innerText('[role="main"]');

    const ratingM = bodyText.match(/\b([1-5]\.\d)\b/);
    if (ratingM) detail.rating = ratingM[1];

    let rcM = bodyText.match(/([\d,]+)\s*(?:reviews?|ratings?)/i);
    if (!rcM) rcM = bodyText.match(/\(([\d,]+)\)/);
    if (rcM) detail.review_count = parseInt(rcM[1].replace(/,/g, ''), 10);
  } catch { /* ignore */ }

  // REVIEW SNIPPETS
  try {
    const reviewEls = await page.$$('[data-review-id] span, [class*="wiI7pd"]');
    const snippets  = [];
    for (const el of reviewEls.slice(0, 8)) {
      const t = (await el.innerText()).trim();
      if (t.length > 30) snippets.push(t.slice(0, 300));
    }
    if (snippets.length) detail.review_snippets = snippets;
  } catch { /* ignore */ }

  // CATEGORY HINT
  try {
    const bodyText = await page.innerText('[role="main"]');
    const catM = bodyText.slice(0, 1000).match(
      /\b(burger|taco|shawarma|chicken|pizza|sushi|ramen|wings|bbq|sandwich|wrap|poke|korean|mexican|mediterranean|lebanese|steakhouse|diner|seafood|italian|chinese|indian|thai|vegan)[^\n]{0,40}/i,
    );
    if (catM) detail.category_hint = catM[0].trim();
  } catch { /* ignore */ }

  return detail;
}

// ── Website fetcher ───────────────────────────────────────────────────────────

async function fetchWebsite(page, url, maxChars = 4000) {
  if (!url || url.includes('google')) return ['', ''];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1500);

    const textParts = [];
    const htmlParts = [];

    try { textParts.push(await page.innerText('body')); } catch { /* ignore */ }
    try { htmlParts.push(await page.content()); }        catch { /* ignore */ }

    // Try to follow menu/order link for better POS signal detection
    for (const linkText of ['Menu', 'Our Menu', 'Food', 'Order Online', 'Order']) {
      try {
        const menuLink = await page.$(`a:has-text("${linkText}")`);
        if (menuLink) {
          let href = (await menuLink.getAttribute('href')) ?? '';
          if (href && !href.startsWith('http')) {
            const base = url.match(/https?:\/\/[^/]+/)?.[0] ?? '';
            href = `${base}/${href.replace(/^\//, '')}`;
          }
          if (href && !href.includes('google')) {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
            await page.waitForTimeout(1000);
            try { textParts.push(await page.innerText('body')); } catch { /* ignore */ }
            try { htmlParts.push(await page.content()); }        catch { /* ignore */ }
          }
          break;
        }
      } catch { /* ignore */ }
    }

    const text = textParts.join('\n').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    const html = htmlParts.join('\n');
    return [text, html];

  } catch (err) {
    return [`[Could not fetch website: ${err.message}]`, ''];
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
