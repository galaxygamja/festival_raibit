'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  start: () => ipcRenderer.invoke('game:start'),
  stop: () => ipcRenderer.invoke('game:stop'),
  getRecords: () => ipcRenderer.invoke('records:get'),
  saveRecords: (edits) => ipcRenderer.invoke('records:save', edits),
  deleteRecords: (ids) => ipcRenderer.invoke('records:delete', ids),
  resetRecords: () => ipcRenderer.invoke('records:reset'),
  reconnect: () => ipcRenderer.invoke('serial:reconnect'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  setSim: (on) => ipcRenderer.invoke('sim:set', on),
  simKey: (key, down) => ipcRenderer.invoke('sim:key', key, down),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  zeroEmg: () => ipcRenderer.invoke('emg:zero'),
  setPortRole: (path, role) => ipcRenderer.invoke('serial:setRole', path, role),
  setDiag: (on) => ipcRenderer.invoke('diag:set', on),
  resetDiag: () => ipcRenderer.invoke('diag:reset'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
