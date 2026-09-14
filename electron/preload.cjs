const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (method, payload) => {
  const response = await ipcRenderer.invoke(`ghost:${method}`, payload);
  if (!response.ok) throw new Error(response.error || 'The operation failed.');
  return response.data;
};

contextBridge.exposeInMainWorld('ghost', Object.freeze({
  getState: () => invoke('getState'),
  switchToWifi: id => invoke('switchToWifi', id),
  setConnection: value => invoke('setConnection', value),
  connectWifi: value => invoke('connectWifi', value),
  scanDevices: () => invoke('scanDevices'),
  prepareDevice: id => invoke('prepareDevice', id),
  applyLocation: point => invoke('applyLocation', point),
  stopLocation: () => invoke('stopLocation'),
  getRoute: () => invoke('getRoute'),
  planRoute: stops => invoke('planRoute', stops),
  startRoute: value => invoke('startRoute', value),
  pauseRoute: () => invoke('pauseRoute'),
  resumeRoute: () => invoke('resumeRoute'),
  searchPlaces: query => invoke('searchPlaces', query),
  savePlace: place => invoke('savePlace', place),
  deletePlace: id => invoke('deletePlace', id),
  updatePreferences: value => invoke('updatePreferences', value),
  installRuntime: () => invoke('installRuntime'),
  onState: callback => {
    if (typeof callback !== 'function') throw new Error('A callback is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ghost:state', listener);
    return () => ipcRenderer.removeListener('ghost:state', listener);
  }
}));
