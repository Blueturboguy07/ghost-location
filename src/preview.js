// Browser preview never connects to or changes a phone.
export function createPreviewBridge() {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const state = {
    devices: [],
    runtime: {
      ios: { available: false, message: 'Open the desktop app to check the iPhone runtime.' },
      android: { available: false, message: 'Open the desktop app to check Android tools.' },
    },
    session: null,
    savedPlaces: read('ghost.preview.places', []),
    recentPlaces: [],
    preferences: {
      restoreOnQuit: true,
      geocoderUrl: 'https://photon.komoot.io/api/',
      onboardingComplete: false,
      hostPlatform: null,
      phonePlatform: null,
      ...read('ghost.preview.preferences', {}),
    },
    busy: false,
  };
  const listeners = new Set();
  const publish = () => { for (const fn of listeners) fn(structuredClone(state)); return structuredClone(state); };
  const desktopOnly = async () => { throw new Error('Open Ghost on your desktop to connect and control a phone. This browser preview cannot change a device.'); };
  return {
    getState: async () => structuredClone(state),
    scanDevices: async () => structuredClone(state),
    switchToWifi: desktopOnly,
    setConnection: desktopOnly,
    connectWifi: desktopOnly,
    prepareDevice: desktopOnly,
    applyLocation: desktopOnly,
    stopLocation: desktopOnly,
    getRoute: async () => null,
    planRoute: desktopOnly,
    startRoute: desktopOnly,
    pauseRoute: desktopOnly,
    resumeRoute: desktopOnly,
    installRuntime: desktopOnly,
    searchPlaces: async () => { throw new Error('Place search is available in the desktop app. In this preview, click the map or enter coordinates to choose a place.'); },
    savePlace: async (place) => {
      const saved = { ...place, id: place.id || crypto.randomUUID() };
      state.savedPlaces = [saved, ...state.savedPlaces.filter((p) => p.id !== saved.id)];
      localStorage.setItem('ghost.preview.places', JSON.stringify(state.savedPlaces));
      return publish();
    },
    deletePlace: async (id) => {
      state.savedPlaces = state.savedPlaces.filter((p) => p.id !== id);
      localStorage.setItem('ghost.preview.places', JSON.stringify(state.savedPlaces));
      return publish();
    },
    updatePreferences: async (preferences) => {
      state.preferences = { ...state.preferences, ...preferences };
      localStorage.setItem('ghost.preview.preferences', JSON.stringify(state.preferences));
      return publish();
    },
    onState: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
