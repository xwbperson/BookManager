const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const electronPath = require('electron');
const port = 9333;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the Electron DevTools target.');
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });

  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      sequence += 1;
      socket.send(JSON.stringify({ id: sequence, method, params }));
      return new Promise((resolve, reject) => pending.set(sequence, { resolve, reject }));
    },
    on(method, listener) {
      const items = listeners.get(method) || [];
      items.push(listener);
      listeners.set(method, items);
    },
    close() {
      socket.close();
    }
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed.');
  }
  return result.result.value;
}

async function waitFor(client, expression, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await delay(75);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function collectA11yProblems(client) {
  return evaluate(client, `(() => {
    const visible = (element) => element.getClientRects().length > 0;
    const buttons = [...document.querySelectorAll('button')]
      .filter(visible)
      .filter((button) => !button.textContent.trim() && !button.getAttribute('aria-label') && !button.title)
      .map((button) => button.outerHTML.slice(0, 180));
    const fields = [...document.querySelectorAll('input, select, textarea')]
      .filter(visible)
      .filter((field) => !(field.labels?.length) && !field.getAttribute('aria-label') && !field.getAttribute('aria-labelledby'))
      .map((field) => field.outerHTML.slice(0, 180));
    return { buttons, fields };
  })()`);
}

async function listRelativeFiles(rootPath) {
  try {
    return await fs.readdir(rootPath, { recursive: true });
  } catch {
    return [];
  }
}

async function main() {
  const failures = [];
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'book-manager-ui-'));
  const exportPath = path.join(userDataDir, 'export-test.json');
  const importPath = path.join(userDataDir, 'import-test.json');
  const libraryRoot = path.join(userDataDir, 'library');
  const alternativeRoot = path.join(userDataDir, 'migrated-library');
  const attachmentPath = path.join(userDataDir, '测试附件.epub');
  await fs.writeFile(attachmentPath, 'electron attachment test', 'utf8');

  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const coverServer = http.createServer((request, response) => {
    if (request.url === '/cover.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': tinyPng.length });
      response.end(tinyPng);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    coverServer.once('error', reject);
    coverServer.listen(0, '127.0.0.1', resolve);
  });
  const coverUrl = `http://127.0.0.1:${coverServer.address().port}/cover.png`;
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '.'
  ], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      BOOK_MANAGER_TEST_EXPORT_PATH: exportPath,
      BOOK_MANAGER_TEST_IMPORT_PATH: importPath,
      BOOK_MANAGER_TEST_LIBRARY_ROOT: libraryRoot,
      BOOK_MANAGER_TEST_ATTACHMENT_PATHS: JSON.stringify([attachmentPath]),
      BOOK_MANAGER_TEST_CHOOSE_ROOT: alternativeRoot
    }
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let client;
  try {
    const target = await waitForTarget();
    client = createCdpClient(target.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 520,
      deviceScaleFactor: 1,
      mobile: false
    });

    client.on('Page.javascriptDialogOpening', () => {
      failures.push('The renderer opened a native JavaScript dialog.');
      client.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });

    await waitFor(client, "document.querySelector('.appShell')");

    await evaluate(client, `
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.includes('新建目录'))
        ?.click();
      true;
    `);
    await delay(150);
    const directoryDialogVisible = await evaluate(
      client,
      `Boolean([...document.querySelectorAll('[role="dialog"]')]
        .find((dialog) => dialog.textContent.includes('目录')))`
    );
    if (!directoryDialogVisible) {
      failures.push('Clicking 新建目录 must open an in-app directory dialog.');
    } else {
      try {
        await waitFor(client, "document.activeElement === document.querySelector('[role=\"dialog\"] input')", 1000);
      } catch {
        failures.push('The directory dialog must focus its name input.');
      }
      await evaluate(client, `(() => {
        const input = document.querySelector('[role="dialog"] input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '自动化测试目录');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[role="dialog"] button[type="submit"]').click();
        return true;
      })()`);
      await waitFor(client, "document.body.textContent.includes('自动化测试目录') && !document.querySelector('[role=\"dialog\"]')");
    }

    await evaluate(client, `
      window.bookManagerDb.saveState({
        directories: [{ id: 'd1', name: '自动化测试目录', children: [] }],
        books: [{
          id: 'b1',
          directoryId: null,
          title: '滚动测试书籍',
          author: '测试作者',
          isbn: '',
          publisher: '',
          publishDate: '',
          language: '中文',
          readingStatus: 'reading',
          tags: ['测试'],
          rating: 4,
          cover: null,
          chapters: Array.from({ length: 18 }, (_, index) => ({
            id: 'ch' + (index + 1),
            name: '第' + (index + 1) + '章',
            startPage: index * 20 + 1,
            endPage: index * 20 + 20,
            currentPage: index * 20 + 10
          })),
          notes: '用于验证详情页在低窗口下可以滚动。\\n'.repeat(20),
          createdAt: Date.now()
        }],
        nextDirId: 2,
        nextBookId: 2
      }).then(() => location.reload());
      true;
    `);

    await waitFor(client, "document.querySelector('.bookCard')");

    await evaluate(client, `(() => {
      const card = document.querySelector('.bookCard');
      card.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 420,
        clientY: 260
      }));
      return true;
    })()`);
    await delay(120);
    const contextMenu = await evaluate(client, `(() => {
      const menu = document.querySelector('.contextMenu');
      return {
        visible: Boolean(menu),
        text: menu?.textContent || ''
      };
    })()`);
    if (!contextMenu.visible || !contextMenu.text.includes('编辑') || !contextMenu.text.includes('移动分类') || !contextMenu.text.includes('移入回收站')) {
      failures.push(`Book cards must expose edit, move and trash actions on right-click: ${JSON.stringify(contextMenu)}`);
    }
    if (contextMenu.visible) {
      await evaluate(client, `(() => {
        [...document.querySelectorAll('.contextMenu button')]
          .find((button) => button.textContent.includes('移动分类'))?.click();
        return true;
      })()`);
      await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
        .some((dialog) => dialog.textContent.includes('移动《滚动测试书籍》'))`);
      await evaluate(client, `(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((item) => item.textContent.includes('移动《滚动测试书籍》'));
        const select = dialog.querySelector('select');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'd1');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        dialog.querySelector('button[type="submit"]').click();
        return true;
      })()`);
      await waitFor(client, `!document.querySelector('[role="dialog"]') && !document.querySelector('.saveIndicator.saving')`);
    } else {
      await evaluate(client, `document.body.click(); true;`);
    }

    await evaluate(client, `document.querySelector('.bookCard').focus(); true;`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F10', code: 'F10', nativeVirtualKeyCode: 121, modifiers: 8 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F10', code: 'F10', nativeVirtualKeyCode: 121, modifiers: 8 });
    await waitFor(client, `document.querySelector('.contextMenu')`);
    const keyboardMenuFocus = await evaluate(client, `({
      role: document.activeElement?.getAttribute('role') || '',
      text: document.activeElement?.textContent || ''
    })`);
    if (keyboardMenuFocus.role !== 'menuitem') {
      failures.push(`Keyboard-opened context menu must focus its first item: ${JSON.stringify(keyboardMenuFocus)}`);
    }
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', nativeVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', nativeVirtualKeyCode: 27 });
    await waitFor(client, `!document.querySelector('.contextMenu') && document.activeElement?.classList.contains('bookCard')`);
    const listA11y = await collectA11yProblems(client);
    if (listA11y.buttons.length || listA11y.fields.length) {
      failures.push(`Visible bookshelf controls need accessible names: ${JSON.stringify(listA11y)}`);
    }

    const directoryCountSpacing = await evaluate(client, `(() => [...document.querySelectorAll('.treeSelect')]
      .map((item) => {
        const name = item.querySelector('.treeName')?.getBoundingClientRect();
        const count = item.querySelector('.treeCount')?.getBoundingClientRect();
        return name && count ? { label: item.textContent.trim(), gap: count.left - name.right } : null;
      })
      .filter(Boolean))()`);
    if (directoryCountSpacing.some((item) => item.gap > 12)) {
      failures.push(`Directory counts must stay visually attached to their names: ${JSON.stringify(directoryCountSpacing)}`);
    }

    const globalActions = await evaluate(client, `(() => ({
      hasTrash: document.body.textContent.includes('回收站'),
      hasSettings: [...document.querySelectorAll('button')].some((button) => button.textContent.includes('设置')),
      nativeConfirmSource: document.documentElement.innerHTML.includes('window.confirm')
    }))()`);
    if (!globalActions.hasTrash) failures.push('The sidebar must provide a recycle bin view.');
    if (!globalActions.hasSettings) failures.push('The sidebar must provide library settings.');

    await evaluate(client, `document.querySelector('.bookCard').click(); true;`);
    await waitFor(client, "document.querySelector('.detailView')");

    const layout = await evaluate(client, `(() => {
      const detail = document.querySelector('.detailView');
      const footer = document.querySelector('.sidebarFooter');
      const backButton = document.querySelector('.backButton');
      const identityHeader = document.querySelector('.detailIdentityHeader');
      const facts = document.querySelector('.detailFacts');
      const breadcrumbs = document.querySelector('.topbar .breadcrumbs');
      const topActionLabels = [...document.querySelectorAll('.topActions > button:not(.iconButton):not(.saveIndicator)')]
        .map((button) => button.textContent.trim());
      const themeButton = document.querySelector('.topActions > .iconButton');
      const trashButton = [...document.querySelectorAll('.topActions > button')]
        .find((button) => button.textContent.includes('移入回收站'));
      const ratingRect = document.querySelector('.ratingEdit')?.getBoundingClientRect();
      const statusRect = document.querySelector('.statusGroup')?.getBoundingClientRect();
      const chapterSection = document.querySelector('.chapterSection');
      const attachmentSection = document.querySelector('.attachmentSection');
      detail.scrollTop = 120;
      return {
        detailOverflows: detail.scrollHeight > detail.clientHeight,
        detailScrolls: detail.scrollTop > 0,
        footerVisible: footer.getBoundingClientRect().bottom <= window.innerHeight + 1,
        footerTop: footer.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
        backButtonHasBorder: parseFloat(getComputedStyle(backButton).borderTopWidth) > 0,
        backStartsTopbarPath: Boolean(breadcrumbs?.firstElementChild === backButton),
        topbarShowsBookPath: Boolean(breadcrumbs?.textContent.includes('全部书籍') && breadcrumbs?.textContent.includes('自动化测试目录')),
        detailHasNoDuplicatePath: !document.querySelector('.detailView .crumbs'),
        identityContainsHeading: Boolean(identityHeader?.querySelector('h2')),
        factsAlignWithIdentity: Math.abs(facts.getBoundingClientRect().top - identityHeader.getBoundingClientRect().top) <= 12,
        topActionLabels,
        themeFollowsDetailActions: Boolean(trashButton?.compareDocumentPosition(themeButton) & Node.DOCUMENT_POSITION_FOLLOWING),
        readingControlsInline: Boolean(ratingRect && statusRect && Math.abs(ratingRect.top - statusRect.top) <= 2),
        readingControlsGap: ratingRect && statusRect ? statusRect.left - ratingRect.right : -1,
        chapterBeforeAttachment: Boolean(chapterSection?.compareDocumentPosition(attachmentSection) & Node.DOCUMENT_POSITION_FOLLOWING),
        addChapterInsideSection: Boolean([...chapterSection.querySelectorAll('button')]
          .some((button) => button.textContent.includes('添加章节')))
      };
    })()`);

    if (!layout.detailOverflows) failures.push('The book detail page must have overflow content in the fixture.');
    if (!layout.detailScrolls) failures.push('The book detail page must scroll vertically.');
    if (!layout.footerVisible) failures.push(`Sidebar footer is clipped: ${JSON.stringify(layout)}`);
    if (!layout.backButtonHasBorder) failures.push(`The back-to-list action must have a visible boundary: ${JSON.stringify(layout)}`);
    if (!layout.backStartsTopbarPath || !layout.topbarShowsBookPath) {
      failures.push(`The top bar must start with back-to-list followed by the selected book path: ${JSON.stringify(layout)}`);
    }
    if (!layout.detailHasNoDuplicatePath) failures.push(`The detail body must not repeat the top-bar path: ${JSON.stringify(layout)}`);
    if (!layout.identityContainsHeading) failures.push(`Book identity information must sit above the cover: ${JSON.stringify(layout)}`);
    if (!layout.factsAlignWithIdentity) failures.push(`Book fact cards must start at the top of the detail hero: ${JSON.stringify(layout)}`);
    if (layout.topActionLabels.slice(0, 2).join('|') !== '编辑|移入回收站' || !layout.themeFollowsDetailActions) {
      failures.push(`Edit and trash must sit before the theme switch in the top bar: ${JSON.stringify(layout)}`);
    }
    if (!layout.readingControlsInline || layout.readingControlsGap < 8 || layout.readingControlsGap > 28) {
      failures.push(`Reading status must follow the rating with a compact gap: ${JSON.stringify(layout)}`);
    }
    if (!layout.chapterBeforeAttachment) failures.push(`Chapter progress must appear before attachments: ${JSON.stringify(layout)}`);
    if (!layout.addChapterInsideSection) failures.push(`The add-chapter action must live inside chapter progress: ${JSON.stringify(layout)}`);
    const detailA11y = await collectA11yProblems(client);
    if (detailA11y.buttons.length || detailA11y.fields.length) {
      failures.push(`Visible detail controls need accessible names: ${JSON.stringify(detailA11y)}`);
    }
    if (process.env.BOOK_MANAGER_UI_SCREENSHOT_PATH) {
      await evaluate(client, `document.querySelector('.detailView').scrollTop = 0; true;`);
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await fs.writeFile(process.env.BOOK_MANAGER_UI_SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
    }

    const attachmentUi = await evaluate(client, `(() => ({
      hasSection: document.querySelector('.detailView')?.textContent.includes('附件'),
      hasAddButton: [...document.querySelectorAll('.detailView button')]
        .some((button) => button.textContent.includes('添加附件'))
    }))()`);
    if (!attachmentUi.hasSection || !attachmentUi.hasAddButton) {
      failures.push(`Book details must provide an attachment section and add action: ${JSON.stringify(attachmentUi)}`);
    }

    await evaluate(client, `(() => {
      [...document.querySelectorAll('.detailView button')]
        .find((button) => button.textContent.includes('添加附件'))?.click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.attachmentList')?.textContent.includes('测试附件.epub')`);

    await evaluate(client, `(() => {
      [...document.querySelectorAll('.coverActions button')]
        .find((button) => button.textContent.includes('从 URL'))?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('从 URL 导入'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('从 URL 导入'));
      const input = dialog.querySelector('input[type="url"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(coverUrl)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      dialog.querySelector('button[type="submit"]').click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.detailCover img') && !document.querySelector('[role="dialog"]')`, 10000);

    await evaluate(client, `(() => {
      [...document.querySelectorAll('.detailView button')]
        .find((button) => button.textContent.includes('添加章节'))
        ?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent.includes('添加章节'))`);
    const chapterDialogA11y = await collectA11yProblems(client);
    if (chapterDialogA11y.buttons.length || chapterDialogA11y.fields.length) {
      failures.push(`Visible chapter dialog controls need accessible names: ${JSON.stringify(chapterDialogA11y)}`);
    }
    const chapterDefaults = await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('添加章节'));
      const field = (label) => [...dialog.querySelectorAll('label')]
        .find((item) => item.textContent.includes(label))?.querySelector('input, textarea');
      return {
        startPage: field('起始页')?.value,
        endPage: field('终止页')?.value,
        hasNotes: Boolean([...dialog.querySelectorAll('label')]
          .find((item) => item.textContent.includes('章节备注'))?.querySelector('textarea'))
      };
    })()`);
    if (chapterDefaults.startPage !== '361' || chapterDefaults.endPage !== '380') {
      failures.push(`A new chapter must continue after the last end page (expected 361-380): ${JSON.stringify(chapterDefaults)}`);
    }
    if (!chapterDefaults.hasNotes) failures.push('Each chapter must provide a notes field.');
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('添加章节'));
      const notes = [...dialog.querySelectorAll('label')]
        .find((item) => item.textContent.includes('章节备注'))?.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(notes, '自动化章节备注');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
      dialog.querySelector('button[type="submit"]').click();
      return true;
    })()`);
    await waitFor(client, `![...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent.includes('添加章节'))`);
    await waitFor(client, `[...document.querySelectorAll('.chapterName small')]
      .some((item) => item.textContent.includes('自动化章节备注'))`);

    await evaluate(client, `
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '导出')
        ?.click();
      true;
    `);
    const exportDeadline = Date.now() + 4000;
    while (Date.now() < exportDeadline) {
      try {
        await fs.access(exportPath);
        break;
      } catch {
        await delay(75);
      }
    }
    const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
    if (exported.schemaVersion !== 3) failures.push('Exported backup must include schemaVersion 3.');
    if (exported.state?.books?.[0]?.title !== '滚动测试书籍') failures.push('Exported backup is missing the current book data.');
    if (!exported.settings || !('readingGoal' in exported.settings)) failures.push('Exported backup is missing app settings.');
    const exportedBook = exported.state?.books?.[0];
    if (exportedBook?.directoryId !== 'd1') failures.push('Moving a book from the card context menu was not persisted.');
    if (exportedBook?.chapters?.at(-1)?.startPage !== 361 || exportedBook?.chapters?.at(-1)?.notes !== '自动化章节备注') {
      failures.push('The new chapter defaults and notes were not persisted to JSON.');
    }
    if (exportedBook?.attachments?.[0]?.name !== '测试附件.epub') failures.push('Attachment metadata was not exported.');
    if (!exportedBook?.cover) failures.push('The downloaded local cover was not included in JSON backup data.');

    const managedFiles = await listRelativeFiles(libraryRoot);
    if (!managedFiles.some((file) => file.endsWith('测试附件.epub') || file.includes('测试附件.epub'))) {
      failures.push(`The attachment was not copied into the library root: ${JSON.stringify(managedFiles)}`);
    }
    if (!managedFiles.some((file) => /cover\.(png|jpe?g|webp)$/i.test(file))) {
      failures.push(`The URL cover was not saved under the library root: ${JSON.stringify(managedFiles)}`);
    }

    exported.state.books[0].title = '导入验证书籍';
    exported.settings = { theme: 'light', readingGoal: 23 };
    await fs.writeFile(importPath, JSON.stringify(exported, null, 2), 'utf8');
    await evaluate(client, `
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '导入')
        ?.click();
      true;
    `);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('导入 JSON 书库'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('导入 JSON 书库'));
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '确认导入')?.click();
      return true;
    })()`);
    await waitFor(client, "document.body.textContent.includes('导入验证书籍')");
    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.includes('统计'))
        ?.click();
      return true;
    })()`);
    await waitFor(client, "document.querySelector('.goalControl input')?.value === '23'");
    const importedSettings = await evaluate(client, `(() => ({
        theme: document.documentElement.dataset.theme,
        goal: document.querySelector('.goalControl input')?.value
      }))()`);
    if (importedSettings.theme !== 'light') failures.push('Imported theme setting was not restored.');
    if (importedSettings.goal !== '23') failures.push('Imported reading goal was not restored.');

    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '设置')?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('书库设置'))`);
    const settingsPath = await evaluate(client, `document.querySelector('.pathBox')?.textContent || ''`);
    if (!settingsPath.includes('library')) failures.push(`Settings must display the current root path: ${settingsPath}`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('[role="dialog"] button')]
        .find((button) => button.textContent.includes('选择其他目录'))?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('迁移当前书库'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('迁移当前书库'));
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '迁移并切换')?.click();
      return true;
    })()`);
    await waitFor(client, `!document.querySelector('[role="dialog"]')`, 10000);
    const migratedFiles = await listRelativeFiles(alternativeRoot);
    if (!migratedFiles.includes('book-manager.sqlite')) failures.push('Root migration did not copy the database.');
    if (!migratedFiles.some((file) => file.includes('测试附件.epub'))) failures.push('Root migration did not copy attachments.');
    if (!migratedFiles.some((file) => /cover\.(png|jpe?g|webp)$/i.test(file))) failures.push('Root migration did not copy covers.');

    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '书架')?.click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      const card = document.querySelector('.bookCard');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 260 }));
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.contextMenu')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('.contextMenu button')]
        .find((button) => button.textContent.includes('移入回收站'))?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('移入回收站'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('移入回收站'));
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '移入回收站')?.click();
      return true;
    })()`);
    await waitFor(client, `!document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.includes('回收站'))?.click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      const card = document.querySelector('.bookCard');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 260 }));
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.contextMenu')?.textContent.includes('恢复到原分类')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('.contextMenu button')]
        .find((button) => button.textContent.includes('恢复到原分类'))?.click();
      return true;
    })()`);
    await waitFor(client, `!document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '书架')?.click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.bookCard')`);

    await evaluate(client, `(() => {
      const card = document.querySelector('.bookCard');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 260 }));
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.contextMenu')?.textContent.includes('移入回收站')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('.contextMenu button')]
        .find((button) => button.textContent.includes('移入回收站'))?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('移入回收站'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('移入回收站'));
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '移入回收站')?.click();
      return true;
    })()`);
    await waitFor(client, `!document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent.includes('回收站'))?.click();
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.bookCard')`);
    await evaluate(client, `(() => {
      const card = document.querySelector('.bookCard');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 260 }));
      return true;
    })()`);
    await waitFor(client, `document.querySelector('.contextMenu')?.textContent.includes('永久删除')`);
    await evaluate(client, `(() => {
      [...document.querySelectorAll('.contextMenu button')]
        .find((button) => button.textContent.includes('永久删除'))?.click();
      return true;
    })()`);
    await waitFor(client, `[...document.querySelectorAll('[role="dialog"]')]
      .some((dialog) => dialog.textContent.includes('永久删除《'))`);
    await evaluate(client, `(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((item) => item.textContent.includes('永久删除《'));
      [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '永久删除')?.click();
      return true;
    })()`);
    await waitFor(client, `!document.querySelector('.bookCard')`);
    const afterPermanentDelete = await listRelativeFiles(alternativeRoot);
    if (afterPermanentDelete.some((file) => file.includes('__b1'))) {
      failures.push(`Permanent deletion left the managed book folder behind: ${JSON.stringify(afterPermanentDelete)}`);
    }

    assert.deepEqual(failures, []);

    console.log('Electron UI regression test passed');
  } finally {
    if (client) client.close();
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
    await new Promise((resolve) => coverServer.close(resolve));
    await fs.rm(userDataDir, { recursive: true, force: true });
    if (stderr && process.env.DEBUG_UI_TEST === '1') process.stderr.write(stderr);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
