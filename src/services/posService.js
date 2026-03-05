/**
 * posService.js
 * Scans raw HTML for known POS / ordering platform fingerprints.
 * Ported from filter_nearby_pos.py / scrape_restaurants.py (Python reference).
 */

const POS_PLATFORMS = {
  Toast:            ['toasttab.com', 'pos.toasttab', 'cdn.toasttab', 'toast-pos'],
  Square:           ['squareup.com', 'square.com/store', 'squarespace.com/order', 'order.squareup', 'squareup.com/appointments'],
  Clover:           ['clover.com', 'cloverordernow.com', 'clover-cdn'],
  Olo:              ['olocdn.com', 'olo.com', 'olosdk'],
  TouchBistro:      ['touchbistro.com'],
  Lightspeed:       ['lightspeedpos.com', 'lightspeedhq.com', 'lsretail.com'],
  Revel:            ['revelsystems.com', 'revel-pos'],
  SpotOn:           ['spoton.com', 'spoton.net'],
  Heartland:        ['heartlandpaymentsystems.com', 'heartland.us'],
  PAX:              ['paxstore.us', 'pax.us'],
  ChowNow:          ['chownow.com', 'chownowcdn.com'],
  Slice:            ['slicelife.com', 'sliceup.com'],
  'DoorDash Store': ['order.online/', 'mydoordash.com', 'doordash.com/store'],
  'Uber Eats':      ['ubereats.com/store', 'order.ubereats'],
  Grubhub:          ['grubhub.com/restaurant', 'seamless.com/restaurant'],
  Bopple:           ['bopple.com'],
  Flipdish:         ['flipdish.com', 'flipdishcdn'],
  HungerRush:       ['hungerrush.com', 'revention.com'],
  'NCR Aloha':      ['ncralohapoi.com', 'ncr.com/aloha'],
  Lavu:             ['poslavu.com', 'lavu.com'],
  Shopify:          ['cdn.shopify.com', 'myshopify.com'],
};

/**
 * @param {string} html - Raw page HTML
 * @returns {{ platform: string, confidence: string, allDetected: string[] }}
 */
export function detectPOS(html) {
  if (!html) {
    return { platform: 'Unknown', confidence: 'none', allDetected: [] };
  }

  const lower = html.toLowerCase();
  const detected = [];

  for (const [platform, patterns] of Object.entries(POS_PLATFORMS)) {
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
      detected.push(platform);
    }
  }

  if (detected.length > 0) {
    return { platform: detected[0], confidence: 'high', allDetected: detected };
  }

  return { platform: 'Unknown', confidence: 'none', allDetected: [] };
}
