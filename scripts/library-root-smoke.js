const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  inspectLibraryRoot,
  migrateLibraryRoot,
  readConfiguredRoot,
  resolveLibraryRoot,
  writeConfiguredRoot
} = require('../src/library-root');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'book-manager-root-'));
  const userData = path.join(temp, 'user-data');
  const documents = path.join(temp, 'documents');
  await fs.mkdir(documents, { recursive: true });

  const defaultRoot = await resolveLibraryRoot({ userDataDir: userData, documentsDir: documents });
  assert.equal(defaultRoot, path.join(documents, 'BookManagerLibrary'));
  for (const relative of ['backups', 'exports', 'books', path.join('books', '.trash')]) {
    assert.equal((await fs.stat(path.join(defaultRoot, relative))).isDirectory(), true);
  }

  const customRoot = path.join(temp, 'custom-library');
  await writeConfiguredRoot(userData, customRoot);
  assert.equal(await readConfiguredRoot(userData), customRoot);
  assert.equal(await resolveLibraryRoot({ userDataDir: userData, documentsDir: documents }), customRoot);

  await fs.writeFile(path.join(defaultRoot, 'book-manager.sqlite'), 'database', 'utf8');
  await fs.writeFile(path.join(defaultRoot, 'sentinel.txt'), 'copied', 'utf8');
  const migrated = path.join(temp, 'migrated-library');
  await migrateLibraryRoot(defaultRoot, migrated);
  assert.equal((await inspectLibraryRoot(migrated)).hasLibrary, true);
  assert.equal(await fs.readFile(path.join(migrated, 'sentinel.txt'), 'utf8'), 'copied');

  const nonEmpty = path.join(temp, 'non-empty');
  await fs.mkdir(nonEmpty);
  await fs.writeFile(path.join(nonEmpty, 'unrelated.txt'), 'keep', 'utf8');
  await assert.rejects(() => migrateLibraryRoot(defaultRoot, nonEmpty), /不是空目录/);
  await assert.rejects(() => migrateLibraryRoot(defaultRoot, path.join(defaultRoot, 'nested')), /不能互相包含/);

  await fs.rm(temp, { recursive: true, force: true });
  console.log('Library root smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
