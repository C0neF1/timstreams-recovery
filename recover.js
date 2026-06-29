/**
 * TimStreams Auto-Recovery Script
 * Runs on GitHub Actions when Worker health check fails.
 *
 * Strategy:
 * 1. Launch headless Chromium
 * 2. Load embed page for a test slug, intercept the .m3u8 request
 * 3. Detect URL pattern (simple {domain}/{slug}.m3u8 vs token-based)
 * 4. If simple → store "direct" flow template in KV
 * 5. If token-based → capture all slugs → store "map" flow in KV
 * 6. Update Worker KV via Cloudflare API
 */

const puppeteer = require('puppeteer');

const VILE = 'https://vileembeds.pages.dev';
const API = 'https://api.vixnuvew.uk/api/streams';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN = process.env.CF_API_TOKEN;
const KV_NS = process.env.KV_NAMESPACE_ID;

if (!CF_ACCOUNT || !CF_TOKEN || !KV_NS) {
  console.error('Missing CF_ACCOUNT_ID / CF_API_TOKEN / KV_NAMESPACE_ID');
  process.exit(1);
}

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  TimStreams Auto-Recovery                 ║');
  console.log('╚══════════════════════════════════════════╝');

  // 1. Get stream list
  console.log('\n[1/5] Fetching stream list...');
  const streams = await getStreamList();
  console.log(`  Found ${streams.length} streams`);

  // Pick test slugs: 2 live events + 2 channels
  const events = streams.filter(s => s.category === 'Events');
  const channels = streams.filter(s => s.category === '24/7');
  const testSlugs = [...events.slice(0, 2), ...channels.slice(0, 2)].map(s => s.slug).filter(Boolean);
  console.log(`  Test slugs: ${testSlugs.join(', ')}`);

  // 2. Launch browser
  console.log('\n[2/5] Launching Chromium...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required']
  });

  // 3. Capture m3u8 for test slugs
  console.log('\n[3/5] Capturing m3u8 URLs for test slugs...');
  const captured = {};
  for (const slug of testSlugs) {
    const url = await captureM3u8(browser, slug);
    if (url) {
      captured[slug] = url;
      console.log(`  ✅ ${slug}: ${url.substring(0, 80)}...`);
    } else {
      console.log(`  ❌ ${slug}: not found`);
    }
  }

  // 4. Detect pattern
  console.log('\n[4/5] Detecting URL pattern...');
  const flow = detectPattern(captured, testSlugs);
  console.log(`  Flow type: ${flow.type}`);
  if (flow.type === 'direct') {
    console.log(`  Template: ${flow.template}`);
  } else if (flow.type === 'map') {
    console.log(`  Captured ${Object.keys(flow.urls).length} URLs, expires in 2h`);
    // Need to capture ALL slugs for map type
    console.log('  Capturing all slugs (token-based flow)...');
    for (const s of streams) {
      if (captured[s.slug]) continue;
      const url = await captureM3u8(browser, s.slug);
      if (url) {
        captured[s.slug] = url;
        process.stdout.write('.');
      }
    }
    console.log(`\n  Total captured: ${Object.keys(captured).length}`);
    flow.urls = captured;
    flow.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  }

  await browser.close();

  // 5. Write to KV
  console.log('\n[5/5] Updating Worker KV...');
  flow.updatedAt = Date.now();
  await kvPut('flow', JSON.stringify(flow));
  console.log(`  ✅ Flow written to KV`);

  // Also update stream list cache
  await kvPut('streams', JSON.stringify({ ts: Date.now(), list: streams }));
  console.log(`  ✅ Stream list updated`);

  console.log('\n✅ Recovery complete!\n');
  console.log(`Flow: ${JSON.stringify(flow, null, 2).substring(0, 500)}`);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });

// ── Capture m3u8 URL for a slug via browser ──────────────────
async function captureM3u8(browser, slug) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  });
  await page.setUserAgent(UA);
  await page.setRequestInterception(true);
  page.on('request', (req) => { if (req.url().includes('disable-devtool')) { req.abort(); return; } req.continue(); });

  let m3u8Url = null;
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('.m3u8') && !url.includes('jwpltx') && res.status() === 200 && !m3u8Url) {
      m3u8Url = url;
    }
  });

  // Use a data-URL wrapper to provide iframe context + referrer
  try {
    await page.goto(`${VILE}/embed/${slug}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    // Navigation may timeout, that's ok
  }

  // Wait up to 15s for m3u8
  for (let i = 0; i < 15; i++) {
    if (m3u8Url) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await page.close();
  return m3u8Url;
}

// ── Detect URL pattern from captured URLs ────────────────────
function detectPattern(captured, testSlugs) {
  const urls = Object.entries(captured);
  if (urls.length === 0) {
    return { type: 'direct', template: 'https://cdn011.viaplus.site/{slug}.m3u8' }; // fallback default
  }

  // Check if all URLs follow {domain}/{slug}.m3u8 pattern
  // Pattern: https://cdnXXX.viaplus.site/{slug}.m3u8
  for (const [slug, url] of urls) {
    const expected = url.replace('/' + slug + '.m3u8', '/{slug}.m3u8');
    // Verify: does the URL end with /{slug}.m3u8?
    if (!url.endsWith('/' + slug + '.m3u8')) {
      // Not a simple pattern → token-based
      console.log(`  URL for ${slug} doesn't match simple pattern: ${url.substring(0, 100)}`);
      return { type: 'map', urls: captured };
    }
  }

  // Extract template from first URL
  const [firstSlug, firstUrl] = urls[0];
  const template = firstUrl.replace('/' + firstSlug + '.m3u8', '/{slug}.m3u8');

  // Verify template works for all captured slugs
  for (const [slug, url] of urls) {
    if (template.replace('{slug}', slug) !== url) {
      console.log(`  Template mismatch for ${slug}`);
      return { type: 'map', urls: captured };
    }
  }

  return { type: 'direct', template };
}

// ── Get stream list ──────────────────────────────────────────
async function getStreamList() {
  const res = await fetch(API, { headers: { 'User-Agent': UA } });
  const data = await res.json();
  const list = [];
  for (const cat of data) {
    for (const evt of (cat.events || [])) {
      for (const s of (evt.streams || [])) {
        if (s.vip) continue;
        const m = (s.url || '').match(/vileembeds\.pages\.dev\/embed\/([a-zA-Z0-9_-]+)/);
        if (m) list.push({ slug: m[1], name: evt.name + ' — ' + s.name, category: cat.category, logo: evt.logo || '' });
      }
    }
  }
  return list;
}

// ── Cloudflare KV API ────────────────────────────────────────
async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${KV_NS}/values/${key}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' },
    body: value,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`KV PUT failed (${r.status}): ${text}`);
  }
}
