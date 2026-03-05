/**
 * icpService.js
 * GPT-4o-mini ICP (Ideal Customer Profile) evaluation.
 * Ported from scrape_restaurants.py (Python reference).
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ICP_SYSTEM_PROMPT = `You are a restaurant lead qualification assistant.

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
}`;

/**
 * @param {object} restaurant - Scraped restaurant data
 * @param {string} websiteText - Visible text from the restaurant's website
 * @returns {Promise<object>} ICP evaluation result
 */
export async function evaluateICP(restaurant, websiteText = '') {
  const lines = [
    `Restaurant name: ${restaurant.name ?? 'Unknown'}`,
    `Address: ${restaurant.address ?? 'N/A'}`,
    `Google rating: ${restaurant.rating ?? 'N/A'}`,
    `Review count: ${restaurant.review_count ?? 'unknown'}`,
    `Category hint from Maps: ${restaurant.category_hint ?? 'N/A'}`,
    `POS/Ordering platform detected: ${restaurant.pos?.platform ?? 'Unknown'} (confidence: ${restaurant.pos?.confidence ?? 'none'})`,
  ];

  const snippets = restaurant.review_snippets ?? [];
  if (snippets.length) {
    lines.push('\nSample Google review snippets:');
    snippets.slice(0, 5).forEach((s) => lines.push(`  - ${s}`));
  }

  if (websiteText?.length > 50) {
    lines.push(`\nWebsite / menu text (first 3500 chars):\n${websiteText.slice(0, 3500)}`);
  } else {
    lines.push('\nNo website text available.');
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ICP_SYSTEM_PROMPT },
        { role: 'user', content: lines.join('\n') },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });

    let raw = response.choices[0].message.content.trim();
    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');
    return JSON.parse(raw);
  } catch (err) {
    console.error('GPT ICP error:', err.message);
    return {
      icp_match: false,
      score: 0,
      busy_score: 0,
      youth_score: 0,
      reason: `GPT evaluation failed: ${err.message}`,
      menu_signals: [],
    };
  }
}
