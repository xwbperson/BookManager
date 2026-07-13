const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const smokeRoot = path.join(os.tmpdir(), `book-manager-electron-smoke-${process.pid}`);
const smokeUserData = path.join(os.tmpdir(), `book-manager-electron-user-data-${process.pid}`);

const child = spawn('npx', ['electron', `--user-data-dir=${smokeUserData}`, '.'], {
  shell: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_SMOKE_TEST: '1',
    BOOK_MANAGER_TEST_LIBRARY_ROOT: smokeRoot
  }
});

const timeout = setTimeout(() => {
  child.kill();
  console.error('Electron smoke test timed out');
  process.exit(1);
}, 15000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.rmSync(smokeUserData, { recursive: true, force: true });
  process.exit(code || 0);
});
