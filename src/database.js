const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { normalizeBackupPayload, UNCATEGORIZED_ID } = require('./backup');
const { isPathInside } = require('./library-root');

let sqlPromise = null;
const DATABASE_VERSION = 4;
const MAX_AUTOMATIC_BACKUPS = 14;
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_COVER_SIZE = 12 * 1024 * 1024;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file)
    });
  }
  return sqlPromise;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  return normalizeBackupPayload({
    state: {
      directories: Array.isArray(state.directories) ? state.directories : [],
      books: Array.isArray(state.books) ? state.books : [],
      nextDirId: state.nextDirId,
      nextBookId: state.nextBookId
    }
  }).state;
}

function flattenDirectories(nodes, parentId = null, rows = []) {
  (nodes || []).forEach((node, index) => {
    rows.push({
      id: String(node.id),
      parentId,
      name: String(node.name || '未命名目录'),
      system: Boolean(node.system),
      position: index
    });
    flattenDirectories(node.children || [], String(node.id), rows);
  });
  return rows;
}

function runQuery(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function runOne(db, sql, params = []) {
  return runQuery(db, sql, params)[0] || null;
}

function safePathSegment(value, fallback = '未命名') {
  let result = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!result) result = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result)) result = `_${result}`;
  return result.slice(0, 80);
}

function managedAttachmentName(originalName) {
  const extension = path.extname(originalName).replace(/[^.a-z0-9_-]/gi, '').slice(0, 16);
  const baseName = path.basename(originalName, path.extname(originalName));
  const safeBase = safePathSegment(baseName, 'attachment').slice(0, 64);
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBase}${extension}`;
}

function buildDirectorySegments(nodes, parentSegments = [], result = new Map()) {
  for (const node of nodes || []) {
    const segments = node.id === UNCATEGORIZED_ID
      ? ['未分类']
      : [...parentSegments, safePathSegment(node.name, '未命名分类')];
    result.set(node.id, segments);
    buildDirectorySegments(node.children || [], segments, result);
  }
  return result;
}

function desiredStoragePath(book, directories, directorySegments = buildDirectorySegments(directories)) {
  const folderName = `${safePathSegment(book.title, '未命名书籍')}__${safePathSegment(book.id, 'book')}`;
  if (book.deletedAt) return path.join('books', '.trash', folderName);
  const segments = directorySegments.get(book.directoryId)
    || directorySegments.get(UNCATEGORIZED_ID)
    || ['未分类'];
  return path.join('books', ...segments, folderName);
}

function mimeFromExtension(fileName) {
  const extension = path.extname(fileName || '').toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp'
  })[extension] || 'application/octet-stream';
}

function extensionFromMime(mimeType) {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/bmp': '.bmp'
  })[String(mimeType || '').toLowerCase()] || '';
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('封面数据格式无效。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_COVER_SIZE) throw new Error('封面图片不能超过 12 MB。');
  return { mimeType: match[1].toLowerCase(), buffer };
}

async function writeJsonAtomic(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const serialized = JSON.stringify(value, null, 2);
  try {
    if (await fsp.readFile(targetPath, 'utf8') === serialized) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tempPath, serialized, 'utf8');
  await fsp.rename(tempPath, targetPath);
  return true;
}

async function moveFolder(source, target) {
  if (source === target || !fs.existsSync(source)) return;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  }
  await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: false });
  await fsp.rm(source, { recursive: true, force: true });
}

async function pruneEmptyDirectories(directoryPath, keepPath = directoryPath) {
  if (!fs.existsSync(directoryPath)) return;
  const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirectories(path.join(directoryPath, entry.name), keepPath);
  }
  if (path.resolve(directoryPath) === path.resolve(keepPath)) return;
  const remaining = await fsp.readdir(directoryPath);
  if (!remaining.length) await fsp.rmdir(directoryPath);
}

async function createDatabaseStore(baseDir) {
  const rootPath = path.resolve(baseDir);
  await Promise.all([
    fsp.mkdir(rootPath, { recursive: true }),
    fsp.mkdir(path.join(rootPath, 'backups'), { recursive: true }),
    fsp.mkdir(path.join(rootPath, 'exports'), { recursive: true }),
    fsp.mkdir(path.join(rootPath, 'books', '.trash'), { recursive: true }),
    fsp.mkdir(path.join(rootPath, 'books', '未分类'), { recursive: true })
  ]);

  const SQL = await getSql();
  const dbPath = path.join(rootPath, 'book-manager.sqlite');
  const backupDir = path.join(rootPath, 'backups');
  const exportDir = path.join(rootPath, 'exports');
  const databaseExisted = fs.existsSync(dbPath);
  const db = databaseExisted ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error('书库数据库已经关闭。');
  }

  function persist() {
    assertOpen();
    const tempPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
    const data = Buffer.from(db.export());
    let descriptor = null;
    try {
      descriptor = fs.openSync(tempPath, 'w');
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(tempPath, dbPath);
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function pruneBackups() {
    const backups = fs.readdirSync(backupDir)
      .filter((name) => name.endsWith('.sqlite'))
      .sort()
      .reverse();
    for (const name of backups.slice(MAX_AUTOMATIC_BACKUPS)) {
      fs.rmSync(path.join(backupDir, name), { force: true });
    }
  }

  function createRecoveryBackup(reason = 'manual', oncePerDay = false) {
    assertOpen();
    if (!fs.existsSync(dbPath)) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const suffix = String(reason).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const existing = oncePerDay
      ? fs.readdirSync(backupDir).filter((name) => name.startsWith(`book-manager_${day}_`) && name.endsWith(`_${suffix}.sqlite`))
      : [];
    if (existing.length) return path.join(backupDir, existing[0]);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `book-manager_${timestamp}_${suffix}.sqlite`);
    fs.copyFileSync(dbPath, target);
    pruneBackups();
    return target;
  }

  function ensureColumn(table, column, definition) {
    const columns = new Set(runQuery(db, `PRAGMA table_info(${table})`).map((row) => row.name));
    if (!columns.has(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  function ensureSchema() {
    assertOpen();
    db.run(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS directories (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES directories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        system INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        directory_id TEXT REFERENCES directories(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        original_title TEXT,
        author TEXT,
        translator TEXT,
        isbn TEXT,
        publisher TEXT,
        publish_date TEXT,
        edition TEXT,
        series TEXT,
        series_index TEXT,
        language TEXT,
        format TEXT,
        page_count INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        reading_status TEXT,
        rating INTEGER NOT NULL DEFAULT 0,
        cover_file TEXT,
        storage_path TEXT,
        notes TEXT,
        started_at TEXT,
        finished_at TEXT,
        deleted_at INTEGER,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        start_page INTEGER NOT NULL,
        end_page INTEGER NOT NULL,
        current_page INTEGER NOT NULL,
        notes TEXT,
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS book_tags (
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (book_id, tag)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    ensureColumn('directories', 'system', 'INTEGER NOT NULL DEFAULT 0');
    const bookColumns = {
      subtitle: 'TEXT', original_title: 'TEXT', translator: 'TEXT', edition: 'TEXT', series: 'TEXT',
      series_index: 'TEXT', format: 'TEXT', page_count: 'INTEGER NOT NULL DEFAULT 0', description: 'TEXT',
      cover_file: 'TEXT', storage_path: 'TEXT', started_at: 'TEXT', finished_at: 'TEXT', deleted_at: 'INTEGER'
    };
    for (const [column, definition] of Object.entries(bookColumns)) ensureColumn('books', column, definition);
    ensureColumn('chapters', 'notes', 'TEXT');
    db.run(
      `INSERT OR IGNORE INTO directories (id, parent_id, name, system, position)
       VALUES (?, NULL, '未分类', 1, -1000)`,
      [UNCATEGORIZED_ID]
    );
    db.run(`UPDATE directories SET name = '未分类', system = 1, parent_id = NULL WHERE id = ?`, [UNCATEGORIZED_ID]);
    db.run(`UPDATE books SET directory_id = ? WHERE directory_id IS NULL`, [UNCATEGORIZED_ID]);
    db.run(`PRAGMA user_version = ${DATABASE_VERSION}`);
    persist();
  }

  function createAutomaticBackup() {
    if (!databaseExisted) return null;
    return createRecoveryBackup('auto', true);
  }

  function upsertSetting(key, value) {
    db.run(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), Date.now()]
    );
  }

  function getSetting(key) {
    assertOpen();
    const row = runOne(db, 'SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  function setSetting(key, value) {
    assertOpen();
    db.run('BEGIN TRANSACTION');
    let committed = false;
    try {
      upsertSetting(key, value);
      db.run('COMMIT');
      committed = true;
      persist();
    } catch (error) {
      if (!committed) db.run('ROLLBACK');
      throw error;
    }
  }

  function loadDirectories() {
    const rows = runQuery(db, 'SELECT * FROM directories ORDER BY parent_id, position, name');
    const byId = new Map();
    const roots = [];
    for (const row of rows) {
      byId.set(row.id, { id: row.id, name: row.name, system: Boolean(row.system), children: [] });
    }
    for (const row of rows) {
      const node = byId.get(row.id);
      if (row.parent_id && byId.has(row.parent_id) && row.id !== UNCATEGORIZED_ID) {
        byId.get(row.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }
    roots.sort((a, b) => Number(b.system) - Number(a.system));
    return roots;
  }

  function resolveStoredPath(relativePath) {
    const target = path.resolve(rootPath, relativePath || '');
    const booksRoot = path.join(rootPath, 'books');
    if (!isPathInside(booksRoot, target) || path.resolve(target) === path.resolve(booksRoot)) {
      throw new Error('书籍文件路径超出 books 目录。');
    }
    return target;
  }

  function resolveWithin(basePath, ...segments) {
    const target = path.resolve(basePath, ...segments);
    if (!isPathInside(basePath, target)) throw new Error('受管理的书籍文件路径无效。');
    return target;
  }

  function readCoverData(storagePath, coverFile) {
    if (!storagePath || !coverFile) return null;
    try {
      const folderPath = resolveStoredPath(storagePath);
      const filePath = resolveWithin(folderPath, coverFile);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_COVER_SIZE) return null;
      return `data:${mimeFromExtension(coverFile)};base64,${fs.readFileSync(filePath).toString('base64')}`;
    } catch {
      return null;
    }
  }

  function loadBooks() {
    const books = runQuery(db, 'SELECT * FROM books ORDER BY created_at DESC, title').map((row) => ({
      id: row.id,
      directoryId: row.directory_id || UNCATEGORIZED_ID,
      title: row.title,
      subtitle: row.subtitle || '',
      originalTitle: row.original_title || '',
      author: row.author || '',
      translator: row.translator || '',
      isbn: row.isbn || '',
      publisher: row.publisher || '',
      publishDate: row.publish_date || '',
      edition: row.edition || '',
      series: row.series || '',
      seriesIndex: row.series_index || '',
      language: row.language || '',
      format: row.format || '',
      pageCount: normalizeNumber(row.page_count, 0),
      description: row.description || '',
      readingStatus: row.reading_status || 'want',
      tags: [],
      rating: normalizeNumber(row.rating, 0),
      coverFile: row.cover_file || '',
      cover: readCoverData(row.storage_path, row.cover_file),
      storagePath: row.storage_path || '',
      chapters: [],
      attachments: [],
      notes: row.notes || '',
      startedAt: row.started_at || '',
      finishedAt: row.finished_at || '',
      deletedAt: row.deleted_at ? normalizeNumber(row.deleted_at, null) : null,
      createdAt: normalizeNumber(row.created_at, Date.now())
    }));

    const byId = new Map(books.map((book) => [book.id, book]));
    for (const row of runQuery(db, 'SELECT * FROM book_tags ORDER BY book_id, position, tag')) {
      const book = byId.get(row.book_id);
      if (book) book.tags.push(row.tag);
    }
    for (const row of runQuery(db, 'SELECT * FROM chapters ORDER BY book_id, position, start_page')) {
      const book = byId.get(row.book_id);
      if (book) {
        book.chapters.push({
          id: row.id,
          name: row.name,
          startPage: normalizeNumber(row.start_page, 1),
          endPage: normalizeNumber(row.end_page, 1),
          currentPage: normalizeNumber(row.current_page, 0),
          notes: row.notes || ''
        });
      }
    }
    for (const row of runQuery(db, 'SELECT * FROM attachments ORDER BY book_id, position, created_at')) {
      const book = byId.get(row.book_id);
      if (!book) continue;
      let missing = true;
      try {
        const attachmentsPath = resolveWithin(resolveStoredPath(book.storagePath), 'attachments');
        const filePath = resolveWithin(attachmentsPath, row.stored_name);
        missing = !fs.existsSync(filePath);
      } catch {
        missing = true;
      }
      book.attachments.push({
        id: row.id,
        name: row.name,
        storedName: row.stored_name,
        mimeType: row.mime_type || '',
        size: normalizeNumber(row.size, 0),
        createdAt: normalizeNumber(row.created_at, Date.now()),
        missing
      });
    }
    return books;
  }

  function load() {
    assertOpen();
    const directories = loadDirectories();
    const books = loadBooks();
    const flatDirectories = flattenDirectories(directories);
    const deriveNextId = (items, prefix) => items.reduce((max, item) => {
      const value = String(item.id || '');
      const parsed = value.startsWith(prefix) ? Number(value.slice(prefix.length)) : 0;
      return Number.isFinite(parsed) ? Math.max(max, parsed + 1) : max;
    }, 1);
    return {
      rootPath,
      dbPath,
      backupDir,
      exportDir,
      state: {
        directories,
        books,
        nextDirId: normalizeNumber(getSetting('nextDirId'), deriveNextId(flatDirectories, 'd')),
        nextBookId: normalizeNumber(getSetting('nextBookId'), deriveNextId(books, 'b'))
      },
      theme: getSetting('theme') || 'dark',
      readingGoal: normalizeNumber(getSetting('readingGoal'), 12)
    };
  }

  async function synchronizeBookFolders(state, previousStoragePaths) {
    const directorySegments = buildDirectorySegments(state.directories);
    for (const book of state.books) {
      const desiredRelativePath = desiredStoragePath(book, state.directories, directorySegments);
      const desiredAbsolutePath = resolveStoredPath(desiredRelativePath);
      const previousRelativePath = previousStoragePaths.get(book.id);
      if (previousRelativePath && previousRelativePath !== desiredRelativePath) {
        await moveFolder(resolveStoredPath(previousRelativePath), desiredAbsolutePath);
      }
      await fsp.mkdir(path.join(desiredAbsolutePath, 'attachments'), { recursive: true });
      book.storagePath = desiredRelativePath;

      if (book.cover && String(book.cover).startsWith('data:image/')) {
        const currentCoverPath = book.coverFile ? path.join(desiredAbsolutePath, book.coverFile) : '';
        if (!currentCoverPath || !fs.existsSync(currentCoverPath)) {
          const decoded = decodeDataUrl(book.cover);
          const extension = extensionFromMime(decoded.mimeType) || '.webp';
          book.coverFile = `cover${extension}`;
          await fsp.writeFile(path.join(desiredAbsolutePath, book.coverFile), decoded.buffer);
        }
      }

      const metadata = { ...book };
      delete metadata.cover;
      metadata.attachments = (metadata.attachments || []).map(({ missing, ...attachment }) => attachment);
      await writeJsonAtomic(path.join(desiredAbsolutePath, 'book.json'), metadata);
    }

    const booksRoot = path.join(rootPath, 'books');
    await pruneEmptyDirectories(booksRoot);
    await fsp.mkdir(path.join(booksRoot, '.trash'), { recursive: true });
    for (const segments of directorySegments.values()) {
      await fsp.mkdir(path.join(booksRoot, ...segments), { recursive: true });
    }
  }

  function replaceState(state) {
    const directoryRows = flattenDirectories(state.directories);
    db.run('DELETE FROM book_tags');
    db.run('DELETE FROM attachments');
    db.run('DELETE FROM chapters');
    db.run('DELETE FROM books');
    db.run('DELETE FROM directories');

    for (const directory of directoryRows) {
      db.run(
        'INSERT INTO directories (id, parent_id, name, system, position) VALUES (?, ?, ?, ?, ?)',
        [directory.id, directory.parentId, directory.name, directory.system ? 1 : 0, directory.position]
      );
    }

    for (const book of state.books) {
      db.run(
        `INSERT INTO books (
          id, directory_id, title, subtitle, original_title, author, translator, isbn,
          publisher, publish_date, edition, series, series_index, language, format,
          page_count, description, reading_status, rating, cover_file, storage_path,
          notes, started_at, finished_at, deleted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(book.id), book.directoryId || UNCATEGORIZED_ID, book.title, book.subtitle, book.originalTitle,
          book.author, book.translator, book.isbn, book.publisher, book.publishDate, book.edition,
          book.series, book.seriesIndex, book.language, book.format, book.pageCount, book.description,
          book.readingStatus, book.rating, book.coverFile, book.storagePath, book.notes,
          book.startedAt, book.finishedAt, book.deletedAt, book.createdAt
        ]
      );
      (book.tags || []).forEach((tag, index) => {
        db.run('INSERT OR IGNORE INTO book_tags (book_id, tag, position) VALUES (?, ?, ?)', [book.id, tag, index]);
      });
      (book.chapters || []).forEach((chapter, index) => {
        db.run(
          `INSERT INTO chapters (id, book_id, name, start_page, end_page, current_page, notes, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [chapter.id, book.id, chapter.name, chapter.startPage, chapter.endPage, chapter.currentPage, chapter.notes, index]
        );
      });
      (book.attachments || []).forEach((attachment, index) => {
        db.run(
          `INSERT INTO attachments (id, book_id, name, stored_name, mime_type, size, created_at, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [attachment.id, book.id, attachment.name, attachment.storedName, attachment.mimeType, attachment.size, attachment.createdAt, index]
        );
      });
    }
    upsertSetting('nextDirId', state.nextDirId);
    upsertSetting('nextBookId', state.nextBookId);
  }

  async function saveState(rawState, returnPayload = true) {
    assertOpen();
    const state = normalizeState(rawState);
    const previousStoragePaths = new Map(
      runQuery(db, 'SELECT id, storage_path FROM books').map((row) => [row.id, row.storage_path || ''])
    );
    await synchronizeBookFolders(state, previousStoragePaths);
    db.run('BEGIN TRANSACTION');
    let committed = false;
    try {
      replaceState(state);
      db.run('COMMIT');
      committed = true;
      persist();
      return returnPayload ? load() : { rootPath, dbPath, backupDir, exportDir };
    } catch (error) {
      if (!committed) db.run('ROLLBACK');
      throw error;
    }
  }

  async function importBackup(rawState, settings = {}) {
    assertOpen();
    createRecoveryBackup('before-import');
    const state = normalizeState(rawState);
    const previousStoragePaths = new Map(
      runQuery(db, 'SELECT id, storage_path FROM books').map((row) => [row.id, row.storage_path || ''])
    );
    await synchronizeBookFolders(state, previousStoragePaths);
    db.run('BEGIN TRANSACTION');
    let committed = false;
    try {
      replaceState(state);
      if (settings.theme === 'dark' || settings.theme === 'light') upsertSetting('theme', settings.theme);
      if (Number.isFinite(Number(settings.readingGoal))) {
        upsertSetting('readingGoal', Math.max(1, Math.min(365, Number(settings.readingGoal))));
      }
      db.run('COMMIT');
      committed = true;
      persist();
      return load();
    } catch (error) {
      if (!committed) db.run('ROLLBACK');
      throw error;
    }
  }

  function findBookOrThrow(state, bookId) {
    const book = state.books.find((item) => item.id === bookId);
    if (!book) throw new Error('找不到这本书。');
    return book;
  }

  async function addAttachments(bookId, sourcePaths) {
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    const folder = resolveStoredPath(book.storagePath || desiredStoragePath(book, payload.state.directories));
    const attachmentsDir = path.join(folder, 'attachments');
    await fsp.mkdir(attachmentsDir, { recursive: true });

    for (const sourcePath of sourcePaths || []) {
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_ATTACHMENT_SIZE) throw new Error(`附件“${path.basename(sourcePath)}”超过 2 GB。`);
      const originalName = path.basename(sourcePath);
      const storedName = managedAttachmentName(originalName);
      await fsp.copyFile(sourcePath, path.join(attachmentsDir, storedName));
      book.attachments.push({
        id: `${book.id}-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: originalName,
        storedName,
        mimeType: mimeFromExtension(originalName),
        size: stat.size,
        createdAt: Date.now(),
        missing: false
      });
    }
    return saveState(payload.state);
  }

  async function removeAttachment(bookId, attachmentId) {
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    const attachment = book.attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new Error('找不到这个附件。');
    const attachmentsPath = resolveWithin(resolveStoredPath(book.storagePath), 'attachments');
    const filePath = resolveWithin(attachmentsPath, attachment.storedName);
    book.attachments = book.attachments.filter((item) => item.id !== attachmentId);
    const next = await saveState(payload.state);
    await fsp.rm(filePath, { force: true });
    return next;
  }

  function getAttachmentPath(bookId, attachmentId) {
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    const attachment = book.attachments.find((item) => item.id === attachmentId);
    if (!attachment) throw new Error('找不到这个附件。');
    const attachmentsPath = resolveWithin(resolveStoredPath(book.storagePath), 'attachments');
    const filePath = resolveWithin(attachmentsPath, attachment.storedName);
    if (!fs.existsSync(filePath)) throw new Error('附件文件已经不存在。');
    return filePath;
  }

  function getBookFolder(bookId) {
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    return resolveStoredPath(book.storagePath || desiredStoragePath(book, payload.state.directories));
  }

  async function saveCoverBuffer(bookId, buffer, mimeType) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_COVER_SIZE) {
      throw new Error('封面图片不能超过 12 MB。');
    }
    const extension = extensionFromMime(mimeType);
    if (!extension) throw new Error('仅支持 PNG、JPEG、WebP、GIF、AVIF 或 BMP 图片。');
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    const folder = resolveStoredPath(book.storagePath || desiredStoragePath(book, payload.state.directories));
    await fsp.mkdir(folder, { recursive: true });
    if (book.coverFile) await fsp.rm(resolveWithin(folder, book.coverFile), { force: true });
    const coverFile = `cover${extension}`;
    const target = path.join(folder, coverFile);
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, target);
    book.coverFile = coverFile;
    book.cover = `data:${mimeType};base64,${buffer.toString('base64')}`;
    return saveState(payload.state);
  }

  async function setCoverFromFile(bookId, sourcePath) {
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile() || stat.size > MAX_COVER_SIZE) throw new Error('封面图片不能超过 12 MB。');
    const mimeType = mimeFromExtension(sourcePath);
    if (!mimeType.startsWith('image/')) throw new Error('请选择支持的图片文件。');
    return saveCoverBuffer(bookId, await fsp.readFile(sourcePath), mimeType);
  }

  async function removeCover(bookId) {
    const payload = load();
    const book = findBookOrThrow(payload.state, bookId);
    const oldCoverPath = book.coverFile
      ? resolveWithin(resolveStoredPath(book.storagePath || desiredStoragePath(book, payload.state.directories)), book.coverFile)
      : '';
    book.coverFile = '';
    book.cover = null;
    const next = await saveState(payload.state);
    if (oldCoverPath) await fsp.rm(oldCoverPath, { force: true });
    return next;
  }

  async function permanentlyDeleteBook(bookId) {
    const row = runOne(db, 'SELECT storage_path, deleted_at FROM books WHERE id = ?', [bookId]);
    if (!row) throw new Error('找不到这本书。');
    if (!row.deleted_at) throw new Error('只有回收站中的书籍可以永久删除。');
    createRecoveryBackup('before-permanent-delete');
    db.run('BEGIN TRANSACTION');
    let committed = false;
    try {
      db.run('DELETE FROM books WHERE id = ?', [bookId]);
      db.run('COMMIT');
      committed = true;
      persist();
    } catch (error) {
      if (!committed) db.run('ROLLBACK');
      throw error;
    }
    if (row.storage_path) await fsp.rm(resolveStoredPath(row.storage_path), { recursive: true, force: true });
    return load();
  }

  function close() {
    if (closed) return;
    db.close();
    closed = true;
  }

  createAutomaticBackup();
  ensureSchema();

  return {
    rootPath,
    dbPath,
    backupDir,
    exportDir,
    load,
    saveState,
    importBackup,
    createRecoveryBackup,
    getSetting,
    setSetting,
    addAttachments,
    removeAttachment,
    getAttachmentPath,
    getBookFolder,
    saveCoverBuffer,
    setCoverFromFile,
    removeCover,
    permanentlyDeleteBook,
    close
  };
}

module.exports = {
  DATABASE_VERSION,
  MAX_COVER_SIZE,
  createDatabaseStore,
  desiredStoragePath,
  safePathSegment
};
