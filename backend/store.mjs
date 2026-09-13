import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const defaults = () => ({
  schemaVersion: 1, savedPlaces: [], recentPlaces: [], session: null,
  preferences: {
    restoreOnQuit: true,
    geocoderUrl: 'https://photon.komoot.io/api/',
    onboardingComplete: false,
    hostPlatform: null,
    phonePlatform: null,
  }
});

export class Store {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); this.data = defaults(); this.warning = null; }
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.savedPlaces) || !Array.isArray(parsed.recentPlaces)) throw new Error('Unsupported settings format');
      this.data = { ...defaults(), ...parsed, preferences: { ...defaults().preferences, ...parsed.preferences } };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Preserve the original instead of silently overwriting a possibly active session.
        await copyFile(this.path, `${this.path}.backup-${Date.now()}`);
        this.warning = 'Saved settings could not be read. A backup was kept, but the previous phone session could not be recovered. If a phone was being simulated, restart that phone before starting a new session.';
      }
    }
    return structuredClone(this.data);
  }
  async save(data) {
    const snapshot = structuredClone(data);
    const operation = this.queue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.data = snapshot;
    });
    this.queue = operation;
    return operation;
  }
}
