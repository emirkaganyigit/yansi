const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (command, ...args) => ipcRenderer.invoke(`yansi:${command}`, ...args);

contextBridge.exposeInMainWorld('yansi', {
  getState: () => invoke('get-state'),
  startServer: () => invoke('start-server'),
  stopServer: () => invoke('stop-server'),
  chooseFiles: () => invoke('choose-files'),
  addDroppedFiles: (files) => {
    const paths = Array.from(files).map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return invoke('add-files', paths);
  },
  removeFile: (id) => invoke('remove-file', id),
  openFile: (id) => invoke('open-file', id),
  openDownloads: () => invoke('open-downloads'),
  copyText: (text) => invoke('copy-text', text),
  approveViewer: (id) => invoke('approve-viewer', id),
  rejectViewer: (id) => invoke('reject-viewer', id),
  disconnectViewer: (id) => invoke('disconnect-viewer', id),
  sendSignal: (viewerId, payload) => invoke('send-signal', viewerId, payload),
  setSharing: (sharing) => invoke('set-sharing', sharing),
  startSystemAudio: () => invoke('start-system-audio'),
  stopSystemAudio: () => invoke('stop-system-audio'),
  onAudioData: (handler) => {
    const listener = (_event, packet) => {
      try { handler(packet); }
      finally { ipcRenderer.send('yansi:audio-ack'); }
    };
    ipcRenderer.on('yansi:audio-data', listener);
    return () => ipcRenderer.removeListener('yansi:audio-data', listener);
  },
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('yansi:event', listener);
    return () => ipcRenderer.removeListener('yansi:event', listener);
  }
});
