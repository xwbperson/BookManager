const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CONFIG_FILE = 'library-location.json';
const DATABASE_FILE = 'book-manager.sqlite';

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureLibraryRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  await Promise.all([
    fsp.mkdir(resolved, { recursive: true }),
    fsp.mkdir(path.join(resolved, 'backups'), { recursive: true }),
    fsp.mkdir(path.join(resolved, 'exports'), { recursive: true }),
    fsp.mkdir(path.join(resolved, 'books'), { recursive: true }),
    fsp.mkdir(path.join(resolved, 'books', '.trash'), { recursive: true })
  ]);
  return resolved;
}

async function readConfiguredRoot(userDataDir) {
  try {
    const config = JSON.parse(await fsp.readFile(path.join(userDataDir, CONFIG_FILE), 'utf8'));
    return typeof config.libraryRoot === 'string' && config.libraryRoot.trim()
      ? path.resolve(config.libraryRoot)
      : null;
  } catch {
    return null;
  }
}

async function writeConfiguredRoot(userDataDir, rootPath) {
  await fsp.mkdir(userDataDir, { recursive: true });
  const configPath = path.join(userDataDir, CONFIG_FILE);
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify({ libraryRoot: path.resolve(rootPath) }, null, 2);
  await fsp.writeFile(tempPath, payload, 'utf8');
  await fsp.rename(tempPath, configPath);
  return configPath;
}

async function resolveLibraryRoot({ userDataDir, documentsDir, overridePath = '' }) {
  const configured = overridePath
    ? path.resolve(overridePath)
    : await readConfiguredRoot(userDataDir);
  const fallback = path.join(documentsDir, 'BookManagerLibrary');
  return ensureLibraryRoot(configured || fallback);
}

async function inspectLibraryRoot(rootPath) {
  const resolved = path.resolve(rootPath);
  let entries = [];
  try {
    entries = await fsp.readdir(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    path: resolved,
    hasLibrary: entries.includes(DATABASE_FILE),
    isEmpty: entries.length === 0
  };
}

async function migrateLibraryRoot(sourcePath, targetPath) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  if (source.toLowerCase() === target.toLowerCase()) return ensureLibraryRoot(target);
  if (isPathInside(source, target) || isPathInside(target, source)) {
    throw new Error('新旧书库根目录不能互相包含，请选择另一个独立目录。');
  }

  const inspection = await inspectLibraryRoot(target);
  if (inspection.hasLibrary) {
    throw new Error('目标目录已经包含一个书库，请选择“打开现有书库”。');
  }
  if (!inspection.isEmpty) {
    throw new Error('目标目录不是空目录。为避免混合文件，请选择一个空目录。');
  }

  await fsp.mkdir(target, { recursive: true });
  if (await pathExists(source)) {
    await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: false });
  }
  return ensureLibraryRoot(target);
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  CONFIG_FILE,
  DATABASE_FILE,
  ensureLibraryRoot,
  inspectLibraryRoot,
  isPathInside,
  migrateLibraryRoot,
  readConfiguredRoot,
  resolveLibraryRoot,
  writeConfiguredRoot
};
