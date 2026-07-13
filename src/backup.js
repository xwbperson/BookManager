const BACKUP_SCHEMA_VERSION = 3;
const MAX_DIRECTORY_DEPTH = 5;
const MAX_BOOKS = 100000;
const MAX_CHAPTERS_PER_BOOK = 10000;
const MAX_ATTACHMENTS_PER_BOOK = 1000;
const UNCATEGORIZED_ID = 'd-uncategorized';

function cleanString(value, fallback = '', maxLength = 10000) {
  const text = value == null ? fallback : String(value);
  return text.slice(0, maxLength);
}

function cleanDate(value) {
  const text = cleanString(value, '', 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function cleanManagedFileName(value, label) {
  const fileName = cleanString(value, '', 500).trim();
  if (!fileName) return '';
  if (fileName === '.' || fileName === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(fileName)) {
    throw new Error(`${label}文件名不安全。`);
  }
  return fileName;
}

function assertValidDirectoryName(name) {
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error(`目录名称“${name}”不能安全保存到 Windows 文件系统。`);
  }
}

function nextAvailableId(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    const value = String(id || '');
    if (!value.startsWith(prefix)) continue;
    const number = Number(value.slice(prefix.length));
    if (Number.isFinite(number)) max = Math.max(max, number);
  }
  return max + 1;
}

function normalizeDirectories(nodes, depth, seen, flatIds) {
  if (!Array.isArray(nodes)) throw new Error('目录数据必须是数组。');
  if (depth >= MAX_DIRECTORY_DEPTH && nodes.length) {
    throw new Error(`目录最多支持 ${MAX_DIRECTORY_DEPTH} 级。`);
  }

  const siblingNames = new Set();
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') throw new Error('目录数据格式无效。');
    const id = cleanString(node.id, '', 120).trim();
    if (!id || seen.has(id)) throw new Error('目录 ID 缺失或重复。');
    seen.add(id);
    flatIds.push(id);
    const name = cleanString(node.name, '未命名目录', 200).trim() || '未命名目录';
    assertValidDirectoryName(name);
    const nameKey = name.toLocaleLowerCase('zh-CN');
    if (siblingNames.has(nameKey)) throw new Error(`同一层级存在重复目录名称“${name}”。`);
    siblingNames.add(nameKey);
    return {
      id,
      name,
      system: id === UNCATEGORIZED_ID,
      children: normalizeDirectories(node.children || [], depth + 1, seen, flatIds)
    };
  });
}

function ensureUncategorized(directories) {
  let uncategorized = null;
  const removeSystemDirectory = (nodes) => nodes.filter((directory) => {
    if (directory.id === UNCATEGORIZED_ID) {
      if ((directory.children || []).length) throw new Error('“未分类”不能包含子目录。');
      uncategorized = directory;
      return false;
    }
    directory.children = removeSystemDirectory(directory.children || []);
    return true;
  });
  const remaining = removeSystemDirectory(directories);
  directories.splice(0, directories.length, ...remaining);
  if (directories.some((directory) => directory.name.trim().toLocaleLowerCase('zh-CN') === '未分类')) {
    throw new Error('“未分类”是系统目录名称，不能用于自定义根目录。');
  }
  uncategorized ||= { id: UNCATEGORIZED_ID, name: '未分类', system: true, children: [] };
  uncategorized.name = '未分类';
  uncategorized.system = true;
  uncategorized.children = [];
  directories.unshift(uncategorized);
  return directories;
}

function normalizeChapter(chapter, bookId, index, chapterIds) {
  if (!chapter || typeof chapter !== 'object') throw new Error('章节数据格式无效。');
  let id = cleanString(chapter.id, '', 160).trim();
  if (!id || chapterIds.has(id)) id = `${bookId}-ch${index + 1}`;
  while (chapterIds.has(id)) id = `${id}-copy`;
  chapterIds.add(id);

  const startPage = Math.max(1, Number(chapter.startPage) || 1);
  const endPage = Math.max(startPage, Number(chapter.endPage) || startPage);
  const inputCurrentPage = Number(chapter.currentPage);
  const currentPage = Math.max(
    startPage - 1,
    Math.min(endPage, Number.isFinite(inputCurrentPage) ? inputCurrentPage : startPage - 1)
  );

  return {
    id,
    name: cleanString(chapter.name, `第${index + 1}章`, 300).trim() || `第${index + 1}章`,
    startPage,
    endPage,
    currentPage,
    notes: cleanString(chapter.notes, '', 100000)
  };
}

function normalizeAttachment(attachment, bookId, index, attachmentIds) {
  if (!attachment || typeof attachment !== 'object') throw new Error('附件数据格式无效。');
  let id = cleanString(attachment.id, '', 160).trim() || `${bookId}-att${index + 1}`;
  while (attachmentIds.has(id)) id = `${id}-copy`;
  attachmentIds.add(id);
  const storedName = cleanManagedFileName(attachment.storedName, '附件');
  if (!storedName) throw new Error('附件缺少受管理的文件名。');
  return {
    id,
    name: cleanString(attachment.name, storedName || `附件 ${index + 1}`, 500).trim() || `附件 ${index + 1}`,
    storedName,
    mimeType: cleanString(attachment.mimeType, '', 200),
    size: Math.max(0, Number(attachment.size) || 0),
    createdAt: Number(attachment.createdAt) || Date.now(),
    missing: Boolean(attachment.missing)
  };
}

function normalizeBackupPayload(data) {
  if (!data || typeof data !== 'object') throw new Error('备份文件不是有效对象。');
  const rawState = data.state && typeof data.state === 'object' ? data.state : data;
  if (!Array.isArray(rawState.directories) || !Array.isArray(rawState.books)) {
    throw new Error('备份文件缺少目录或书籍数组。');
  }
  if (rawState.books.length > MAX_BOOKS) throw new Error('备份中的书籍数量超出限制。');

  const directoryIds = [];
  const directories = ensureUncategorized(normalizeDirectories(rawState.directories, 0, new Set(), directoryIds));
  if (!directoryIds.includes(UNCATEGORIZED_ID)) directoryIds.unshift(UNCATEGORIZED_ID);
  const directoryIdSet = new Set(directoryIds);
  const bookIds = new Set();
  const chapterIds = new Set();
  const attachmentIds = new Set();

  const books = rawState.books.map((book, bookIndex) => {
    if (!book || typeof book !== 'object') throw new Error('书籍数据格式无效。');
    const id = cleanString(book.id, '', 120).trim();
    if (!id || bookIds.has(id)) throw new Error('书籍 ID 缺失或重复。');
    bookIds.add(id);
    const rawChapters = Array.isArray(book.chapters) ? book.chapters : [];
    const rawAttachments = Array.isArray(book.attachments) ? book.attachments : [];
    if (rawChapters.length > MAX_CHAPTERS_PER_BOOK) throw new Error(`《${book.title || id}》的章节数量超出限制。`);
    if (rawAttachments.length > MAX_ATTACHMENTS_PER_BOOK) throw new Error(`《${book.title || id}》的附件数量超出限制。`);
    const readingStatus = ['want', 'reading', 'finished'].includes(book.readingStatus)
      ? book.readingStatus
      : 'want';
    const requestedDirectoryId = cleanString(book.directoryId || book.subDirectoryId || '', '', 120);
    const directoryId = directoryIdSet.has(requestedDirectoryId) ? requestedDirectoryId : UNCATEGORIZED_ID;
    const createdAt = Number(book.createdAt);

    const coverFile = cleanManagedFileName(book.coverFile, '封面');
    if (coverFile && !/^cover\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(coverFile)) {
      throw new Error('封面文件名格式无效。');
    }

    return {
      id,
      directoryId,
      title: cleanString(book.title, `未命名书籍 ${bookIndex + 1}`, 500).trim() || `未命名书籍 ${bookIndex + 1}`,
      subtitle: cleanString(book.subtitle, '', 500),
      originalTitle: cleanString(book.originalTitle, '', 500),
      author: cleanString(book.author, '', 500),
      translator: cleanString(book.translator, '', 500),
      isbn: cleanString(book.isbn, '', 100),
      publisher: cleanString(book.publisher, '', 500),
      publishDate: cleanDate(book.publishDate),
      edition: cleanString(book.edition, '', 200),
      series: cleanString(book.series, '', 300),
      seriesIndex: cleanString(book.seriesIndex, '', 100),
      language: cleanString(book.language, '', 100),
      format: cleanString(book.format, '', 100),
      pageCount: Math.max(0, Number(book.pageCount) || 0),
      description: cleanString(book.description, '', 200000),
      readingStatus,
      tags: [...new Set((Array.isArray(book.tags) ? book.tags : [])
        .map((tag) => cleanString(tag, '', 100).trim())
        .filter(Boolean))].slice(0, 100),
      rating: Math.max(0, Math.min(5, Number(book.rating) || 0)),
      cover: typeof book.cover === 'string' && book.cover.startsWith('data:image/') ? book.cover : null,
      coverFile,
      storagePath: cleanString(book.storagePath, '', 2000),
      chapters: rawChapters.map((chapter, index) => normalizeChapter(chapter, id, index, chapterIds)),
      attachments: rawAttachments.map((attachment, index) => normalizeAttachment(attachment, id, index, attachmentIds)),
      notes: cleanString(book.notes, '', 200000),
      startedAt: cleanDate(book.startedAt),
      finishedAt: cleanDate(book.finishedAt),
      deletedAt: Number(book.deletedAt) || null,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now()
    };
  });

  const nextDirId = Math.max(Number(rawState.nextDirId) || 1, nextAvailableId(directoryIds, 'd'));
  const nextBookId = Math.max(Number(rawState.nextBookId) || 1, nextAvailableId([...bookIds], 'b'));
  const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    state: { directories, books, nextDirId, nextBookId },
    settings: {
      theme: rawSettings.theme === 'light' || rawSettings.theme === 'dark' ? rawSettings.theme : undefined,
      readingGoal: Number.isFinite(Number(rawSettings.readingGoal))
        ? Math.max(1, Math.min(365, Number(rawSettings.readingGoal)))
        : undefined
    }
  };
}

function createBackupPayload(state, settings) {
  return normalizeBackupPayload({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    state,
    settings: {
      theme: settings?.theme || 'dark',
      readingGoal: settings?.readingGoal || 12
    }
  });
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  MAX_DIRECTORY_DEPTH,
  UNCATEGORIZED_ID,
  createBackupPayload,
  normalizeBackupPayload
};
