import { coordinates, geocoderUrl } from './validation.mjs';

export class Geocoder {
  constructor({ fetchImpl = fetch, endpoint = 'https://photon.komoot.io/api/', intervalMs = 1100 } = {}) {
    this.fetch = fetchImpl; this.endpoint = geocoderUrl(endpoint); this.interval = intervalMs;
    this.cache = new Map(); this.inflight = new Map(); this.queue = Promise.resolve(); this.lastRequest = 0;
  }
  configure(endpoint) { this.endpoint = geocoderUrl(endpoint); }
  async search(raw) {
    if (typeof raw !== 'string' || raw.trim().length < 2 || raw.length > 200) throw new Error('Enter a place name between 2 and 200 characters.');
    const query = raw.trim();
    const key = `${this.endpoint}|${query.toLocaleLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 86400000) return structuredClone(cached.results);
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.inflight.size >= 3) throw new Error('Please wait for the current search to finish.');
    const endpoint = this.endpoint;
    const job = this.queue.catch(() => {}).then(async () => {
      const delay = Math.max(0, this.interval - (Date.now() - this.lastRequest));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.lastRequest = Date.now();
      const url = new URL(endpoint);
      url.searchParams.set('q', query); url.searchParams.set('limit', '6');
      let response;
      try {
        response = await this.fetch(url, {
          headers: { 'User-Agent': 'GhostLocation/0.1 (USB location simulator)', Accept: 'application/json' },
          signal: AbortSignal.timeout(12000)
        });
      } catch { throw new Error('Place search is unavailable. Check your connection, or choose a pin on the map.'); }
      if (!response.ok) throw new Error(response.status === 429 ? 'Search is busy. Wait a moment and try again.' : `Place search returned ${response.status}. You can still use map pins or coordinates.`);
      const content = await response.text();
      if (content.length > 2_000_000) throw new Error('Search response was too large.');
      let data;
      try { data = JSON.parse(content); } catch { throw new Error('Search returned an unreadable response.'); }
      if (!Array.isArray(data.features)) throw new Error('Use a Photon-compatible search endpoint.');
      const results = data.features.slice(0, 6).flatMap((feature, index) => {
        try {
          const [longitude, latitude] = feature.geometry.coordinates;
          coordinates({ latitude, longitude });
          const p = feature.properties ?? {};
          const label = [...new Set([p.name, [p.housenumber, p.street].filter(Boolean).join(' '), p.city || p.town || p.village, p.state, p.country].filter(x => typeof x === 'string' && x))].join(', ').slice(0, 240);
          return [{ id: `${p.osm_type || 'place'}-${p.osm_id || index}`, latitude, longitude, label: label || query }];
        } catch { return []; }
      });
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { at: Date.now(), results });
      return structuredClone(results);
    });
    this.queue = job;
    this.inflight.set(key, job);
    try { return await job; } finally { this.inflight.delete(key); }
  }
}
