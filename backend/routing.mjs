import { randomUUID } from 'node:crypto';
import { place } from './validation.mjs';

export const ROUTE_SPEED_MPS = 45 * 1609.344 / 3600;
const radians = degrees => degrees * Math.PI / 180;
const longitudeDelta = (from, to) => ((to - from + 540) % 360) - 180;

export function distanceBetween(a, b) {
  const dLat = radians(b[1] - a[1]), dLon = radians(longitudeDelta(a[0], b[0]));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function measurePath(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 100000) throw new Error('The routing service returned an invalid or excessively long path.');
  const cumulative = [0];
  coordinates.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new Error('Invalid route coordinates.');
    place({ longitude: p[0], latitude: p[1] });
    if (i) cumulative.push(cumulative[i - 1] + distanceBetween(coordinates[i - 1], p));
  });
  if (cumulative.at(-1) < 1) throw new Error('Choose two different locations at least a metre apart.');
  return { coordinates, cumulative, distanceMeters: cumulative.at(-1) };
}

export function pointAlong(path, distance) {
  const target = Math.min(path.distanceMeters, Math.max(0, distance));
  let lo = 1, hi = path.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (path.cumulative[mid] < target) lo = mid + 1; else hi = mid;
  }
  const a = path.coordinates[lo - 1], b = path.coordinates[lo];
  const length = path.cumulative[lo] - path.cumulative[lo - 1];
  const fraction = length ? (target - path.cumulative[lo - 1]) / length : 0;
  // Spherical interpolation stays on the segment, including across the dateline.
  const angle = distanceBetween(a, b) / 6371008.8;
  let latitude, longitude;
  if (angle < 1e-10) [longitude, latitude] = a;
  else {
    const x = Math.sin((1 - fraction) * angle) / Math.sin(angle), y = Math.sin(fraction * angle) / Math.sin(angle);
    const aLat = radians(a[1]), aLon = radians(a[0]), bLat = radians(b[1]), bLon = radians(b[0]);
    const vx = x * Math.cos(aLat) * Math.cos(aLon) + y * Math.cos(bLat) * Math.cos(bLon);
    const vy = x * Math.cos(aLat) * Math.sin(aLon) + y * Math.cos(bLat) * Math.sin(bLon);
    const vz = x * Math.sin(aLat) + y * Math.sin(bLat);
    latitude = Math.atan2(vz, Math.hypot(vx, vy)) * 180 / Math.PI;
    longitude = Math.atan2(vy, vx) * 180 / Math.PI;
  }
  if (target === path.distanceMeters) [longitude, latitude] = path.coordinates.at(-1);
  return { latitude, longitude };
}

export class Router {
  constructor({ fetcher = fetch, now = Date.now } = {}) { this.fetcher = fetcher; this.now = now; this.lastRequest = -Infinity; }
  async plan(input) {
    if (!Array.isArray(input) || input.length < 2 || input.length > 12) throw new Error('Add between 2 and 12 route stops.');
    const waypoints = input.map(p => place(p));
    if (this.now() - this.lastRequest < 1000) throw new Error('Wait a second before planning another route.');
    this.lastRequest = this.now();
    const coordinates = waypoints.map(p => `${p.longitude},${p.latitude}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false&radiuses=${waypoints.map(() => 1000).join(';')}`;
    let data;
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'GhostLocation/0.1.5', Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Routing service returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('Route is too large. Choose a shorter path.');
      data = JSON.parse(body);
    } catch (error) { throw new Error(`Could not plan the road route. Check your internet connection and try again. ${error.message}`); }
    if (data.code !== 'Ok' || data.routes?.[0]?.geometry?.type !== 'LineString') throw new Error('No drivable route found. Move the pins closer to connected roads and try again.');
    const path = measurePath(data.routes[0].geometry.coordinates);
    return { id: randomUUID(), waypoints, coordinates: path.coordinates, distanceMeters: path.distanceMeters, durationSeconds: path.distanceMeters / ROUTE_SPEED_MPS, speedMph: 45 };
  }
}
