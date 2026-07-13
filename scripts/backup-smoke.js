const assert = require('node:assert/strict');
const { BACKUP_SCHEMA_VERSION, UNCATEGORIZED_ID, createBackupPayload, normalizeBackupPayload } = require('../src/backup');

const state = {
  directories: [{ id: 'd1', name: '技术', children: [] }],
  books: [{
    id: 'b1',
    directoryId: 'd1',
    title: '测试书籍',
    subtitle: '副标题',
    author: '',
    translator: '译者',
    isbn: '',
    publisher: '',
    publishDate: '',
    language: '中文',
    format: '电子书',
    pageCount: 120,
    description: '简介',
    readingStatus: 'finished',
    tags: ['测试', '测试'],
    rating: 9,
    cover: null,
    chapters: [{ id: 'ch1', name: '第一章', startPage: 10, endPage: 20, currentPage: 99, notes: '章节备注' }],
    attachments: [{ id: 'a1', name: 'book.epub', storedName: 'stored.epub', size: 42, createdAt: 1 }],
    notes: '',
    startedAt: '2026-01-01',
    finishedAt: '2026-01-02',
    deletedAt: null,
    createdAt: 1710000000000
  }],
  nextDirId: 2,
  nextBookId: 2
};

const payload = createBackupPayload(state, { theme: 'light', readingGoal: 23 });
assert.equal(payload.schemaVersion, BACKUP_SCHEMA_VERSION);
assert.equal(BACKUP_SCHEMA_VERSION, 3);
assert.equal(payload.settings.theme, 'light');
assert.equal(payload.settings.readingGoal, 23);
assert.equal(payload.state.directories[0].id, UNCATEGORIZED_ID);
assert.equal(payload.state.books[0].rating, 5);
assert.deepEqual(payload.state.books[0].tags, ['测试']);
assert.equal(payload.state.books[0].chapters[0].currentPage, 20);
assert.equal(payload.state.books[0].chapters[0].notes, '章节备注');
assert.equal(payload.state.books[0].attachments[0].storedName, 'stored.epub');
assert.equal(payload.state.books[0].description, '简介');

const legacy = normalizeBackupPayload(state);
assert.equal(legacy.state.books[0].title, '测试书籍');
assert.equal(legacy.settings.theme, undefined);
assert.equal(legacy.settings.readingGoal, undefined);

assert.throws(() => normalizeBackupPayload({
  directories: [{ id: 'd1', name: 'A', children: [{ id: 'd1', name: 'B', children: [] }] }],
  books: []
}), /重复/);

assert.throws(() => normalizeBackupPayload({
  directories: [{ id: 'd1', name: '技术', children: [] }, { id: 'd2', name: '技术', children: [] }],
  books: []
}), /重复目录名称/);

assert.throws(() => normalizeBackupPayload({
  directories: [],
  books: [{ ...state.books[0], id: 'b-path', attachments: [{ id: 'a-path', name: 'bad', storedName: '..\\..\\book-manager.sqlite' }] }]
}), /文件名不安全/);

assert.throws(() => normalizeBackupPayload({
  directories: [],
  books: [{ ...state.books[0], id: 'b-cover-path', coverFile: '..\\book-manager.sqlite' }]
}), /文件名不安全/);

assert.throws(() => normalizeBackupPayload({
  directories: [{ id: 'd-invalid', name: '技术/前端', children: [] }],
  books: []
}), /Windows 文件系统/);

let deep = [];
for (let depth = 0; depth < 6; depth += 1) {
  deep = [{ id: `d${depth}`, name: `L${depth}`, children: deep }];
}
assert.throws(() => normalizeBackupPayload({ directories: deep, books: [] }), /最多支持/);

console.log('Backup validation smoke test passed');
