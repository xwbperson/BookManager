const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDatabaseStore } = require('../src/database');
const { UNCATEGORIZED_ID } = require('../src/backup');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'book-manager-db-'));
  const sourceAttachment = path.join(root, 'sample.epub');
  await fs.writeFile(sourceAttachment, 'fake epub content', 'utf8');
  const store = await createDatabaseStore(root);

  const sample = {
    directories: [
      { id: UNCATEGORIZED_ID, name: '未分类', system: true, children: [] },
      {
        id: 'd1',
        name: '技术',
        children: [{ id: 'd2', name: '前端', children: [] }]
      }
    ],
    books: [
      {
        id: 'b1',
        directoryId: 'd2',
        title: 'JavaScript 权威指南',
        subtitle: '长期参考书',
        originalTitle: 'JavaScript: The Definitive Guide',
        author: 'David Flanagan',
        translator: '测试译者',
        isbn: '9787111376613',
        publisher: 'OReilly',
        publishDate: '2021-04-01',
        edition: '第 7 版',
        series: '编程经典',
        seriesIndex: '7',
        language: '中文',
        format: '纸质书',
        pageCount: 706,
        description: '一本 JavaScript 参考书。',
        readingStatus: 'reading',
        tags: ['编程', 'JavaScript'],
        rating: 5,
        cover: null,
        chapters: [{ id: 'ch1', name: '第一章', startPage: 1, endPage: 20, currentPage: 10, notes: '重点章节' }],
        attachments: [],
        notes: '重读',
        startedAt: '2026-01-02',
        finishedAt: '',
        deletedAt: null,
        createdAt: 1710000000000
      }
    ],
    nextDirId: 3,
    nextBookId: 2
  };

  await store.saveState(sample);
  store.setSetting('theme', 'light');
  store.setSetting('readingGoal', '24');

  let loaded = store.load();
  const book = loaded.state.books.find((item) => item.id === 'b1');
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.readingGoal, 24);
  assert.equal(loaded.state.directories[0].id, UNCATEGORIZED_ID);
  assert.equal(loaded.state.directories.find((item) => item.id === 'd1').children[0].name, '前端');
  assert.equal(book.subtitle, '长期参考书');
  assert.equal(book.translator, '测试译者');
  assert.equal(book.description, '一本 JavaScript 参考书。');
  assert.equal(book.chapters[0].notes, '重点章节');
  assert.match(book.storagePath, /技术[\\/]前端/);
  assert.equal(await exists(path.join(root, book.storagePath, 'book.json')), true);

  loaded = await store.addAttachments('b1', [sourceAttachment]);
  let updatedBook = loaded.state.books.find((item) => item.id === 'b1');
  assert.equal(updatedBook.attachments.length, 1);
  const attachmentPath = path.join(root, updatedBook.storagePath, 'attachments', updatedBook.attachments[0].storedName);
  assert.equal(await fs.readFile(attachmentPath, 'utf8'), 'fake epub content');

  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  loaded = await store.saveCoverBuffer('b1', tinyPng, 'image/png');
  updatedBook = loaded.state.books.find((item) => item.id === 'b1');
  assert.equal(updatedBook.coverFile, 'cover.png');
  assert.match(updatedBook.cover, /^data:image\/png;base64,/);
  assert.equal(await exists(path.join(root, updatedBook.storagePath, 'cover.png')), true);

  updatedBook.deletedAt = Date.now();
  loaded = await store.saveState(loaded.state);
  updatedBook = loaded.state.books.find((item) => item.id === 'b1');
  assert.match(updatedBook.storagePath, /books[\\/]\.trash/);
  assert.equal(await exists(path.join(root, updatedBook.storagePath, 'book.json')), true);

  updatedBook.deletedAt = null;
  loaded = await store.saveState(loaded.state);
  updatedBook = loaded.state.books.find((item) => item.id === 'b1');
  assert.match(updatedBook.storagePath, /技术[\\/]前端/);
  assert.equal(updatedBook.attachments.length, 1);

  await store.importBackup(sample, { theme: 'dark', readingGoal: 18 });
  const imported = store.load();
  assert.equal(imported.theme, 'dark');
  assert.equal(imported.readingGoal, 18);

  store.close();
  const reopened = await createDatabaseStore(root);
  const backupFiles = await fs.readdir(reopened.backupDir);
  assert.ok(backupFiles.some((name) => name.endsWith('_auto.sqlite')));
  reopened.close();

  await fs.rm(root, { recursive: true, force: true });
  console.log('SQLite and managed book files smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
