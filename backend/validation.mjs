export function coordinates(value) {
  if (!value || typeof value !== 'object') throw new Error('Choose a location first.');
  const { latitude, longitude } = value;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Use a latitude from −90 to 90 and longitude from −180 to 180.');
  }
  return { latitude, longitude };
}

export function text(value, fallback = '', max = 240) {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || fallback;
}

export function place(value) {
  const point = coordinates(value);
  return { ...point, label: text(value.label, `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`) };
}

export function geocoderUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS Photon API endpoint without credentials or query parameters.');
  }
  return url.href;
}
