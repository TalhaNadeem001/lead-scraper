/**
 * nearbyService.js
 * Filters a list of leads by driving distance using the Google Distance Matrix API.
 * Ported from filter_nearby_pos.py (Python reference).
 */

import axios from 'axios';

/**
 * Extract lat/lng from a Google Maps URL.
 * Handles:
 *   /maps/place/Name/@37.123,-122.456,15z/
 *   /maps/place/Name/data=...!3d37.123!4d-122.456
 *
 * @param {string} mapsUrl
 * @returns {[number|null, number|null]}
 */
function extractCoordsFromUrl(mapsUrl) {
  if (!mapsUrl) return [null, null];

  // Pattern 1: /@lat,lng,zoom
  const m1 = mapsUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m1) return [parseFloat(m1[1]), parseFloat(m1[2])];

  // Pattern 2: !3d<lat>!4d<lng>
  const latM = mapsUrl.match(/!3d(-?\d+\.\d+)/);
  const lngM = mapsUrl.match(/!4d(-?\d+\.\d+)/);
  if (latM && lngM) return [parseFloat(latM[1]), parseFloat(lngM[1])];

  return [null, null];
}

/**
 * Call Google Distance Matrix API.
 * @returns {Promise<number|null>} driving minutes, or null on failure
 */
async function getDrivingMinutes(origin, lat, lng, apiKey) {
  try {
    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/distancematrix/json',
      {
        params: {
          origins: origin,
          destinations: `${lat},${lng}`,
          mode: 'driving',
          key: apiKey,
        },
        timeout: 10_000,
      },
    );
    const element = data?.rows?.[0]?.elements?.[0];
    if (element?.status === 'OK') {
      return Math.round(element.duration.value / 60);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Filter leads by max driving distance from an origin.
 *
 * @param {object[]} leads
 * @param {string}   origin      - Human-readable origin address
 * @param {number}   maxMinutes  - Maximum driving time in minutes
 * @param {string}   apiKey      - Google Maps API key
 * @returns {Promise<object[]>}  Leads enriched with drive_minutes, sorted ascending
 */
export async function filterByDistance(leads, origin, maxMinutes, apiKey) {
  const results = [];

  for (const lead of leads) {
    const [lat, lng] = extractCoordsFromUrl(lead.maps_url);
    if (lat === null) continue;

    const mins = await getDrivingMinutes(origin, lat, lng, apiKey);
    if (mins !== null && mins <= maxMinutes) {
      results.push({ ...lead, drive_minutes: mins });
    }

    // Gentle rate-limiting
    await new Promise((r) => setTimeout(r, 50));
  }

  results.sort((a, b) => (a.drive_minutes ?? 9999) - (b.drive_minutes ?? 9999));
  return results;
}
