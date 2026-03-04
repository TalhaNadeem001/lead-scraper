"""
Google Maps Restaurant Scraper — with ICP filtering via GPT-4o-mini

ICP criteria:
  1. Busy restaurant that gets a lot of orders (high review count, mentions of wait times, popular)
  2. Caters to a younger generation (burgers, tacos, shawarma, Nashville chicken, pizza, wings, etc.)

Approach:
  - Scrape Google Maps for restaurant name, address, phone, website, rating, review count
  - Pull the restaurant's website text (menu, about page) if available
  - Also grab Google Maps review snippets for "busy" signals
  - Send all context to GPT-4o-mini for ICP scoring
  - Only ICP-matched restaurants are saved to the results file
  - Rejected ones go to a separate audit file

Usage:
  python scrape_restaurants.py --location "dearborn MI" --limit 20
  python scrape_restaurants.py --location "dearborn MI" --limit 20   # auto-skips already scraped
  python scrape_restaurants.py --location "dearborn MI" --reset      # start fresh
  python scrape_restaurants.py --location "dearborn MI" --debug      # dump HTML of first listing

Output files (auto-named per location):
  {slug}_progress.json   — every URL visited (prevents re-scraping)
  {slug}_results.json    — ICP-matched restaurants only
  {slug}_rejected.json   — restaurants that failed ICP (for audit)

Requirements:
  pip install playwright openai && playwright install chromium
"""

import argparse
import json
import os
import re
import time
import urllib.parse

from playwright.sync_api import sync_playwright
from openai import OpenAI

# ── Config ────────────────────────────────────────────────────────────────────

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

ICP_SYSTEM_PROMPT = """You are a restaurant lead qualification assistant.

Your job is to evaluate whether a restaurant matches our Ideal Customer Profile (ICP):

ICP CRITERIA:
1. BUSY / HIGH ORDER VOLUME — The restaurant gets a lot of orders. Signals include:
   - High number of Google reviews (200+ is a strong signal, 500+ is very strong)
   - Review text mentioning busy periods, wait times, lunch/dinner rushes, online ordering
   - Uses a premium POS system (Toast, Square, Clover, Olo, etc.) — strong indicator of volume
   - Popular or well-known locally

2. YOUNGER DEMOGRAPHIC — The menu or brand appeals to a younger crowd (Gen Z / Millennials). 
   Strong matches include: burgers, smash burgers, tacos, shawarma, Nashville hot chicken,
   wings, boba, sushi burritos, loaded fries, birria, Korean BBQ, ramen, poke bowls,
   pizza, sandwiches, wraps, cheesesteaks, quesadillas, bowls.
   Weak/no match: fine dining, traditional diners, senior-focused menus, formal steakhouses,
   traditional Chinese/Indian/Italian sit-down, high-end prix fixe.

Respond ONLY with a valid JSON object in this exact format (no markdown, no extra text):
{
  "icp_match": true or false,
  "score": <integer 1-10, where 10 is a perfect ICP fit>,
  "busy_score": <integer 1-10>,
  "youth_score": <integer 1-10>,
  "reason": "<1-2 sentence explanation of the verdict>",
  "menu_signals": ["list", "of", "youth-friendly", "menu", "items", "detected"]
}"""


# ── POS Platform fingerprints ─────────────────────────────────────────────────
# Each entry: "Platform Name" -> list of URL/string patterns to search in raw HTML

POS_PLATFORMS = {
    "Toast":          ["toasttab.com", "pos.toasttab", "cdn.toasttab", "toast-pos"],
    "Square":         ["squareup.com", "square.com/store", "squarespace.com/order",
                       "order.squareup", "squareup.com/appointments"],
    "Clover":         ["clover.com", "cloverordernow.com", "clover-cdn"],
    "Olo":            ["olocdn.com", "olo.com", "olosdk"],
    "TouchBistro":    ["touchbistro.com"],
    "Lightspeed":     ["lightspeedpos.com", "lightspeedhq.com", "lsretail.com"],
    "Revel":          ["revelsystems.com", "revel-pos"],
    "SpotOn":         ["spoton.com", "spoton.net"],
    "Heartland":      ["heartlandpaymentsystems.com", "heartland.us"],
    "PAX":            ["paxstore.us", "pax.us"],
    "ChowNow":        ["chownow.com", "chownowcdn.com"],
    "Slice":          ["slicelife.com", "sliceup.com"],
    "DoorDash Store": ["order.online/", "mydoordash.com", "doordash.com/store"],
    "Uber Eats":      ["ubereats.com/store", "order.ubereats"],
    "Grubhub":        ["grubhub.com/restaurant", "seamless.com/restaurant"],
    "Bopple":         ["bopple.com"],
    "Flipdish":       ["flipdish.com", "flipdishcdn"],
    "HungerRush":     ["hungerrush.com", "revention.com"],
    "NCR Aloha":      ["ncralohapoi.com", "ncr.com/aloha"],
    "Lavu":           ["poslavu.com", "lavu.com"],
    "Shopify":        ["cdn.shopify.com", "myshopify.com"],
}


def detect_pos_platform(html: str) -> dict:
    """
    Scan raw HTML for POS platform fingerprints.
    Returns:
      {
        "platform": "Toast" | "Unknown",
        "confidence": "high" | "none",
        "all_detected": ["Toast", ...]   # in case multiple signals found
      }
    """
    if not html:
        return {"platform": "Unknown", "confidence": "none", "all_detected": []}

    html_lower = html.lower()
    detected = []

    for platform, patterns in POS_PLATFORMS.items():
        for pattern in patterns:
            if pattern.lower() in html_lower:
                detected.append(platform)
                break  # one match per platform is enough

    if detected:
        return {
            "platform": detected[0],          # primary (first match)
            "confidence": "high",
            "all_detected": detected,
        }

    return {"platform": "Unknown", "confidence": "none", "all_detected": []}


# ── Helpers ───────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', text.lower()).strip('_')


def build_search_url(location: str) -> str:
    query = urllib.parse.quote(f"restaurants {location}")
    return f"https://www.google.com/maps/search/{query}"


def load_json_list(path: str) -> list:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def load_json_set(path: str) -> set:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return set(json.load(f))
    return set()


def save_json(path: str, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ── Website fetcher (text + raw HTML for POS scanning) ───────────────────────

def fetch_website(page, url: str, max_chars: int = 4000) -> tuple:
    """
    Visit a restaurant website and return (visible_text, raw_html).
    raw_html is used for POS fingerprint scanning.
    visible_text is passed to GPT for ICP analysis.
    """
    if not url or "google" in url:
        return "", ""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(1500)

        text_parts = []
        html_parts = []

        # Capture homepage text + HTML
        try:
            text_parts.append(page.inner_text("body"))
        except Exception:
            pass
        try:
            html_parts.append(page.content())
        except Exception:
            pass

        # Follow menu/order link if present — POS scripts often live there
        for link_text in ["Menu", "Our Menu", "Food", "Order Online", "Order"]:
            try:
                menu_link = page.query_selector(f'a:has-text("{link_text}")')
                if menu_link:
                    href = menu_link.get_attribute("href") or ""
                    if href and not href.startswith("http"):
                        base = re.match(r'https?://[^/]+', url)
                        href = (base.group(0) if base else "") + "/" + href.lstrip("/")
                    if href and "google" not in href:
                        page.goto(href, wait_until="domcontentloaded", timeout=10000)
                        page.wait_for_timeout(1000)
                        try:
                            text_parts.append(page.inner_text("body"))
                        except Exception:
                            pass
                        try:
                            html_parts.append(page.content())
                        except Exception:
                            pass
                    break
            except Exception:
                pass

        combined_text = re.sub(r'\s+', ' ', "\n".join(text_parts)).strip()
        combined_html = "\n".join(html_parts)
        return combined_text[:max_chars], combined_html

    except Exception as e:
        return f"[Could not fetch website: {e}]", ""


# ── Google Maps detail extractor ──────────────────────────────────────────────

def extract_maps_detail(page, debug=False, debug_index=0) -> dict:
    detail = {}

    try:
        page.wait_for_selector('[role="main"]', timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(2500)

    if debug and debug_index == 1:
        with open("debug_listing.html", "w", encoding="utf-8") as f:
            f.write(page.content())
        try:
            with open("debug_listing.txt", "w", encoding="utf-8") as f:
                f.write(page.inner_text('[role="main"]'))
        except Exception:
            pass
        print("    💾 Saved debug_listing.html / debug_listing.txt")

    # NAME
    for sel in ['h1.DUwDvf', 'h1[class*="fontHeadline"]', '[role="main"] h1', 'h1']:
        try:
            el = page.query_selector(sel)
            if el:
                text = el.inner_text().strip()
                if text:
                    detail["name"] = text
                    break
        except Exception:
            pass

    # ADDRESS
    for sel in [
        'button[data-item-id="address"]', '[data-item-id="address"]',
        'button[aria-label*="Address"]', 'button[aria-label*="address"]',
    ]:
        try:
            el = page.query_selector(sel)
            if el:
                label = el.get_attribute("aria-label") or ""
                text = el.inner_text().strip()
                addr = re.sub(r'^Address:\s*', '', label, flags=re.I).strip() or text
                if addr:
                    detail["address"] = addr
                    break
        except Exception:
            pass

    if "address" not in detail:
        try:
            body = page.inner_text('[role="main"]')
            m = re.search(
                r'\d+\s+\w[\w\s,\.]+(?:Ave|St|Rd|Blvd|Dr|Ln|Way|Ct|Pl|Hwy|Pike|Route)[^\n]*',
                body, re.I
            )
            if m:
                detail["address"] = m.group(0).strip()
        except Exception:
            pass

    # PHONE
    for sel in [
        'button[data-item-id^="phone:tel"]', '[data-item-id^="phone"]',
        'button[aria-label*="Phone"]', 'button[aria-label*="phone"]', 'a[href^="tel:"]',
    ]:
        try:
            el = page.query_selector(sel)
            if el:
                label = el.get_attribute("aria-label") or ""
                href  = el.get_attribute("href") or ""
                text  = el.inner_text().strip()
                phone = (
                    re.sub(r'^Phone:\s*', '', label, flags=re.I).strip()
                    or href.replace("tel:", "").strip()
                    or text
                )
                if phone and re.search(r'\d{3}', phone):
                    detail["phone"] = phone
                    break
        except Exception:
            pass

    if "phone" not in detail:
        try:
            body = page.inner_text('[role="main"]')
            phones = re.findall(r'(\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})', body)
            if phones:
                detail["phone"] = phones[0].strip()
        except Exception:
            pass

    # WEBSITE
    for sel in [
        'a[data-item-id="authority"]', '[data-item-id="authority"]',
        'a[aria-label*="website" i]',
        'a[href*="http"]:not([href*="google"]):not([href*="goo.gl"])',
    ]:
        try:
            el = page.query_selector(sel)
            if el:
                href = el.get_attribute("href") or ""
                if href and "google" not in href and "goo.gl" not in href:
                    detail["website"] = href.strip()
                    break
        except Exception:
            pass

    # EMAIL
    try:
        html = page.content()
        emails = re.findall(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', html)
        legit = [
            e for e in emails
            if not any(x in e.lower() for x in [
                "google", "gstatic", "schema", "sentry", "example",
                "wixpress", "squarespace", "shopify"
            ])
            and not e.endswith((".png", ".jpg", ".svg", ".gif", ".webp"))
        ]
        if legit:
            detail["email"] = legit[0]
    except Exception:
        pass

    # RATING + REVIEW COUNT — critical for "busy" signal
    try:
        body_text = page.inner_text('[role="main"]')

        # Rating (e.g. "4.5")
        m = re.search(r'\b([1-5]\.\d)\b', body_text)
        if m:
            detail["rating"] = m.group(1)

        # Review count (e.g. "1,243 reviews" or "(843)")
        rc = re.search(r'([\d,]+)\s*(?:reviews?|ratings?)', body_text, re.I)
        if not rc:
            rc = re.search(r'\(([\d,]+)\)', body_text)
        if rc:
            detail["review_count"] = int(rc.group(1).replace(",", ""))
    except Exception:
        pass

    # REVIEW SNIPPETS — grab a few for "busy" context
    try:
        review_els = page.query_selector_all('[data-review-id] span, [class*="wiI7pd"]')
        snippets = []
        for el in review_els[:8]:
            t = el.inner_text().strip()
            if len(t) > 30:
                snippets.append(t[:300])
        if snippets:
            detail["review_snippets"] = snippets
    except Exception:
        pass

    # CATEGORY / TYPE
    try:
        body_text = page.inner_text('[role="main"]')
        # Category usually appears near the top in a smaller line
        cat_m = re.search(
            r'\b(burger|taco|shawarma|chicken|pizza|sushi|ramen|wings|bbq|'
            r'sandwich|wrap|poke|korean|mexican|mediterranean|lebanese|'
            r'steakhouse|diner|seafood|italian|chinese|indian|thai|vegan)[^\n]{0,40}',
            body_text[:1000], re.I
        )
        if cat_m:
            detail["category_hint"] = cat_m.group(0).strip()
    except Exception:
        pass

    return detail


# ── ICP evaluator ─────────────────────────────────────────────────────────────

def evaluate_icp(client: OpenAI, restaurant: dict, website_text: str) -> dict:
    """Send restaurant data + website text to GPT-4o-mini for ICP scoring."""

    # Build a rich context block for the model
    context_lines = [
        f"Restaurant name: {restaurant.get('name', 'Unknown')}",
        f"Address: {restaurant.get('address', 'N/A')}",
        f"Google rating: {restaurant.get('rating', 'N/A')}",
        f"Review count: {restaurant.get('review_count', 'unknown')}",
        f"Category hint from Maps: {restaurant.get('category_hint', 'N/A')}",
        f"POS/Ordering platform detected: {restaurant.get('pos', {}).get('platform', 'Unknown')} "
        f"(confidence: {restaurant.get('pos', {}).get('confidence', 'none')})",
    ]

    snippets = restaurant.get("review_snippets", [])
    if snippets:
        context_lines.append("\nSample Google review snippets:")
        for s in snippets[:5]:
            context_lines.append(f"  - {s}")

    if website_text and len(website_text) > 50:
        context_lines.append(f"\nWebsite / menu text (first 3500 chars):\n{website_text[:3500]}")
    else:
        context_lines.append("\nNo website text available.")

    user_message = "\n".join(context_lines)

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": ICP_SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_tokens=400,
        )
        raw = response.choices[0].message.content.strip()
        # Strip markdown code fences if present
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        return json.loads(raw)
    except Exception as e:
        print(f"    ⚠  GPT error: {e}")
        return {
            "icp_match": False,
            "score": 0,
            "busy_score": 0,
            "youth_score": 0,
            "reason": f"GPT evaluation failed: {e}",
            "menu_signals": [],
        }


# ── Scroll & collect ──────────────────────────────────────────────────────────

def scroll_and_collect_urls(page, need: int, skip_urls: set) -> list:
    seen_all = set()
    new_urls = []

    print(f"  ↕  Scrolling to find {need} new listings "
          f"(skipping {len(skip_urls)} already scraped)...")

    for _ in range(80):
        links = page.query_selector_all('a[href*="/maps/place/"]')
        for el in links:
            href = el.get_attribute("href")
            if not href:
                continue
            clean = href.split("?")[0]
            if clean in seen_all:
                continue
            seen_all.add(clean)
            if clean not in skip_urls and href not in new_urls:
                new_urls.append(href)

        if len(new_urls) >= need:
            break

        try:
            feed = page.query_selector('div[role="feed"]')
            if feed:
                feed.evaluate("el => el.scrollBy(0, 1200)")
            else:
                page.evaluate("window.scrollBy(0, 1200)")
        except Exception:
            pass

        time.sleep(1.5)

        try:
            end_el = page.query_selector(
                'span:has-text("end of list"), '
                'p:has-text("No more results"), '
                'div:has-text("You\'ve reached the end")'
            )
            if end_el:
                print("  ⚠  Reached end of Google Maps results.")
                break
        except Exception:
            pass

    return new_urls[:need]


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Google Maps restaurant scraper with GPT-powered ICP filtering",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scrape_restaurants.py --location "dearborn MI" --limit 20
  python scrape_restaurants.py --location "dearborn MI" --limit 20   # auto-skips first batch
  python scrape_restaurants.py --location "dearborn MI" --limit 50
  python scrape_restaurants.py --location "dearborn MI" --reset
  python scrape_restaurants.py --location "dearborn MI" --min-score 7  # stricter ICP threshold
        """
    )
    parser.add_argument("--location", required=True, help='e.g. "dearborn MI"')
    parser.add_argument("--limit", type=int, default=20,
                        help="Number of NEW restaurants to scrape per run (default: 20)")
    parser.add_argument("--min-score", type=int, default=6,
                        help="Minimum GPT ICP score (1-10) to include in results (default: 6)")
    parser.add_argument("--reset", action="store_true",
                        help="Clear all progress/results for this location and start over")
    parser.add_argument("--debug", action="store_true",
                        help="Save HTML + text dump of first listing")
    args = parser.parse_args()

    slug           = slugify(args.location)
    progress_file  = f"{slug}_progress.json"
    results_file   = f"{slug}_results.json"
    rejected_file  = f"{slug}_rejected.json"

    if args.reset:
        for f in [progress_file, results_file, rejected_file]:
            if os.path.exists(f):
                os.remove(f)
        print(f"🔄 Reset complete for '{args.location}'\n")

    scraped_urls = load_json_set(progress_file)
    all_results  = load_json_list(results_file)
    all_rejected = load_json_list(rejected_file)

    print(f"📊 '{args.location}' — session info")
    print(f"   Already visited : {len(scraped_urls)} restaurants")
    print(f"   ICP matched so far: {len(all_results)}")
    print(f"   Requesting now  : {args.limit} new (min ICP score: {args.min_score}/10)")
    print(f"   Results file    : {results_file}")
    print(f"   Rejected file   : {rejected_file}\n")

    openai_client = OpenAI(api_key=OPENAI_API_KEY)

    matched_this_run  = []
    rejected_this_run = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        maps_page    = context.new_page()
        website_page = context.new_page()

        # ── Load search results ──
        print("📍 Loading Google Maps search results...")
        maps_page.goto(build_search_url(args.location), wait_until="domcontentloaded", timeout=30000)
        maps_page.wait_for_timeout(4000)

        for btn_text in ["Accept all", "Agree", "I agree", "Accept"]:
            try:
                btn = maps_page.query_selector(f'button:has-text("{btn_text}")')
                if btn:
                    btn.click()
                    maps_page.wait_for_timeout(1000)
                    break
            except Exception:
                pass

        new_urls = scroll_and_collect_urls(maps_page, args.limit, scraped_urls)

        if not new_urls:
            print("\n⚠  No new listings found. Try --reset or a different --location.\n")
            browser.close()
            return

        print(f"\n✅ {len(new_urls)} new listings — scraping + ICP filtering...\n")
        print("─" * 70)

        for i, url in enumerate(new_urls, 1):
            print(f"\n[{i:02d}/{len(new_urls)}] Scraping Maps listing...")
            try:
                maps_page.goto(url, wait_until="domcontentloaded", timeout=25000)
            except Exception:
                print("    ❌ Failed to load Maps page, skipping.")
                scraped_urls.add(url.split("?")[0])
                save_json(progress_file, sorted(scraped_urls))
                continue

            detail = extract_maps_detail(maps_page, debug=args.debug, debug_index=i)
            detail["maps_url"] = url

            print(f"    📌 {detail.get('name', 'Unknown')}")
            print(f"       ⭐ {detail.get('rating', '?')} | 💬 {detail.get('review_count', '?')} reviews")
            print(f"       📞 {detail.get('phone', '—')} | 🌐 {detail.get('website', '—')}")

            # ── Fetch website text + HTML ──
            website_text = ""
            if detail.get("website"):
                print(f"    🌐 Fetching website...")
                website_text, website_html = fetch_website(website_page, detail["website"])
                print(f"       → Got {len(website_text)} chars of content")

                # ── POS detection (Layer 1: HTML fingerprint scan) ──
                pos = detect_pos_platform(website_html)
                detail["pos"] = pos
                if pos["platform"] != "Unknown":
                    all_found = ", ".join(pos["all_detected"])
                    print(f"       💳 POS detected: {all_found} (confidence: {pos['confidence']})")
                else:
                    detail["pos"] = pos
                    print(f"       💳 POS: not detected")

            # ── ICP evaluation ──
            print(f"    🤖 Evaluating ICP with GPT-4o-mini...")
            icp = evaluate_icp(openai_client, detail, website_text)

            detail["icp"] = icp
            verdict = "✅ MATCH" if icp.get("icp_match") and icp.get("score", 0) >= args.min_score else "❌ REJECT"

            print(f"    {verdict} — Score: {icp.get('score', 0)}/10 "
                  f"(busy: {icp.get('busy_score', 0)}/10, "
                  f"youth: {icp.get('youth_score', 0)}/10)")
            print(f"       💬 {icp.get('reason', '')}")
            if icp.get("menu_signals"):
                print(f"       🍔 Signals: {', '.join(icp['menu_signals'][:6])}")
            pos_name = detail.get("pos", {}).get("platform", "Unknown")
            if pos_name != "Unknown":
                print(f"       💳 POS: {pos_name}")

            # ── Route to matched or rejected ──
            if icp.get("icp_match") and icp.get("score", 0) >= args.min_score:
                matched_this_run.append(detail)
            else:
                rejected_this_run.append(detail)

            # Save progress after every restaurant
            scraped_urls.add(url.split("?")[0])
            save_json(progress_file, sorted(scraped_urls))
            all_results_combined = all_results + matched_this_run
            all_rejected_combined = all_rejected + rejected_this_run
            save_json(results_file, all_results_combined)
            save_json(rejected_file, all_rejected_combined)

            time.sleep(0.5)

        browser.close()

    # Final persist
    final_results  = all_results  + matched_this_run
    final_rejected = all_rejected + rejected_this_run
    save_json(results_file, final_results)
    save_json(rejected_file, final_rejected)

    # ── Summary ──
    print(f"\n{'═' * 70}")
    print(f"  RUN COMPLETE")
    print(f"{'─' * 70}")
    print(f"  Scraped this run  : {len(new_urls)}")
    print(f"  ✅ ICP matched     : {len(matched_this_run)}  →  {results_file}")
    print(f"  ❌ Rejected        : {len(rejected_this_run)}  →  {rejected_file}")
    print(f"  📦 Total matched   : {len(final_results)} across all runs")
    print(f"  💾 Total visited   : {len(scraped_urls)}")
    print(f"{'═' * 70}\n")

    if matched_this_run:
        print(f"ICP MATCHES THIS RUN:")
        print(f"{'#':<4} {'Name':<28} {'Score':<7} {'POS':<14} {'Phone':<16} {'Address'}")
        print("─" * 95)
        for i, r in enumerate(matched_this_run, 1):
            pos_name = r.get("pos", {}).get("platform", "—")
            print(
                f"{i:<4} {r.get('name', '?')[:27]:<28} "
                f"{r['icp'].get('score', 0)}/10   "
                f"{pos_name[:13]:<14} "
                f"{r.get('phone', '')[:15]:<16} "
                f"{r.get('address', '')[:30]}"
            )


if __name__ == "__main__":
    main()