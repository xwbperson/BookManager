const { spawn } = require('node:child_process');

const vite = spawn('npx', ['vite', '--host', '127.0.0.1'], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let electron = null;

function startElectron() {
  if (electron) return;
  electron = spawn('npx', ['electron', '.'], {
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173'
    }
  });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code || 0);
  });
}

function handleOutput(chunk, target) {
  const text = chunk.toString();
  target.write(text);
  if (text.includes('Local:') || text.includes('ready in')) {
    startElectron();
  }
}

vite.stdout.on('data', (chunk) => handleOutput(chunk, process.stdout));
vite.stderr.on('data', (chunk) => handleOutput(chunk, process.stderr));
vite.on('exit', (code) => {
  if (electron) electron.kill();
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  if (electron) electron.kill();
  vite.kill();
});
