const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'main.jsx'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.equal(rendererSource.includes('window.confirm'), false, 'Use application dialogs instead of window.confirm.');
assert.equal(rendererSource.includes('window.prompt'), false, 'Use application dialogs instead of window.prompt.');
assert.match(htmlSource, /<html lang="zh-CN">/, 'Declare the document language.');
assert.match(rendererSource, /<table className="chapterTable">/, 'Chapter progress must use native table semantics.');
assert.match(rendererSource, /event\.key !== 'ContextMenu'/, 'Book context actions need a keyboard path.');
assert.match(styleSource, /button:focus-visible/, 'Interactive controls need a visible keyboard focus style.');
assert.match(styleSource, /prefers-reduced-motion: reduce/, 'The UI must respect reduced-motion preferences.');

console.log('Renderer dialog source regression test passed');
