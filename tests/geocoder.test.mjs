import test from 'node:test';
import assert from 'node:assert/strict';
import { Geocoder } from '../backend/geocoder.mjs';

const response = () => new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-87.6, 41.9] }, properties: { osm_id: 1, name: 'Chicago', city: 'Chicago', country: 'United States' } }] }));
test('search encodes user text, normalizes results, and caches repeated submits', async () => {
  let calls = 0;
  const geocoder = new Geocoder({ intervalMs: 0, fetchImpl: async url => { calls++; assert.equal(url.searchParams.get('q'), 'Chicago & lake'); return response(); } });
  const places = await geocoder.search('Chicago & lake');
  assert.equal(places[0].label, 'Chicago, United States'); assert.equal(places[0].latitude, 41.9);
  await geocoder.search('CHICAGO & LAKE'); assert.equal(calls, 1);
});
test('empty queries and invalid endpoints are rejected without networking', async () => {
  const geocoder = new Geocoder({ fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(geocoder.search(' '));
  assert.throws(() => geocoder.configure('file:///etc/passwd')); assert.throws(() => geocoder.configure('https://user:pass@example.com/api/'));
});
test('network and rate limit failures have actionable errors', async () => {
  const geocoder = new Geocoder({ intervalMs: 0, fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(geocoder.search('London'), /Search is busy/);
  geocoder.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(geocoder.search('Paris'), /Check your connection/);
});
test('malformed coordinates from remote service are never offered as places', async () => {
  const geocoder = new Geocoder({ intervalMs: 0, fetchImpl: async () => new Response(JSON.stringify({ features: [{ geometry: { coordinates: [0, 999] } }, { geometry: { coordinates: [0, 0] }, properties: {} }] })) });
  const places = await geocoder.search('Equator'); assert.equal(places.length, 1); assert.equal(places[0].longitude, 0);
});
