const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bookManagerDb', {
  load: () => ipcRenderer.invoke('db:load'),
  saveState: (state) => ipcRenderer.invoke('db:save-state', state),
  importBackup: (payload) => ipcRenderer.invoke('db:import-backup', payload),
  createRecoveryBackup: (reason) => ipcRenderer.invoke('db:create-recovery-backup', reason),
  getSetting: (key) => ipcRenderer.invoke('db:get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('db:set-setting', key, value),
  exportData: (data) => ipcRenderer.invoke('db:export-json', data),
  pickImportJson: () => ipcRenderer.invoke('db:pick-import-json'),
  showLocation: () => ipcRenderer.invoke('db:show-location'),
  chooseLibraryRoot: () => ipcRenderer.invoke('library:choose-root'),
  switchLibraryRoot: (targetPath, mode) => ipcRenderer.invoke('library:switch-root', targetPath, mode),
  addAttachments: (bookId) => ipcRenderer.invoke('library:add-attachments', bookId),
  removeAttachment: (bookId, attachmentId) => ipcRenderer.invoke('library:remove-attachment', bookId, attachmentId),
  openAttachment: (bookId, attachmentId) => ipcRenderer.invoke('library:open-attachment', bookId, attachmentId),
  openBookFolder: (bookId) => ipcRenderer.invoke('library:open-book-folder', bookId),
  pickCover: (bookId) => ipcRenderer.invoke('library:pick-cover', bookId),
  setCoverUrl: (bookId, url) => ipcRenderer.invoke('library:set-cover-url', bookId, url),
  removeCover: (bookId) => ipcRenderer.invoke('library:remove-cover', bookId),
  permanentlyDeleteBook: (bookId) => ipcRenderer.invoke('library:permanently-delete-book', bookId)
});
