const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require('electron');
const { createBackupPayload, normalizeBackupPayload } = require('./src/backup');
const { createDatabaseStore, MAX_COVER_SIZE } = require('./src/database');
const {
  ensureLibraryRoot,
  inspectLibraryRoot,
  migrateLibraryRoot,
  resolveLibraryRoot,
  writeConfiguredRoot
} = require('./src/library-root');

let mainWindow = null;
let rootPromise = null;
let storePromise = null;

function getLibraryRoot() {
  if (!rootPromise) {
    rootPromise = resolveLibraryRoot({
      userDataDir: app.getPath('userData'),
      documentsDir: app.getPath('documents'),
      overridePath: process.env.BOOK_MANAGER_TEST_LIBRARY_ROOT || ''
    });
  }
  return rootPromise;
}

function getStore() {
  if (!storePromise) {
    storePromise = getLibraryRoot().then((rootPath) => createDatabaseStore(rootPath));
  }
  return storePromise;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 520,
    title: 'Book Manager',
    backgroundColor: '#181714',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    setTimeout(async () => {
      try {
        const loaded = await mainWindow.webContents.executeJavaScript(
          "Boolean(document.querySelector('.appShell') || document.querySelector('.loadingScreen') || document.querySelector('.errorScreen'))"
        );
        app.exit(loaded ? 0 : 1);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    }, 1800);
  }
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function imageMimeFromUrl(url) {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp'
  })[extension] || '';
}

async function readResponseWithLimit(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new Error('封面图片不能超过 12 MB。');
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('封面图片不能超过 12 MB。');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function optimizeCover(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('无法识别这张图片，请改用 PNG、JPEG 或 WebP 文件。');
  const size = image.getSize();
  if (!size.width || !size.height || size.width * size.height > 100_000_000) {
    throw new Error('封面图片尺寸无效或过大。');
  }
  const scale = Math.min(1, 900 / size.width, 1400 / size.height);
  const optimized = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best'
    })
    : image;
  return optimized.toJPEG(86);
}

ipcMain.handle('db:load', async () => (await getStore()).load());

ipcMain.handle('db:save-state', async (_event, state) => (await getStore()).saveState(state, false));

ipcMain.handle('db:import-backup', async (_event, payload) => {
  const store = await getStore();
  const backup = normalizeBackupPayload(payload);
  return store.importBackup(backup.state, backup.settings);
});

ipcMain.handle('db:create-recovery-backup', async (_event, reason) => {
  return (await getStore()).createRecoveryBackup(reason || 'manual');
});

ipcMain.handle('db:get-setting', async (_event, key) => (await getStore()).getSetting(key));

ipcMain.handle('db:set-setting', async (_event, key, value) => {
  (await getStore()).setSetting(key, String(value));
  return true;
});

ipcMain.handle('db:export-json', async (_event, data) => {
  const store = await getStore();
  const filePath = process.env.BOOK_MANAGER_TEST_EXPORT_PATH
    || path.join(store.exportDir, `book-manager_${timestampForFile()}.json`);
  const payload = createBackupPayload(data.state, data.settings);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { canceled: false, filePath };
});

ipcMain.handle('db:pick-import-json', async () => {
  const store = await getStore();
  const result = process.env.BOOK_MANAGER_TEST_IMPORT_PATH
    ? { canceled: false, filePaths: [process.env.BOOK_MANAGER_TEST_IMPORT_PATH] }
    : await dialog.showOpenDialog(mainWindow, {
      title: '导入书库 JSON',
      defaultPath: store.exportDir,
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const info = await fs.stat(filePath);
  if (info.size > 100 * 1024 * 1024) throw new Error('备份文件超过 100 MB，无法安全导入。');
  const data = normalizeBackupPayload(JSON.parse(await fs.readFile(filePath, 'utf8')));
  return { canceled: false, filePath, data };
});

ipcMain.handle('db:show-location', async () => {
  const store = await getStore();
  const error = await shell.openPath(store.rootPath);
  if (error) throw new Error(error);
  return store.rootPath;
});

ipcMain.handle('library:choose-root', async () => {
  const store = await getStore();
  const result = process.env.BOOK_MANAGER_TEST_CHOOSE_ROOT
    ? { canceled: false, filePaths: [process.env.BOOK_MANAGER_TEST_CHOOSE_ROOT] }
    : await dialog.showOpenDialog(mainWindow, {
      title: '选择书库根目录',
      defaultPath: store.rootPath,
      properties: ['openDirectory', 'createDirectory']
    });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, ...(await inspectLibraryRoot(result.filePaths[0])) };
});

ipcMain.handle('library:switch-root', async (_event, targetPath, mode) => {
  const currentStore = await getStore();
  const currentRoot = currentStore.rootPath;
  const targetRoot = path.resolve(String(targetPath || ''));
  if (!targetPath) throw new Error('没有选择新的书库根目录。');
  if (currentRoot.toLowerCase() === targetRoot.toLowerCase()) return currentStore.load();

  const inspection = await inspectLibraryRoot(targetRoot);
  if (mode === 'open') {
    if (!inspection.hasLibrary) throw new Error('目标目录中没有可打开的书库数据库。');
    await ensureLibraryRoot(targetRoot);
  } else if (mode === 'migrate') {
    await migrateLibraryRoot(currentRoot, targetRoot);
  } else {
    throw new Error('未知的根目录切换方式。');
  }

  const nextStore = await createDatabaseStore(targetRoot);
  try {
    await writeConfiguredRoot(app.getPath('userData'), targetRoot);
  } catch (error) {
    nextStore.close();
    throw error;
  }
  currentStore.close();
  rootPromise = Promise.resolve(targetRoot);
  storePromise = Promise.resolve(nextStore);
  return nextStore.load();
});

ipcMain.handle('library:add-attachments', async (_event, bookId) => {
  const sourcePaths = process.env.BOOK_MANAGER_TEST_ATTACHMENT_PATHS
    ? JSON.parse(process.env.BOOK_MANAGER_TEST_ATTACHMENT_PATHS)
    : (await dialog.showOpenDialog(mainWindow, {
      title: '添加书籍附件',
      properties: ['openFile', 'multiSelections']
    })).filePaths;
  if (!sourcePaths || !sourcePaths.length) return { canceled: true };
  const payload = await (await getStore()).addAttachments(bookId, sourcePaths);
  return { canceled: false, payload };
});

ipcMain.handle('library:remove-attachment', async (_event, bookId, attachmentId) => {
  return (await getStore()).removeAttachment(bookId, attachmentId);
});

ipcMain.handle('library:open-attachment', async (_event, bookId, attachmentId) => {
  const filePath = (await getStore()).getAttachmentPath(bookId, attachmentId);
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return filePath;
});

ipcMain.handle('library:open-book-folder', async (_event, bookId) => {
  const folderPath = (await getStore()).getBookFolder(bookId);
  const error = await shell.openPath(folderPath);
  if (error) throw new Error(error);
  return folderPath;
});

ipcMain.handle('library:pick-cover', async (_event, bookId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择书籍封面',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const info = await fs.stat(result.filePaths[0]);
  if (!info.isFile() || info.size > MAX_COVER_SIZE) throw new Error('封面图片不能超过 12 MB。');
  const buffer = optimizeCover(await fs.readFile(result.filePaths[0]));
  return { canceled: false, payload: await (await getStore()).saveCoverBuffer(bookId, buffer, 'image/jpeg') };
});

ipcMain.handle('library:set-cover-url', async (_event, bookId, rawUrl) => {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('封面 URL 仅支持 HTTP 或 HTTPS。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`下载封面失败（HTTP ${response.status}）。`);
    const headerMime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mimeType = headerMime.startsWith('image/') ? headerMime : imageMimeFromUrl(response.url || url.href);
    if (!mimeType.startsWith('image/')) throw new Error('URL 返回的内容不是受支持的图片。');
    const buffer = optimizeCover(await readResponseWithLimit(response, MAX_COVER_SIZE));
    return (await getStore()).saveCoverBuffer(bookId, buffer, 'image/jpeg');
  } finally {
    clearTimeout(timeout);
  }
});

ipcMain.handle('library:remove-cover', async (_event, bookId) => (await getStore()).removeCover(bookId));

ipcMain.handle('library:permanently-delete-book', async (_event, bookId) => {
  return (await getStore()).permanentlyDeleteBook(bookId);
});

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
});

app.on('before-quit', () => {
  if (storePromise) storePromise.then((store) => store.close()).catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
