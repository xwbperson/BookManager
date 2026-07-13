import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Edit3,
  ExternalLink,
  File,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Home,
  ImagePlus,
  LayoutList,
  Link,
  Moon,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Star,
  Sun,
  Trash2,
  X
} from 'lucide-react';
import './styles.css';

const MAX_DIR_DEPTH = 5;
const BOOK_PAGE_SIZE = 60;
const UNCATEGORIZED_ID = 'd-uncategorized';
const EMPTY_STATE = {
  directories: [{ id: UNCATEGORIZED_ID, name: '未分类', system: true, children: [] }],
  books: [],
  nextDirId: 1,
  nextBookId: 1
};
const STATUS_LABELS = {
  want: '想读',
  reading: '在读',
  finished: '已读'
};

const SORT_OPTIONS = [
  ['added-desc', '最近添加'],
  ['added-asc', '最早添加'],
  ['title', '按书名'],
  ['author', '按作者'],
  ['progress-desc', '进度最高'],
  ['progress-asc', '进度最低'],
  ['rating-desc', '评分最高']
];

function clone(value) {
  return structuredClone(value);
}

function calcProgress(book) {
  if (!book.chapters || book.chapters.length === 0) {
    return { totalPages: 0, readPages: 0, percentage: 0, status: book.readingStatus || 'want' };
  }

  let totalPages = 0;
  let readPages = 0;
  for (const chapter of book.chapters) {
    const pages = Math.max(0, Number(chapter.endPage) - Number(chapter.startPage) + 1);
    totalPages += pages;
    readPages += Math.max(0, Math.min(pages, Number(chapter.currentPage) - Number(chapter.startPage) + 1));
  }

  const percentage = totalPages > 0 ? Math.round((readPages / totalPages) * 100) : 0;
  return { totalPages, readPages, percentage, status: book.readingStatus || 'want' };
}

function formatFileSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function flattenDirs(nodes, depth = 0, parentId = null, rows = []) {
  for (const node of nodes || []) {
    rows.push({ id: node.id, name: node.name, depth, parentId, children: node.children || [] });
    flattenDirs(node.children || [], depth + 1, node.id, rows);
  }
  return rows;
}

function findDir(nodes, id, parent = null, path = [], depth = 0) {
  for (let index = 0; index < (nodes || []).length; index += 1) {
    const node = nodes[index];
    const nextPath = [...path, node];
    if (node.id === id) return { node, parent, path: nextPath, depth, index, siblings: nodes };
    const child = findDir(node.children || [], id, node, nextPath, depth + 1);
    if (child) return child;
  }
  return null;
}

function descendantDirIds(nodes, id) {
  const found = findDir(nodes, id);
  if (!found) return [id];
  const ids = [id];
  const walk = (children) => {
    for (const child of children || []) {
      ids.push(child.id);
      walk(child.children || []);
    }
  };
  walk(found.node.children || []);
  return ids;
}

function countBooksInDir(state, dirId) {
  const ids = descendantDirIds(state.directories, dirId);
  return state.books.filter((book) => !book.deletedAt && ids.includes(book.directoryId)).length;
}

function normalizeImport(data) {
  const next = {
    directories: Array.isArray(data.directories) ? data.directories : [],
    books: Array.isArray(data.books) ? data.books : [],
    nextDirId: Number(data.nextDirId) || 1,
    nextBookId: Number(data.nextBookId) || 1
  };

  const ensureChildren = (nodes) => {
    for (const node of nodes) {
      if (!Array.isArray(node.children)) node.children = [];
      ensureChildren(node.children);
    }
  };
  ensureChildren(next.directories);

  const uncategorizedIndex = next.directories.findIndex((directory) => directory.id === UNCATEGORIZED_ID);
  const uncategorized = uncategorizedIndex >= 0
    ? next.directories.splice(uncategorizedIndex, 1)[0]
    : { id: UNCATEGORIZED_ID, name: '未分类', system: true, children: [] };
  Object.assign(uncategorized, { name: '未分类', system: true, children: [] });
  next.directories.unshift(uncategorized);

  next.books = next.books.map((book) => ({
    id: book.id,
    directoryId: book.directoryId || book.subDirectoryId || UNCATEGORIZED_ID,
    title: book.title || '未命名书籍',
    subtitle: book.subtitle || '',
    originalTitle: book.originalTitle || '',
    author: book.author || '',
    translator: book.translator || '',
    isbn: book.isbn || '',
    publisher: book.publisher || '',
    publishDate: book.publishDate || '',
    edition: book.edition || '',
    series: book.series || '',
    seriesIndex: book.seriesIndex || '',
    language: book.language || '',
    format: book.format || '',
    pageCount: Number(book.pageCount) || 0,
    description: book.description || '',
    readingStatus: book.readingStatus || 'want',
    tags: Array.isArray(book.tags) ? book.tags : [],
    rating: Number(book.rating) || 0,
    cover: book.cover || null,
    coverFile: book.coverFile || '',
    storagePath: book.storagePath || '',
    chapters: Array.isArray(book.chapters) ? book.chapters.map((chapter) => ({ ...chapter, notes: chapter.notes || '' })) : [],
    attachments: Array.isArray(book.attachments) ? book.attachments : [],
    notes: book.notes || '',
    startedAt: book.startedAt || '',
    finishedAt: book.finishedAt || '',
    deletedAt: Number(book.deletedAt) || null,
    createdAt: Number(book.createdAt) || Date.now()
  }));

  const knownDirectoryIds = new Set(flattenDirs(next.directories).map((directory) => directory.id));
  next.books = next.books.map((book) => knownDirectoryIds.has(book.directoryId)
    ? book
    : { ...book, directoryId: UNCATEGORIZED_ID });

  const dirIds = flattenDirs(next.directories).map((dir) => dir.id);
  const bookIds = next.books.map((book) => book.id);
  next.nextDirId = Math.max(next.nextDirId, nextAvailableId(dirIds, 'd'));
  next.nextBookId = Math.max(next.nextBookId, nextAvailableId(bookIds, 'b'));

  return next;
}

function makeId(prefix, value) {
  return `${prefix}${value}`;
}

function nextAvailableId(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    const value = String(id || '');
    if (value.startsWith(prefix)) {
      const number = Number(value.slice(prefix.length));
      if (Number.isFinite(number)) max = Math.max(max, number);
    }
  }
  return max + 1;
}

function validateDirectoryName(value) {
  const name = value.trim();
  if (!name) return '请输入目录名称。';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    return '目录名称不能包含 < > : " / \\ | ? *，也不能以句点或空格结尾。';
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return '这个名称是 Windows 保留名称，请换一个。';
  return '';
}

function useToast() {
  const [toasts, setToasts] = useState([]);

  const pushToast = (message, type = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((items) => [...items, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, type === 'error' ? 6500 : 4200);
  };

  return [toasts, pushToast];
}

function Modal({ title, children, footer, onClose, onSubmit, overlayClassName = '', modalClassName = '' }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    window.queueMicrotask(() => {
      const autofocus = dialog?.querySelector('[data-autofocus="true"]');
      const firstFocusable = dialog?.querySelector(focusableSelector);
      (autofocus || firstFocusable)?.focus();
    });

    const handleKeyDown = (event) => {
      const overlay = dialog?.closest('.modalOverlay');
      const overlays = [...document.querySelectorAll('.modalOverlay')];
      if (overlays.at(-1) !== overlay) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll(focusableSelector)]
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.queueMicrotask(() => previouslyFocused?.focus?.());
    };
  }, []);

  const Element = onSubmit ? 'form' : 'section';
  return (
    <div className={`modalOverlay ${overlayClassName}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Element
        ref={dialogRef}
        className={`modal ${modalClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        autoComplete={onSubmit ? 'off' : undefined}
        noValidate={onSubmit ? true : undefined}
        onSubmit={onSubmit ? (event) => { event.preventDefault(); onSubmit(); } : undefined}
      >
        <header className="modalHeader">
          <h2>{title}</h2>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modalBody">{children}</div>
        {footer && <footer className="modalFooter">{footer}</footer>}
      </Element>
    </div>
  );
}

const ConfirmContext = React.createContext(async () => false);

function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const confirm = (options) => new Promise((resolve) => {
    setRequest({
      title: options.title || '请确认',
      message: options.message || '',
      confirmLabel: options.confirmLabel || '确认',
      danger: Boolean(options.danger),
      resolve
    });
  });
  const finish = (value) => {
    const current = request;
    setRequest(null);
    current?.resolve(value);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal
          title={request.title}
          onClose={() => finish(false)}
          overlayClassName="confirmOverlay"
          modalClassName="confirmModal"
          footer={
            <>
              <button type="button" className="secondaryButton" onClick={() => finish(false)}>取消</button>
              <button
                type="button"
                className={request.danger ? 'dangerButton solid' : 'primaryButton'}
                onClick={() => finish(true)}
                data-autofocus="true"
              >
                {request.confirmLabel}
              </button>
            </>
          }
        >
          <p className="confirmMessage">{request.message}</p>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

function DirectoryForm({ directory, parentName, onSave, onClose }) {
  const confirm = React.useContext(ConfirmContext);
  const [name, setName] = useState(directory?.name || '');
  const [error, setError] = useState('');
  const initialName = useRef(name);
  const requestClose = async () => {
    if (name !== initialName.current && !await confirm({
      title: '放弃目录修改？',
      message: '尚未保存的目录名称会丢失。',
      confirmLabel: '放弃修改',
      danger: true
    })) return;
    onClose();
  };
  const submit = () => {
    const value = name.trim();
    const validationError = validateDirectoryName(value);
    if (validationError) {
      setError(validationError);
      window.queueMicrotask(() => document.getElementById('directory-name')?.focus());
      return;
    }
    onSave(value);
  };

  return (
    <Modal
      title={directory ? '重命名目录' : parentName ? `在「${parentName}」下新建目录` : '新建目录'}
      onClose={requestClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={requestClose}>取消</button>
          <button type="submit" className="primaryButton">{directory ? '保存名称' : '创建目录'}</button>
        </>
      }
    >
      <label className="field full">
        <span>目录名称</span>
        <input
          id="directory-name"
          name="directoryName"
          value={name}
          maxLength={200}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'directory-name-error' : undefined}
          onChange={(event) => { setName(event.target.value); setError(''); }}
          autoFocus
          data-autofocus="true"
        />
      </label>
      {error && <p className="fieldError" id="directory-name-error" role="alert">{error}</p>}
    </Modal>
  );
}

function DirectoryTree({ state, directories = state.directories, selectedDirId, expanded, onToggle, onSelect, onAdd, onRename, onDelete }) {
  const renderNode = (node, depth = 0) => {
    const isExpanded = expanded.has(node.id) || selectedDirId === node.id;
    const hasChildren = node.children && node.children.length > 0;
    const active = selectedDirId === node.id;
    const count = countBooksInDir(state, node.id);

    return (
      <div className={`treeItem ${node.system ? 'systemTreeItem' : ''}`} key={node.id}>
        <div
          className={`treeNode ${node.system ? 'systemTreeNode' : ''} ${active ? 'active' : ''}`}
          style={{ paddingLeft: 12 + depth * 18 }}
        >
          {!node.system && (hasChildren ? (
            <button
              type="button"
              className="treeChevron"
              onClick={() => onToggle(node.id)}
              aria-label={isExpanded ? `折叠 ${node.name}` : `展开 ${node.name}`}
              aria-expanded={isExpanded}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : <span className="treeChevron" aria-hidden="true" />)}
          <button type="button" className="treeSelect" onClick={() => onSelect(node.id)}>
            <Folder size={16} />
            <span className="treeName">{node.name}</span>
            <span className="treeCount">{count}</span>
          </button>
          <span className="treeActions">
            {!node.system && depth < MAX_DIR_DEPTH - 1 && (
              <button type="button" title="添加子目录" aria-label={`在 ${node.name} 下添加子目录`} onClick={() => onAdd(node.id)}>
                <FolderPlus size={14} />
              </button>
            )}
            {!node.system && (
              <>
                <button type="button" title="重命名" aria-label={`重命名 ${node.name}`} onClick={() => onRename(node.id)}>
                  <Edit3 size={13} />
                </button>
                <button type="button" title="删除" aria-label={`删除 ${node.name}`} onClick={() => onDelete(node.id)}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </span>
        </div>
        {hasChildren && isExpanded && <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>}
      </div>
    );
  };

  return <>{directories.map((dir) => renderNode(dir))}</>;
}

function BookForm({ state, book, defaultDirId, onSave, onClose }) {
  const confirm = React.useContext(ConfirmContext);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    title: book?.title || '',
    subtitle: book?.subtitle || '',
    originalTitle: book?.originalTitle || '',
    author: book?.author || '',
    translator: book?.translator || '',
    isbn: book?.isbn || '',
    publisher: book?.publisher || '',
    publishDate: book?.publishDate || '',
    edition: book?.edition || '',
    series: book?.series || '',
    seriesIndex: book?.seriesIndex || '',
    language: book?.language || '',
    format: book?.format || '',
    pageCount: book?.pageCount || '',
    description: book?.description || '',
    readingStatus: book?.readingStatus || 'want',
    tags: (book?.tags || []).join(', '),
    directoryId: book?.directoryId || defaultDirId || UNCATEGORIZED_ID,
    notes: book?.notes || '',
    startedAt: book?.startedAt || '',
    finishedAt: book?.finishedAt || ''
  }));
  const initialForm = useRef(JSON.stringify(form));

  const flatDirs = useMemo(() => flattenDirs(state.directories), [state.directories]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => {
    if (!form.title.trim()) {
      setError('请输入书名。');
      window.queueMicrotask(() => document.getElementById('book-title')?.focus());
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    onSave({
      ...form,
      title: form.title.trim(),
      directoryId: form.directoryId || UNCATEGORIZED_ID,
      pageCount: Math.max(0, Number(form.pageCount) || 0),
      tags: form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      startedAt: form.startedAt || (form.readingStatus === 'reading' ? today : ''),
      finishedAt: form.finishedAt || (form.readingStatus === 'finished' ? today : '')
    });
  };
  const requestClose = async () => {
    if (JSON.stringify(form) !== initialForm.current && !await confirm({
      title: '放弃书籍修改？',
      message: '尚未保存的书籍字段会丢失。',
      confirmLabel: '放弃修改',
      danger: true
    })) return;
    onClose();
  };

  return (
    <Modal
      title={book ? '编辑书籍' : '添加书籍'}
      onClose={requestClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={requestClose}>取消</button>
          <button type="submit" className="primaryButton">{book ? '保存修改' : '添加书籍'}</button>
        </>
      }
    >
      <label className="field full">
        <span>书名 *</span>
        <input
          id="book-title"
          name="bookTitle"
          value={form.title}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'book-title-error' : undefined}
          onChange={(event) => { update('title', event.target.value); setError(''); }}
          autoFocus
          data-autofocus="true"
        />
      </label>
      {error && <p className="fieldError" id="book-title-error" role="alert">{error}</p>}
      <div className="formGrid">
        <label className="field">
          <span>副标题</span>
          <input name="subtitle" value={form.subtitle} onChange={(event) => update('subtitle', event.target.value)} />
        </label>
        <label className="field">
          <span>原书名</span>
          <input name="originalTitle" value={form.originalTitle} onChange={(event) => update('originalTitle', event.target.value)} />
        </label>
        <label className="field">
          <span>作者</span>
          <input name="author" value={form.author} onChange={(event) => update('author', event.target.value)} />
        </label>
        <label className="field">
          <span>译者</span>
          <input name="translator" value={form.translator} onChange={(event) => update('translator', event.target.value)} />
        </label>
        <label className="field">
          <span>ISBN</span>
          <input name="isbn" value={form.isbn} onChange={(event) => update('isbn', event.target.value)} />
        </label>
        <label className="field">
          <span>出版社</span>
          <input name="publisher" value={form.publisher} onChange={(event) => update('publisher', event.target.value)} />
        </label>
        <label className="field">
          <span>出版日期</span>
          <input name="publishDate" type="date" value={form.publishDate} onChange={(event) => update('publishDate', event.target.value)} />
        </label>
        <label className="field">
          <span>版本 / 版次</span>
          <input name="edition" value={form.edition} placeholder="例如：第 2 版" onChange={(event) => update('edition', event.target.value)} />
        </label>
        <label className="field">
          <span>载体</span>
          <select name="format" value={form.format} onChange={(event) => update('format', event.target.value)}>
            <option value="">未指定</option>
            <option value="纸质书">纸质书</option>
            <option value="电子书">电子书</option>
            <option value="有声书">有声书</option>
            <option value="其他">其他</option>
          </select>
        </label>
        <label className="field">
          <span>丛书 / 系列</span>
          <input name="series" value={form.series} onChange={(event) => update('series', event.target.value)} />
        </label>
        <label className="field">
          <span>系列序号</span>
          <input name="seriesIndex" value={form.seriesIndex} placeholder="例如：3" onChange={(event) => update('seriesIndex', event.target.value)} />
        </label>
        <label className="field">
          <span>语言</span>
          <select name="language" value={form.language} onChange={(event) => update('language', event.target.value)}>
            <option value="">未指定</option>
            <option value="中文">中文</option>
            <option value="英文">英文</option>
            <option value="日文">日文</option>
            <option value="其他">其他</option>
          </select>
        </label>
        <label className="field">
          <span>总页数（可选）</span>
          <input name="pageCount" type="number" min="0" value={form.pageCount} onChange={(event) => update('pageCount', event.target.value)} />
        </label>
        <label className="field">
          <span>阅读状态（手动选择）</span>
          <select name="readingStatus" value={form.readingStatus} onChange={(event) => update('readingStatus', event.target.value)}>
            <option value="want">想读</option>
            <option value="reading">在读</option>
            <option value="finished">已读</option>
          </select>
        </label>
        <label className="field">
          <span>开始阅读日期</span>
          <input name="startedAt" type="date" value={form.startedAt} onChange={(event) => update('startedAt', event.target.value)} />
        </label>
        <label className="field">
          <span>完成阅读日期</span>
          <input name="finishedAt" type="date" value={form.finishedAt} onChange={(event) => update('finishedAt', event.target.value)} />
        </label>
      </div>
      <label className="field full">
        <span>所属目录</span>
        <select name="directoryId" value={form.directoryId} onChange={(event) => update('directoryId', event.target.value)}>
          {flatDirs.map((dir) => (
            <option value={dir.id} key={dir.id}>{`${'  '.repeat(dir.depth)}${dir.depth ? '└ ' : ''}${dir.name}`}</option>
          ))}
        </select>
      </label>
      <label className="field full">
        <span>标签</span>
        <input name="tags" value={form.tags} placeholder="编程，小说，历史…" onChange={(event) => update('tags', event.target.value)} />
      </label>
      <label className="field full">
        <span>书籍描述 / 内容简介</span>
        <textarea name="description" rows={4} value={form.description} onChange={(event) => update('description', event.target.value)} />
      </label>
      <label className="field full">
        <span>阅读笔记</span>
        <textarea name="notes" rows={3} value={form.notes} onChange={(event) => update('notes', event.target.value)} />
      </label>
    </Modal>
  );
}

function ChapterForm({ chapter, index, defaultStartPage = 1, onSave, onClose }) {
  const confirm = React.useContext(ConfirmContext);
  const [error, setError] = useState('');
  const [form, setForm] = useState(() => ({
    name: chapter?.name || `第${index + 1}章`,
    startPage: chapter?.startPage || defaultStartPage,
    endPage: chapter?.endPage || (defaultStartPage + 19),
    currentPage: chapter?.currentPage ?? ((chapter?.startPage || defaultStartPage) - 1),
    notes: chapter?.notes || ''
  }));
  const initialForm = useRef(JSON.stringify(form));

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = () => {
    const startPage = Number(form.startPage);
    const endPage = Number(form.endPage);
    const currentPage = Number(form.currentPage);
    if (!form.name.trim()) {
      setError('请输入章节名称。');
      window.queueMicrotask(() => document.getElementById('chapter-name')?.focus());
      return;
    }
    if (!startPage || !endPage || endPage < startPage) {
      setError('页码范围无效：终止页必须大于或等于起始页。');
      window.queueMicrotask(() => document.getElementById('chapter-start-page')?.focus());
      return;
    }
    onSave({
      name: form.name.trim(),
      startPage,
      endPage,
      currentPage: Math.max(startPage - 1, Math.min(endPage, Number.isFinite(currentPage) ? currentPage : startPage - 1)),
      notes: form.notes
    });
  };
  const requestClose = async () => {
    if (JSON.stringify(form) !== initialForm.current && !await confirm({
      title: '放弃章节修改？',
      message: '尚未保存的页码和章节备注会丢失。',
      confirmLabel: '放弃修改',
      danger: true
    })) return;
    onClose();
  };

  return (
    <Modal
      title={chapter ? '编辑章节' : '添加章节'}
      onClose={requestClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={requestClose}>取消</button>
          <button type="submit" className="primaryButton">保存章节</button>
        </>
      }
    >
      <label className="field full">
        <span>章节名称</span>
        <input id="chapter-name" name="chapterName" value={form.name} aria-invalid={Boolean(error)} aria-describedby={error ? 'chapter-form-error' : undefined} onChange={(event) => { update('name', event.target.value); setError(''); }} autoFocus data-autofocus="true" />
      </label>
      <div className="formGrid">
        <label className="field">
          <span>起始页</span>
          <input id="chapter-start-page" name="chapterStartPage" type="number" min="1" value={form.startPage} aria-invalid={Boolean(error)} aria-describedby={error ? 'chapter-form-error' : undefined} onChange={(event) => { update('startPage', event.target.value); setError(''); }} />
        </label>
        <label className="field">
          <span>终止页</span>
          <input name="chapterEndPage" type="number" min="1" value={form.endPage} aria-invalid={Boolean(error)} aria-describedby={error ? 'chapter-form-error' : undefined} onChange={(event) => { update('endPage', event.target.value); setError(''); }} />
        </label>
        <label className="field">
          <span>已读到页</span>
          <input name="chapterCurrentPage" type="number" value={form.currentPage} onChange={(event) => update('currentPage', event.target.value)} />
        </label>
      </div>
      {error && <p className="fieldError" id="chapter-form-error" role="alert">{error}</p>}
      <label className="field full">
        <span>章节备注</span>
        <textarea name="chapterNotes" rows={4} value={form.notes} placeholder="记录本章摘要、重点或疑问…" onChange={(event) => update('notes', event.target.value)} />
      </label>
    </Modal>
  );
}

function MoveCategoryForm({ state, book, onSave, onClose }) {
  const [directoryId, setDirectoryId] = useState(book.directoryId || UNCATEGORIZED_ID);
  const directories = useMemo(() => flattenDirs(state.directories), [state.directories]);
  return (
    <Modal
      title={`移动《${book.title}》`}
      onClose={onClose}
      onSubmit={() => onSave(directoryId)}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={onClose}>取消</button>
          <button type="submit" className="primaryButton">移动分类</button>
        </>
      }
    >
      <label className="field full">
        <span>目标分类</span>
        <select name="targetDirectoryId" value={directoryId} onChange={(event) => setDirectoryId(event.target.value)} data-autofocus="true">
          {directories.map((directory) => (
            <option key={directory.id} value={directory.id}>
              {`${'  '.repeat(directory.depth)}${directory.depth ? '└ ' : ''}${directory.name}`}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

function CoverUrlForm({ book, onSave, onClose }) {
  const confirm = React.useContext(ConfirmContext);
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const requestClose = async () => {
    if (url.trim() && !submitting && !await confirm({
      title: '放弃封面 URL？',
      message: '尚未导入的地址会被清空。',
      confirmLabel: '放弃',
      danger: true
    })) return;
    onClose();
  };
  const submit = async () => {
    if (!url.trim() || submitting) return;
    try {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      setError('请输入完整的 HTTP 或 HTTPS 图片地址。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSave(url.trim());
    } catch (submitError) {
      setError(submitError.message || '无法下载这个封面，请检查 URL 后重试。');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      title={`从 URL 导入《${book.title}》封面`}
      onClose={requestClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="secondaryButton" onClick={requestClose}>取消</button>
          <button type="submit" className="primaryButton" disabled={submitting || !url.trim()}>
            {submitting ? '正在下载…' : '下载并保存'}
          </button>
        </>
      }
    >
      <label className="field full">
        <span>图片 URL（HTTP / HTTPS）</span>
        <input
          type="url"
          name="coverUrl"
          value={url}
          placeholder="https://example.com/cover.jpg"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'cover-url-error' : 'cover-url-hint'}
          onChange={(event) => { setUrl(event.target.value); setError(''); }}
          data-autofocus="true"
        />
      </label>
      <p className="fieldHint" id="cover-url-hint">图片会下载到该书的文件夹中，之后不再依赖原网址。</p>
      {error && <p className="fieldError" id="cover-url-error" role="alert">{error}</p>}
    </Modal>
  );
}

function SettingsModal({ rootPath, onChooseRoot, onOpenRoot, onClose }) {
  return (
    <Modal
      title="书库设置"
      onClose={onClose}
      footer={<button type="button" className="primaryButton" onClick={onClose}>完成</button>}
    >
      <section className="settingsBlock">
        <div>
          <h3>书库根目录</h3>
          <p>数据库、JSON 导出、自动备份、封面和附件都保存在这里。</p>
        </div>
        <code className="pathBox" title={rootPath}>{rootPath || '正在读取…'}</code>
        <div className="settingsActions">
          <button type="button" className="secondaryButton" onClick={onOpenRoot}><FolderOpen size={16} /> 打开根目录</button>
          <button type="button" className="primaryButton" onClick={onChooseRoot}><FolderPlus size={16} /> 选择其他目录</button>
        </div>
      </section>
      <section className="settingsBlock compact">
        <h3>目录结构</h3>
        <pre>{`book-manager.sqlite\nbackups/\nexports/\nbooks/\n  未分类/\n  分类/书名__ID/\n    book.json\n    cover.*\n    attachments/\n  .trash/`}</pre>
        <p>JSON 用于恢复书目数据；完整迁移请复制整个书库根目录。</p>
      </section>
    </Modal>
  );
}

function BookContextMenu({ menu, book, onClose, onEdit, onMove, onTrash, onRestore, onDeleteForever }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const close = () => onClose();
    const onKeyDown = (event) => {
      const buttons = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        buttons[(index + 1 + buttons.length) % buttons.length].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[(index - 1 + buttons.length) % buttons.length].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        buttons[0].focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        buttons.at(-1).focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKeyDown);
    window.queueMicrotask(() => menuRef.current?.querySelector('[role="menuitem"]')?.focus());
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKeyDown);
      window.queueMicrotask(() => previouslyFocused?.focus?.());
    };
  }, []);

  const run = (action) => (event) => {
    event.stopPropagation();
    onClose();
    action();
  };
  const left = Math.min(menu.x, window.innerWidth - 210);
  const top = Math.min(menu.y, window.innerHeight - (book.deletedAt ? 116 : 160));
  return (
    <div ref={menuRef} className="contextMenu" role="menu" aria-label={`《${book.title}》快捷操作`} style={{ left: Math.max(8, left), top: Math.max(8, top) }} onMouseDown={(event) => event.stopPropagation()}>
      {book.deletedAt ? (
        <>
          <button role="menuitem" onClick={run(onRestore)}><RotateCcw size={15} /> 恢复到原分类</button>
          <button role="menuitem" className="danger" onClick={run(onDeleteForever)}><Trash2 size={15} /> 永久删除</button>
        </>
      ) : (
        <>
          <button role="menuitem" onClick={run(onEdit)}><Edit3 size={15} /> 编辑书籍</button>
          <button role="menuitem" onClick={run(onMove)}><FolderOpen size={15} /> 移动分类</button>
          <button role="menuitem" className="danger" onClick={run(onTrash)}><Trash2 size={15} /> 移入回收站</button>
        </>
      )}
    </div>
  );
}

function BookCard({ book, viewMode, onOpen, onContextMenu }) {
  const progress = calcProgress(book);
  const stars = Array.from({ length: 5 }, (_, index) => index < (book.rating || 0));
  const onKeyDown = (event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onContextMenu({
      preventDefault: () => {},
      clientX: rect.left + Math.min(rect.width, 48),
      clientY: rect.top + Math.min(rect.height, 48)
    }, book.id);
  };

  if (viewMode === 'list') {
    return (
      <button className="bookRow" aria-haspopup="menu" title="打开书籍；右键或 Shift+F10 显示快捷操作" onClick={() => onOpen(book.id)} onKeyDown={onKeyDown} onContextMenu={(event) => onContextMenu(event, book.id)}>
        <Cover book={book} small />
        <span className="bookRowMain">
          <strong>{book.title}</strong>
          <span>{book.author || '未知作者'}{book.publisher ? ` · ${book.publisher}` : ''}</span>
        </span>
        <span className={`statusPill ${progress.status}`}>{STATUS_LABELS[progress.status] || '未开始'}</span>
        <span className="rowProgress">{progress.percentage}%</span>
      </button>
    );
  }

  return (
    <button className="bookCard" aria-haspopup="menu" title="打开书籍；右键或 Shift+F10 显示快捷操作" onClick={() => onOpen(book.id)} onKeyDown={onKeyDown} onContextMenu={(event) => onContextMenu(event, book.id)}>
      <div className="cardCoverWrap">
        <Cover book={book} />
        <span className={`statusPill floating ${progress.status}`}>{STATUS_LABELS[progress.status] || '未开始'}</span>
      </div>
      <div className="bookCardBody">
        <h3>{book.title}</h3>
        <p>{book.author || '未知作者'}</p>
        <div className="stars" aria-label={`${book.rating || 0} 星`}>
          {stars.map((filled, index) => <Star key={index} size={14} fill={filled ? 'currentColor' : 'none'} />)}
        </div>
        <div className="progressLine">
          <span style={{ width: `${progress.percentage}%` }} />
        </div>
        <div className="cardMeta">
          <span>{progress.readPages}/{progress.totalPages || 0} 页</span>
          <span>{progress.percentage}%</span>
        </div>
      </div>
    </button>
  );
}

function Cover({ book, small = false, eager = false }) {
  return (
    <span className={`cover ${small ? 'small' : ''}`}>
      {book.cover ? (
        <img
          src={book.cover}
          alt=""
          width={small ? 48 : 400}
          height={small ? 62 : 500}
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
        />
      ) : <BookOpen size={small ? 20 : 42} aria-hidden="true" />}
    </span>
  );
}

function ChapterPageInput({ chapter, disabled, onCommit }) {
  const [value, setValue] = useState(String(chapter.currentPage));
  useEffect(() => setValue(String(chapter.currentPage)), [chapter.id, chapter.currentPage]);
  const commit = () => {
    const next = Math.max(chapter.startPage - 1, Math.min(chapter.endPage, Number(value)));
    const safeValue = Number.isFinite(next) ? next : chapter.startPage - 1;
    setValue(String(safeValue));
    if (safeValue !== chapter.currentPage) onCommit(safeValue);
  };
  return (
    <input
      type="number"
      name={`chapterCurrentPage-${chapter.id}`}
      aria-label={`${chapter.name}已读到页`}
      min={chapter.startPage - 1}
      max={chapter.endPage}
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
    />
  );
}

function StatsView({ books, readingGoal, onGoalChange, onTagSelect }) {
  const currentYear = new Date().getFullYear();
  const stats = useMemo(() => {
    const finished = books.filter((book) => calcProgress(book).status === 'finished').length;
    const finishedThisYear = books.filter((book) =>
      calcProgress(book).status === 'finished' && String(book.finishedAt || '').startsWith(`${currentYear}-`)
    ).length;
    const finishedWithoutDate = books.filter((book) =>
      calcProgress(book).status === 'finished' && !book.finishedAt
    ).length;
    const reading = books.filter((book) => calcProgress(book).status === 'reading').length;
    const want = books.filter((book) => calcProgress(book).status === 'want').length;
    const totalReadPages = books.reduce((sum, book) => sum + calcProgress(book).readPages, 0);
    const avgProgress = books.length
      ? Math.round(books.reduce((sum, book) => sum + calcProgress(book).percentage, 0) / books.length)
      : 0;
    const rated = books.filter((book) => book.rating > 0);
    const avgRating = rated.length ? (rated.reduce((sum, book) => sum + book.rating, 0) / rated.length).toFixed(1) : '—';
    const tags = new Map();
    const languages = new Map();
    const publishers = new Map();
    for (const book of books) {
      for (const tag of book.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
      const language = book.language || '未指定';
      languages.set(language, (languages.get(language) || 0) + 1);
      if (book.publisher) publishers.set(book.publisher, (publishers.get(book.publisher) || 0) + 1);
    }
    return {
      finished,
      finishedThisYear,
      finishedWithoutDate,
      reading,
      want,
      totalReadPages,
      avgProgress,
      avgRating,
      topTags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      topLanguages: [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      topPublishers: [...publishers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    };
  }, [books, currentYear]);

  const goalPct = Math.min(100, Math.round((stats.finishedThisYear / Math.max(readingGoal, 1)) * 100));

  return (
    <section className="statsView">
      <header className="sectionHeader">
        <div>
          <p className="eyebrow">阅读记录</p>
          <h2>阅读统计</h2>
        </div>
        <label className="goalControl">
          {currentYear} 年目标
          <input
            name="readingGoal"
            type="number"
            min="1"
            max="365"
            value={readingGoal}
            onChange={(event) => onGoalChange(Number(event.target.value) || 1)}
          />
          本
        </label>
      </header>

      <div className="statsGrid">
        <div className="metricBlock"><span>藏书总量</span><strong>{books.length}</strong></div>
        <div className="metricBlock"><span>想读</span><strong>{stats.want}</strong></div>
        <div className="metricBlock"><span>在读</span><strong>{stats.reading}</strong></div>
        <div className="metricBlock"><span>累计已读完</span><strong>{stats.finished}</strong></div>
        <div className="metricBlock"><span>已读页数</span><strong>{stats.totalReadPages.toLocaleString()}</strong></div>
        <div className="metricBlock"><span>平均评分</span><strong>{stats.avgRating}</strong></div>
      </div>

      <div className="statsBands">
        <section className="goalPanel">
          <h3>{currentYear} 年阅读目标</h3>
          <div className="goalNumber">{stats.finishedThisYear}<span>/{readingGoal}</span></div>
          <div className="goalBar"><span style={{ width: `${goalPct}%` }} /></div>
          <p>{goalPct}% 完成，还有 {Math.max(0, readingGoal - stats.finishedThisYear)} 本待完成</p>
          {stats.finishedWithoutDate > 0 && (
            <p className="goalHint">另有 {stats.finishedWithoutDate} 本已读书籍未填写完成日期，未计入年度目标。</p>
          )}
        </section>

        <section className="tagPanel">
          <h3>常用标签</h3>
          {stats.topTags.length ? (
            <div className="tagCloud">
              {stats.topTags.map(([tag, count]) => (
                <button key={tag} onClick={() => onTagSelect(tag)}>{tag} · {count}</button>
              ))}
            </div>
          ) : (
            <p className="muted">暂无标签</p>
          )}
        </section>
      </div>

      <div className="statsInsights">
        <section className="statsPanel">
          <h3>阅读状态分布</h3>
          {[
            ['想读', stats.want, 'want'],
            ['在读', stats.reading, 'reading'],
            ['已读', stats.finished, 'finished']
          ].map(([label, count, status]) => {
            const pct = books.length ? Math.round((count / books.length) * 100) : 0;
            return (
              <div className="distributionRow" key={status}>
                <span>{label}</span>
                <div><i className={status} style={{ width: `${pct}%` }} /></div>
                <strong>{count} · {pct}%</strong>
              </div>
            );
          })}
          <p className="muted">全部书籍平均进度：{stats.avgProgress}%</p>
        </section>
        <section className="statsPanel">
          <h3>语言分布</h3>
          {stats.topLanguages.map(([language, count]) => (
            <div className="rankRow" key={language}><span>{language}</span><strong>{count} 本</strong></div>
          ))}
        </section>
        <section className="statsPanel">
          <h3>出版社 TOP 5</h3>
          {stats.topPublishers.length ? stats.topPublishers.map(([publisher, count]) => (
            <div className="rankRow" key={publisher}><span>{publisher}</span><strong>{count} 本</strong></div>
          )) : <p className="muted">暂无出版社数据</p>}
        </section>
      </div>
    </section>
  );
}

function BookDetail({
  book,
  onPatch,
  onAddChapter,
  onEditChapter,
  onDeleteChapter,
  onPickCover,
  onCoverUrl,
  onRemoveCover,
  onAddAttachment,
  onOpenAttachment,
  onRemoveAttachment,
  onOpenFolder
}) {
  const progress = calcProgress(book);
  const [tagDraft, setTagDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState(book.notes || '');

  const patchBook = (patch) => onPatch(book.id, patch);
  useEffect(() => {
    setNotesDraft(book.notes || '');
  }, [book.id, book.notes]);

  useEffect(() => {
    if (notesDraft === (book.notes || '')) return undefined;
    const timer = window.setTimeout(() => patchBook({ notes: notesDraft }), 700);
    return () => window.clearTimeout(timer);
  }, [notesDraft, book.id, book.notes]);

  const updateChapterPage = (chapterId, value) => {
    const chapters = book.chapters.map((chapter) => {
      if (chapter.id !== chapterId) return chapter;
      const currentPage = Math.max(chapter.startPage - 1, Math.min(chapter.endPage, Number(value)));
      return { ...chapter, currentPage };
    });
    patchBook({ chapters });
  };

  const addTag = (event) => {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;
    const nextTags = new Set(book.tags || []);
    nextTags.add(tag);
    patchBook({ tags: [...nextTags] });
    setTagDraft('');
  };

  const selectStatus = (value) => {
    const today = new Date().toISOString().slice(0, 10);
    const patch = { readingStatus: value };
    if (value === 'reading' && !book.startedAt) patch.startedAt = today;
    if (value === 'finished' && !book.finishedAt) patch.finishedAt = today;
    patchBook(patch);
  };

  return (
    <section className="detailView">
      <div className="detailHero">
        <div className="detailIdentity">
          <div className="detailIdentityHeader">
            <h2>{book.title}</h2>
            {book.subtitle && <p className="subtitle">{book.subtitle}</p>}
            <p className="byline">{book.author || '未知作者'}{book.publisher ? ` · ${book.publisher}` : ''}</p>
          </div>
          <div className="detailCover">
            <Cover book={book} eager />
            {!book.deletedAt && (
              <div className="coverActions">
                <button type="button" className="secondaryButton" onClick={onPickCover}><ImagePlus size={14} /> 本地图片</button>
                <button type="button" className="secondaryButton" onClick={onCoverUrl}><Link size={14} /> 从 URL</button>
                {book.cover && <button type="button" className="textButton dangerText" onClick={onRemoveCover}>移除封面</button>}
              </div>
            )}
          </div>
        </div>
        <div className="detailMeta">
          <dl className="detailFacts">
            <div><dt>ISBN</dt><dd>{book.isbn || '—'}</dd></div>
            <div><dt>原书名</dt><dd>{book.originalTitle || '—'}</dd></div>
            <div><dt>语言</dt><dd>{book.language || '—'}</dd></div>
            <div><dt>出版日期</dt><dd>{book.publishDate || '—'}</dd></div>
            <div><dt>译者</dt><dd>{book.translator || '—'}</dd></div>
            <div><dt>版本 / 版次</dt><dd>{book.edition || '—'}</dd></div>
            <div><dt>载体</dt><dd>{book.format || '—'}</dd></div>
            <div><dt>系列</dt><dd>{book.series ? `${book.series}${book.seriesIndex ? ` · ${book.seriesIndex}` : ''}` : '—'}</dd></div>
            <div><dt>总页数</dt><dd>{book.pageCount ? `${book.pageCount} 页` : '—'}</dd></div>
            <div><dt>章节</dt><dd>{book.chapters.length}</dd></div>
            <div><dt>开始阅读</dt><dd>{book.startedAt || '—'}</dd></div>
            <div><dt>完成阅读</dt><dd>{book.finishedAt || '—'}</dd></div>
          </dl>
          {!book.deletedAt && (
            <div className="readingControls">
              <div className="ratingEdit">
                {Array.from({ length: 5 }, (_, index) => (
                  <button type="button" key={index} aria-label={`${index + 1} 星评分`} onClick={() => patchBook({ rating: book.rating === index + 1 ? 0 : index + 1 })}>
                    <Star size={20} fill={index < (book.rating || 0) ? 'currentColor' : 'none'} />
                  </button>
                ))}
              </div>
              <div className="statusGroup">
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <button
                    key={value}
                    className={book.readingStatus === value ? 'selected' : ''}
                    onClick={() => selectStatus(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="detailProgress">
            <div><span style={{ width: `${progress.percentage}%` }} /></div>
            <p>章节自动计算：已读 {progress.readPages} / {progress.totalPages} 页 · {progress.percentage}%</p>
          </div>
        </div>
      </div>

      {book.description && (
        <section className="detailSection descriptionSection">
          <header><h3>书籍描述</h3></header>
          <p>{book.description}</p>
        </section>
      )}

      <section className="detailSection">
        <header>
          <h3>标签</h3>
          {!book.deletedAt && <form className="tagAdder" onSubmit={addTag}>
            <input name="tagDraft" value={tagDraft} maxLength={100} placeholder="新标签…" aria-label="新标签" autoComplete="off" onChange={(event) => setTagDraft(event.target.value)} />
            <button className="textButton" type="submit">添加</button>
          </form>}
        </header>
        <div className="tags">
          {(book.tags || []).length ? book.tags.map((tag) => (
            <button key={tag} disabled={Boolean(book.deletedAt)} onClick={() => patchBook({ tags: book.tags.filter((item) => item !== tag) })}>
              {tag}{!book.deletedAt && <X size={13} />}
            </button>
          )) : <span className="muted">暂无标签</span>}
        </div>
      </section>

      <section className="detailSection chapterSection">
        <header>
          <h3>章节进度</h3>
          <div className="sectionActions">
            <span className="muted chapterCount">{book.chapters.length} 章</span>
            {!book.deletedAt && <button type="button" className="primaryButton" onClick={onAddChapter}><Plus size={16} /> 添加章节</button>}
          </div>
        </header>
        {book.chapters.length ? (
          <div className="chapterTableWrap">
            <table className="chapterTable">
              <caption className="srOnly">《{book.title}》章节阅读进度</caption>
              <colgroup><col /><col /><col /><col /><col /></colgroup>
              <thead>
                <tr className="chapterHead">
                  <th scope="col">章节</th><th scope="col">页码</th><th scope="col">已读到</th><th scope="col">进度</th><th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {book.chapters.map((chapter) => {
                  const pages = chapter.endPage - chapter.startPage + 1;
                  const read = Math.max(0, chapter.currentPage - chapter.startPage + 1);
                  const pct = pages > 0 ? Math.round((read / pages) * 100) : 0;
                  return (
                    <tr className="chapterRow" key={chapter.id}>
                      <th scope="row" className="chapterName">
                        <strong>{chapter.name}</strong>
                        {chapter.notes && <small title={chapter.notes}>{chapter.notes}</small>}
                      </th>
                      <td>{chapter.startPage}-{chapter.endPage}</td>
                      <td>
                        <ChapterPageInput
                          chapter={chapter}
                          disabled={Boolean(book.deletedAt)}
                          onCommit={(value) => updateChapterPage(chapter.id, value)}
                        />
                      </td>
                      <td><span className="miniProgress" aria-label={`${chapter.name}进度 ${pct}%`}><i style={{ width: `${pct}%` }} />{pct}%</span></td>
                      <td>
                        <span className="chapterButtons">
                          {!book.deletedAt && <>
                            <button type="button" onClick={() => onEditChapter(chapter)} aria-label={`编辑 ${chapter.name}`}><Edit3 size={14} /></button>
                            <button type="button" onClick={() => onDeleteChapter(chapter.id)} aria-label={`删除 ${chapter.name}`}><Trash2 size={14} /></button>
                          </>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="emptyInline">还没有章节。添加章节后就能跟踪每章页码进度。</div>
        )}
      </section>

      <section className="detailSection attachmentSection">
        <header>
          <div>
            <h3>附件</h3>
            <span className="muted">电子书、文档或与本书相关的文件</span>
          </div>
          <div className="sectionActions">
            <button type="button" className="secondaryButton" onClick={onOpenFolder}><FolderOpen size={15} /> 打开书籍文件夹</button>
            {!book.deletedAt && <button type="button" className="primaryButton" onClick={onAddAttachment}><Paperclip size={15} /> 添加附件</button>}
          </div>
        </header>
        {(book.attachments || []).length ? (
          <div className="attachmentList">
            {book.attachments.map((attachment) => (
              <div className={`attachmentRow ${attachment.missing ? 'missing' : ''}`} key={attachment.id}>
                <File size={18} />
                <div>
                  <strong>{attachment.name}</strong>
                  <span>{formatFileSize(attachment.size)}{attachment.missing ? ' · 文件缺失' : ''}</span>
                </div>
                <button type="button" className="secondaryButton" disabled={attachment.missing} onClick={() => onOpenAttachment(attachment.id)}><ExternalLink size={14} /> 打开</button>
                {!book.deletedAt && <button type="button" className="iconButton dangerText" aria-label={`删除附件 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment)}><Trash2 size={15} /></button>}
              </div>
            ))}
          </div>
        ) : <div className="emptyInline">还没有附件。添加后文件会复制进本书的 attachments 目录。</div>}
      </section>

      <section className="detailSection">
        <header><h3>阅读笔记</h3></header>
        <textarea
          className="notesArea"
          name="readingNotes"
          aria-label="阅读笔记"
          value={notesDraft}
          disabled={Boolean(book.deletedAt)}
          placeholder="记录读书摘记、想法或者待查资料..."
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={() => notesDraft !== (book.notes || '') && patchBook({ notes: notesDraft })}
        />
      </section>
    </section>
  );
}

function App() {
  const dbApi = window.bookManagerDb;
  const confirm = React.useContext(ConfirmContext);
  const [state, setState] = useState(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [dbPath, setDbPath] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [theme, setTheme] = useState('dark');
  const [readingGoal, setReadingGoal] = useState(12);
  const [activeView, setActiveView] = useState('books');
  const [selectedDirId, setSelectedDirId] = useState(null);
  const [selectedBookId, setSelectedBookId] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('added-desc');
  const [viewMode, setViewMode] = useState('grid');
  const [visibleLimit, setVisibleLimit] = useState(BOOK_PAGE_SIZE);
  const [modal, setModal] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveError, setSaveError] = useState('');
  const [operationStatus, setOperationStatus] = useState('');
  const [toasts, toast] = useToast();
  const latestStateRef = useRef(EMPTY_STATE);
  const saveChainRef = useRef(Promise.resolve());

  const applyLibraryPayload = (payload, includeSettings = true) => {
    const normalized = normalizeImport(payload?.state || EMPTY_STATE);
    latestStateRef.current = normalized;
    setState(normalized);
    setDbPath(payload?.dbPath || '');
    setRootPath(payload?.rootPath || '');
    if (includeSettings) {
      setTheme(payload?.theme || 'dark');
      setReadingGoal(Number(payload?.readingGoal) || 12);
    }
    return normalized;
  };

  useEffect(() => {
    async function load() {
      try {
        if (!dbApi) throw new Error('Electron preload API is unavailable.');
        const payload = await dbApi.load();
        applyLibraryPayload(payload);
      } catch (error) {
        console.error(error);
        setLoadError('无法读取书库数据库。为避免覆盖原数据，应用已停止进入编辑状态。');
        toast('数据库加载失败，请重启应用或检查数据库文件', 'error');
      } finally {
        setLoaded(true);
      }
    }
    load();
  }, [dbApi]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'dark' ? '#181714' : '#f2eee7';
  }, [theme]);

  const persistState = (next, message) => {
    latestStateRef.current = next;
    setSaveStatus('saving');
    setSaveError('');
    const task = saveChainRef.current
      .catch(() => undefined)
      .then(() => {
        if (!dbApi) throw new Error('Electron preload API is unavailable.');
        return dbApi.saveState(next);
      });
    saveChainRef.current = task;
    task.then((payload) => {
      if (latestStateRef.current === next) {
        if (payload?.state) applyLibraryPayload(payload, false);
        setSaveStatus('saved');
      }
      if (message) toast(message, 'success');
    }).catch((error) => {
      console.error(error);
      if (latestStateRef.current === next) {
        setSaveStatus('error');
        setSaveError('更改尚未写入磁盘');
      }
      toast('保存失败，更改仍保留在当前窗口，请点击重试', 'error');
    });
    return task;
  };

  const saveState = (producer, message) => {
    const current = clone(latestStateRef.current);
    const next = typeof producer === 'function' ? producer(current) : producer;
    latestStateRef.current = next;
    setState(next);
    return persistState(next, message);
  };

  const filteredBooks = useMemo(() => {
    let books = state.books.filter((book) => activeView === 'trash' ? Boolean(book.deletedAt) : !book.deletedAt);
    if (activeView !== 'trash' && selectedDirId) {
      const ids = descendantDirIds(state.directories, selectedDirId);
      books = books.filter((book) => ids.includes(book.directoryId));
    }
    if (activeView !== 'trash' && filter !== 'all') books = books.filter((book) => calcProgress(book).status === filter);
    const q = search.trim().toLowerCase();
    if (q) {
      books = books.filter((book) =>
        [
          book.title, book.subtitle, book.originalTitle, book.author, book.translator,
          book.isbn, book.publisher, book.series, book.description, ...(book.tags || [])
        ]
          .filter(Boolean)
          .some((item) => String(item).toLowerCase().includes(q))
      );
    }

    books.sort((a, b) => {
      switch (sort) {
        case 'added-asc': return (a.createdAt || 0) - (b.createdAt || 0);
        case 'title': return a.title.localeCompare(b.title, 'zh');
        case 'author': return (a.author || '').localeCompare(b.author || '', 'zh');
        case 'progress-desc': return calcProgress(b).percentage - calcProgress(a).percentage;
        case 'progress-asc': return calcProgress(a).percentage - calcProgress(b).percentage;
        case 'rating-desc': return (b.rating || 0) - (a.rating || 0);
        case 'added-desc':
        default: return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
    return books;
  }, [state, activeView, selectedDirId, filter, search, sort]);

  useEffect(() => {
    setVisibleLimit(BOOK_PAGE_SIZE);
  }, [activeView, selectedDirId, filter, search, sort]);

  const visibleBooks = filteredBooks.slice(0, visibleLimit);

  const selectedBook = state.books.find((book) => book.id === selectedBookId);
  const selectedBookPath = selectedBook?.directoryId ? findDir(state.directories, selectedBook.directoryId)?.path || [] : [];
  const currentPath = selectedDirId ? findDir(state.directories, selectedDirId)?.path || [] : [];
  const activeBooks = state.books.filter((book) => !book.deletedAt);
  const trashedBooks = state.books.filter((book) => Boolean(book.deletedAt));
  const regularDirectories = state.directories.filter((directory) => !directory.system);
  const systemDirectories = state.directories.filter((directory) => directory.system);
  const toggleDirectory = (id) => setExpanded((items) => {
    const next = new Set(items);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectDirectory = (id) => {
    setSelectedDirId(id);
    setSelectedBookId(null);
    setActiveView('books');
  };
  const readingCount = activeBooks.filter((book) => calcProgress(book).status === 'reading').length;
  const finishedCount = activeBooks.filter((book) => calcProgress(book).status === 'finished').length;
  const readPages = activeBooks.reduce((sum, book) => sum + calcProgress(book).readPages, 0);

  const addDirectory = (parentId = null) => {
    const info = parentId ? findDir(state.directories, parentId) : null;
    if (info?.node.system) {
      toast('“未分类”是系统分类，不能创建子分类', 'error');
      return;
    }
    if (info && info.depth >= MAX_DIR_DEPTH - 1) {
      toast(`最多支持 ${MAX_DIR_DEPTH} 级目录`, 'error');
      return;
    }
    setModal({ type: 'directory', parentId });
  };

  const saveDirectory = (name, parentId = null, dirId = null) => {
    const parentInfo = parentId ? findDir(state.directories, parentId) : null;
    const siblings = parentInfo ? parentInfo.node.children || [] : state.directories;
    if (siblings.some((directory) => directory.id !== dirId
      && directory.name.trim().toLocaleLowerCase('zh-CN') === name.trim().toLocaleLowerCase('zh-CN'))) {
      toast('同一层级已经存在同名分类，请换一个名称', 'error');
      return;
    }
    saveState((draft) => {
      if (dirId) {
        const target = findDir(draft.directories, dirId);
        if (target) target.node.name = name;
        return draft;
      }
      const dir = { id: makeId('d', draft.nextDirId), name, children: [] };
      draft.nextDirId += 1;
      if (parentId) {
        const parent = findDir(draft.directories, parentId);
        parent.node.children = [...(parent.node.children || []), dir];
      } else {
        draft.directories.push(dir);
      }
      return draft;
    }, dirId ? '目录已重命名' : '目录已添加');
    if (parentId) setExpanded((items) => new Set([...items, parentId]));
    setModal(null);
  };

  const renameDirectory = (dirId) => {
    const current = findDir(state.directories, dirId);
    if (!current || current.node.system) return;
    setModal({ type: 'directory', dirId, directory: current.node, parentId: current.parent?.id || null });
  };

  const deleteDirectory = async (dirId) => {
    const info = findDir(state.directories, dirId);
    if (!info || info.node.system) return;
    const bookCount = countBooksInDir(state, dirId);
    if (!await confirm({
      title: `删除分类“${info.node.name}”？`,
      message: bookCount ? `该分类及子分类中的 ${bookCount} 本书会移动到“未分类”，书籍不会被删除。` : '该分类当前没有书籍。',
      confirmLabel: '删除分类',
      danger: true
    })) return;
    try {
      await saveChainRef.current;
      await dbApi.createRecoveryBackup('before-delete-directory');
    } catch (error) {
      console.error(error);
      toast('无法创建删除前备份，目录未删除', 'error');
      return;
    }
    const ids = descendantDirIds(state.directories, dirId);
    saveState((draft) => {
      const target = findDir(draft.directories, dirId);
      target.siblings.splice(target.index, 1);
      draft.books = draft.books.map((book) => ids.includes(book.directoryId) ? { ...book, directoryId: UNCATEGORIZED_ID } : book);
      return draft;
    }, '目录已删除');
    if (ids.includes(selectedDirId)) setSelectedDirId(null);
  };

  const saveBook = (form, editId = null) => {
    saveState((draft) => {
      if (editId) {
        draft.books = draft.books.map((book) => book.id === editId ? { ...book, ...form } : book);
      } else {
        draft.books.push({
          id: makeId('b', draft.nextBookId),
          ...form,
          rating: 0,
          cover: null,
          coverFile: '',
          chapters: [],
          attachments: [],
          deletedAt: null,
          createdAt: Date.now()
        });
        draft.nextBookId += 1;
      }
      return draft;
    }, editId ? '书籍已更新' : '书籍已添加');
    setModal(null);
  };

  const patchBook = (bookId, patch) => {
    saveState((draft) => {
      draft.books = draft.books.map((book) => book.id === bookId ? { ...book, ...patch } : book);
      return draft;
    });
  };

  const moveBookToTrash = async (bookId) => {
    const book = state.books.find((item) => item.id === bookId);
    if (!book || book.deletedAt || !await confirm({
      title: `将《${book.title}》移入回收站？`,
      message: '书籍、封面和附件会保留，可以随时从回收站恢复。',
      confirmLabel: '移入回收站',
      danger: true
    })) return;
    saveState((draft) => {
      draft.books = draft.books.map((item) => item.id === bookId ? { ...item, deletedAt: Date.now() } : item);
      return draft;
    }, '书籍已移入回收站');
    setSelectedBookId(null);
  };

  const restoreBook = (bookId) => {
    saveState((draft) => {
      draft.books = draft.books.map((item) => item.id === bookId ? { ...item, deletedAt: null } : item);
      return draft;
    }, '书籍已恢复');
    setSelectedBookId(null);
  };

  const permanentlyDeleteBook = async (bookId) => {
    const book = state.books.find((item) => item.id === bookId);
    if (!book?.deletedAt || !await confirm({
      title: `永久删除《${book.title}》？`,
      message: `这会永久删除书籍记录、封面和 ${(book.attachments || []).length} 个附件，操作无法撤销。`,
      confirmLabel: '永久删除',
      danger: true
    })) return;
    try {
      await saveChainRef.current;
      const payload = await dbApi.permanentlyDeleteBook(bookId);
      applyLibraryPayload(payload, false);
      setSelectedBookId(null);
      toast('书籍已永久删除', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '永久删除失败', 'error');
    }
  };

  const moveBookCategory = (bookId, directoryId) => {
    patchBook(bookId, { directoryId: directoryId || UNCATEGORIZED_ID });
    setModal(null);
    toast('书籍分类已更新', 'success');
  };

  const saveChapter = (bookId, chapter, editChapterId = null) => {
    saveState((draft) => {
      draft.books = draft.books.map((book) => {
        if (book.id !== bookId) return book;
        if (editChapterId) {
          return { ...book, chapters: book.chapters.map((item) => item.id === editChapterId ? { ...item, ...chapter } : item) };
        }
        return { ...book, chapters: [...book.chapters, { id: `ch${Date.now()}`, ...chapter }] };
      });
      return draft;
    }, editChapterId ? '章节已更新' : '章节已添加');
    setModal(null);
  };

  const deleteChapter = async (bookId, chapterId) => {
    const book = state.books.find((item) => item.id === bookId);
    const chapter = book?.chapters.find((item) => item.id === chapterId);
    if (!chapter || !await confirm({
      title: `删除章节“${chapter.name}”？`,
      message: '该章节的页码进度和章节备注会一并删除。',
      confirmLabel: '删除章节',
      danger: true
    })) return;
    try {
      await saveChainRef.current;
      await dbApi.createRecoveryBackup('before-delete-chapter');
    } catch (error) {
      console.error(error);
      toast('无法创建删除前备份，章节未删除', 'error');
      return;
    }
    saveState((draft) => {
      draft.books = draft.books.map((book) => book.id === bookId
        ? { ...book, chapters: book.chapters.filter((chapter) => chapter.id !== chapterId) }
        : book);
      return draft;
    }, '章节已删除');
  };

  const pickCover = async (bookId) => {
    setOperationStatus('正在处理封面…');
    try {
      await saveChainRef.current;
      const result = await dbApi.pickCover(bookId);
      if (!result || result.canceled) return;
      applyLibraryPayload(result.payload, false);
      toast('封面已保存到书籍文件夹', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '封面处理失败，请换一张图片重试', 'error');
    } finally {
      setOperationStatus('');
    }
  };

  const setCoverFromUrl = async (bookId, url) => {
    try {
      await saveChainRef.current;
      const payload = await dbApi.setCoverUrl(bookId, url);
      applyLibraryPayload(payload, false);
      setModal(null);
      toast('网络封面已下载并保存到本地', 'success');
    } catch (error) {
      console.error(error);
      throw error;
    }
  };

  const removeCover = async (bookId) => {
    if (!await confirm({
      title: '移除本地封面？',
      message: '封面文件会从这本书的文件夹中删除。',
      confirmLabel: '移除封面',
      danger: true
    })) return;
    try {
      await saveChainRef.current;
      applyLibraryPayload(await dbApi.removeCover(bookId), false);
      toast('封面已移除', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '移除封面失败', 'error');
    }
  };

  const addAttachments = async (bookId) => {
    setOperationStatus('正在复制附件…');
    try {
      await saveChainRef.current;
      const result = await dbApi.addAttachments(bookId);
      if (!result || result.canceled) return;
      applyLibraryPayload(result.payload, false);
      toast('附件已复制到书籍文件夹', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '添加附件失败', 'error');
    } finally {
      setOperationStatus('');
    }
  };

  const openAttachment = async (bookId, attachmentId) => {
    try {
      await dbApi.openAttachment(bookId, attachmentId);
    } catch (error) {
      console.error(error);
      toast(error.message || '无法打开附件；请确认文件存在，并已在 Windows 中关联可用程序', 'error');
    }
  };

  const removeAttachment = async (bookId, attachment) => {
    if (!await confirm({
      title: `删除附件“${attachment.name}”？`,
      message: '附件文件会从书库中永久删除，原始外部文件不受影响。',
      confirmLabel: '删除附件',
      danger: true
    })) return;
    try {
      await saveChainRef.current;
      applyLibraryPayload(await dbApi.removeAttachment(bookId, attachment.id), false);
      toast('附件已删除', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '删除附件失败', 'error');
    }
  };

  const openBookFolder = async (bookId) => {
    try {
      await dbApi.openBookFolder(bookId);
    } catch (error) {
      console.error(error);
      toast(error.message || '无法打开书籍文件夹，请检查书库根目录权限', 'error');
    }
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    dbApi?.setSetting('theme', next).catch(() => toast('主题保存失败', 'error'));
  };

  const updateGoal = (value) => {
    const next = Math.max(1, Math.min(365, value));
    setReadingGoal(next);
    dbApi?.setSetting('readingGoal', String(next)).catch(() => toast('年度目标保存失败', 'error'));
  };

  const exportData = async () => {
    setOperationStatus('正在导出 JSON…');
    try {
      const result = await dbApi?.exportData({ state, settings: { theme, readingGoal } });
      if (result && !result.canceled) toast(`JSON 已导出到 ${result.filePath}`, 'success');
    } catch (error) {
      console.error(error);
      toast('导出失败，请检查目标目录是否可写后重试', 'error');
    } finally {
      setOperationStatus('');
    }
  };

  const importData = async () => {
    try {
      const result = await dbApi?.pickImportJson();
      if (!result || result.canceled) return;
      const next = normalizeImport(result.data.state);
      if (!await confirm({
        title: '导入 JSON 书库？',
        message: `将导入 ${next.books.length} 本书和 ${flattenDirs(next.directories).filter((item) => !item.system).length} 个自定义分类。当前书目会被覆盖，操作前会自动备份数据库；附件文件不会嵌入 JSON。`,
        confirmLabel: '确认导入',
        danger: true
      })) return;
      try {
        await saveChainRef.current;
      } catch {
        toast('当前更改尚未成功写入磁盘；请先点击“保存失败 · 重试”，再执行导入', 'error');
        return;
      }
      setOperationStatus('正在导入书库…');
      const payload = await dbApi.importBackup(result.data);
      applyLibraryPayload(payload);
      setSaveStatus('saved');
      saveChainRef.current = Promise.resolve();
      setSelectedBookId(null);
      setSelectedDirId(null);
      toast('数据和设置已安全导入', 'success');
    } catch (error) {
      console.error(error);
      toast('导入失败，请选择由本软件导出的有效 JSON 备份后重试', 'error');
    } finally {
      setOperationStatus('');
    }
  };

  const showDbLocation = async () => {
    try {
      const path = await dbApi?.showLocation();
      if (path) toast('已打开书库根目录', 'success');
    } catch (error) {
      console.error(error);
      toast('无法打开书库根目录，请检查目录是否存在及访问权限', 'error');
    }
  };

  const chooseLibraryRoot = async () => {
    try {
      const choice = await dbApi.chooseLibraryRoot();
      if (!choice || choice.canceled) return;
      let mode;
      if (choice.hasLibrary) {
        if (!await confirm({
          title: '打开现有书库？',
          message: `应用将切换到“${choice.path}”。当前书库不会被删除，之后仍可重新选择。`,
          confirmLabel: '打开书库'
        })) return;
        mode = 'open';
      } else {
        if (!choice.isEmpty) {
          toast('请选择空目录，或选择已经包含 book-manager.sqlite 的书库目录', 'error');
          return;
        }
        if (!await confirm({
          title: '迁移当前书库？',
          message: `数据库、备份、封面和附件会复制到“${choice.path}”，完成后应用改用新目录。`,
          confirmLabel: '迁移并切换'
        })) return;
        mode = 'migrate';
      }
      await saveChainRef.current;
      setOperationStatus(mode === 'open' ? '正在打开书库…' : '正在迁移书库…');
      const payload = await dbApi.switchLibraryRoot(choice.path, mode);
      applyLibraryPayload(payload);
      setSelectedBookId(null);
      setSelectedDirId(null);
      setActiveView('books');
      setModal(null);
      saveChainRef.current = Promise.resolve();
      toast(mode === 'open' ? '已打开现有书库' : '书库已迁移到新目录', 'success');
    } catch (error) {
      console.error(error);
      toast(error.message || '切换书库根目录失败', 'error');
    } finally {
      setOperationStatus('');
    }
  };

  if (!loaded) {
    return (
      <main className="loadingScreen">
        <Database size={30} />
        <span>正在连接书库数据库…</span>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="errorScreen" role="alert">
        <Database size={34} />
        <h1>书库加载失败</h1>
        <p>{loadError}</p>
        <button className="primaryButton" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }

  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <header className="brand">
          <div className="brandMark"><BookOpen size={21} /></div>
          <div>
            <h1>藏书阁</h1>
            <p>SQLite 桌面书库</p>
          </div>
        </header>

        <nav className="navSwitch" aria-label="主要视图">
          <button aria-current={activeView === 'books' ? 'page' : undefined} className={activeView === 'books' ? 'active' : ''} onClick={() => { setActiveView('books'); setSelectedBookId(null); }}><BookOpen size={16} /> 书架</button>
          <button aria-current={activeView === 'stats' ? 'page' : undefined} className={activeView === 'stats' ? 'active' : ''} onClick={() => { setActiveView('stats'); setSelectedBookId(null); }}><BarChart3 size={16} /> 统计</button>
        </nav>

        <section className="directoryPanel" aria-label="书籍目录">
          <header className="directoryHeader">
            <span><FolderOpen size={15} /> 目录</span>
            <button type="button" className="directoryAddButton" onClick={() => addDirectory(null)}>
              <FolderPlus size={14} /> 新建目录
            </button>
          </header>
          <div className="treePane">
            <button
              type="button"
              aria-current={activeView === 'books' && !selectedDirId ? 'page' : undefined}
              className={`treeRootNode ${activeView === 'books' && !selectedDirId ? 'active' : ''}`}
              onClick={() => { setActiveView('books'); setSelectedDirId(null); setSelectedBookId(null); }}
            >
              <Home size={16} />
              <span className="treeName">全部书籍</span>
              <span className="treeCount">{activeBooks.length}</span>
            </button>
            <DirectoryTree
              state={state}
              directories={regularDirectories}
              selectedDirId={activeView === 'books' ? selectedDirId : null}
              expanded={expanded}
              onToggle={toggleDirectory}
              onSelect={selectDirectory}
              onAdd={addDirectory}
              onRename={renameDirectory}
              onDelete={deleteDirectory}
            />
          </div>
        </section>

        <div className="systemDirectoryShelf" aria-label="系统分类">
          <DirectoryTree
            state={state}
            directories={systemDirectories}
            selectedDirId={activeView === 'books' ? selectedDirId : null}
            expanded={expanded}
            onToggle={toggleDirectory}
            onSelect={selectDirectory}
            onAdd={addDirectory}
            onRename={renameDirectory}
            onDelete={deleteDirectory}
          />
        </div>

        <footer className="sidebarFooter">
          <div className="footerRow">
            <button
              type="button"
              aria-current={activeView === 'trash' ? 'page' : undefined}
              className={`recycleFooterButton ${activeView === 'trash' ? 'active' : ''}`}
              onClick={() => { setActiveView('trash'); setFilter('all'); setSelectedDirId(null); setSelectedBookId(null); }}
            >
              <Trash2 size={15} /> 回收站 <span>{trashedBooks.length}</span>
            </button>
            <button type="button" onClick={() => setModal({ type: 'settings' })}><Settings size={15} /> 设置</button>
          </div>
          <div className="footerRow">
            <button onClick={exportData}><Download size={15} /> 导出</button>
            <button onClick={importData}><FileUp size={15} /> 导入</button>
          </div>
          <button type="button" title={rootPath || dbPath} onClick={showDbLocation}><Database size={15} /> 打开书库根目录</button>
        </footer>
      </aside>

      <main className="workspace" id="main-content" tabIndex="-1">
        <header className="topbar">
          <div className={`breadcrumbs ${selectedBook ? 'bookBreadcrumbs' : ''}`}>
            {selectedBook ? (
              <>
                <button type="button" className="backButton" onClick={() => setSelectedBookId(null)}>
                  <ChevronLeft size={16} />
                  返回列表
                </button>
                <Home size={15} />
                <span>全部书籍</span>
                {selectedBookPath.map((dir) => <React.Fragment key={dir.id}><span>/</span><span>{dir.name}</span></React.Fragment>)}
              </>
            ) : (
              <>
                {activeView === 'trash' ? <Trash2 size={15} /> : <Home size={15} />}
                <span>{activeView === 'trash' ? '回收站' : activeView === 'stats' ? '阅读统计' : '全部书籍'}</span>
                {activeView === 'books' && currentPath.map((dir) => <React.Fragment key={dir.id}><span>/</span><span>{dir.name}</span></React.Fragment>)}
              </>
            )}
          </div>
          <div className="topActions">
            {(activeView === 'books' || activeView === 'trash') && !selectedBook && (
              <label className="searchBox">
                <Search size={16} />
                <span className="srOnly">搜索书籍</span>
                <input name="bookSearch" value={search} placeholder="搜索书名、作者、译者、ISBN、标签…" autoComplete="off" onChange={(event) => setSearch(event.target.value)} />
              </label>
            )}
            {operationStatus && <span className="saveIndicator saving" role="status">{operationStatus}</span>}
            {!operationStatus && saveStatus === 'saving' && <span className="saveIndicator saving" role="status">正在保存…</span>}
            {!operationStatus && saveStatus === 'error' && (
              <button
                className="saveIndicator error"
                title={saveError}
                onClick={() => persistState(latestStateRef.current, '数据已重新保存')}
              >
                保存失败 · 重试
              </button>
            )}
            {selectedBook && (selectedBook.deletedAt ? (
              <>
                <button type="button" className="primaryButton" onClick={() => restoreBook(selectedBook.id)}><RotateCcw size={16} /> 恢复书籍</button>
                <button type="button" className="dangerButton" onClick={() => permanentlyDeleteBook(selectedBook.id)}><Trash2 size={16} /> 永久删除</button>
              </>
            ) : (
              <>
                <button type="button" className="secondaryButton" onClick={() => setModal({ type: 'book', book: selectedBook })}><Edit3 size={16} /> 编辑</button>
                <button type="button" className="dangerButton" onClick={() => moveBookToTrash(selectedBook.id)}><Trash2 size={16} /> 移入回收站</button>
              </>
            ))}
            <button className="iconButton" onClick={toggleTheme} aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {activeView === 'books' && !selectedBook && filteredBooks.length > 0 && (
              <button className="primaryButton" onClick={() => setModal({ type: 'book' })}><Plus size={17} /> 添加书籍</button>
            )}
          </div>
        </header>

        {activeView === 'stats' ? (
          <StatsView
            books={activeBooks}
            readingGoal={readingGoal}
            onGoalChange={updateGoal}
            onTagSelect={(tag) => { setSearch(tag); setFilter('all'); setSelectedDirId(null); setActiveView('books'); }}
          />
        ) : selectedBook ? (
          <BookDetail
            book={selectedBook}
            onPatch={patchBook}
            onAddChapter={() => setModal({ type: 'chapter', bookId: selectedBook.id, index: selectedBook.chapters.length })}
            onEditChapter={(chapter) => setModal({ type: 'chapter', bookId: selectedBook.id, chapter, index: selectedBook.chapters.indexOf(chapter) })}
            onDeleteChapter={(chapterId) => deleteChapter(selectedBook.id, chapterId)}
            onPickCover={() => pickCover(selectedBook.id)}
            onCoverUrl={() => setModal({ type: 'cover-url', book: selectedBook })}
            onRemoveCover={() => removeCover(selectedBook.id)}
            onAddAttachment={() => addAttachments(selectedBook.id)}
            onOpenAttachment={(attachmentId) => openAttachment(selectedBook.id, attachmentId)}
            onRemoveAttachment={(attachment) => removeAttachment(selectedBook.id, attachment)}
            onOpenFolder={() => openBookFolder(selectedBook.id)}
          />
        ) : (
          <section className="booksView">
            {activeView === 'trash' ? (
              <div className="trashHeader">
                <div><Trash2 size={21} /><div><h2>回收站</h2><p>这里的书籍仍保留封面和附件；只有永久删除才会清理文件。</p></div></div>
                <span>{trashedBooks.length} 本</span>
              </div>
            ) : (
              <div className="summaryStrip">
                <div><strong>{activeBooks.length}</strong><span>藏书总量</span></div>
                <div><strong>{readingCount}</strong><span>正在阅读</span></div>
                <div><strong>{finishedCount}</strong><span>已读完</span></div>
                <div><strong>{readPages.toLocaleString()}</strong><span>已读页数</span></div>
              </div>
            )}

            <div className="toolbar">
              <div className="filterGroup">
                {(activeView === 'trash' ? ['all'] : ['all', 'want', 'reading', 'finished']).map((item) => (
                  <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
                    {item === 'all' ? '全部' : STATUS_LABELS[item]}
                  </button>
                ))}
              </div>
              <div className="toolbarRight">
                <select name="bookSort" aria-label="书籍排序方式" value={sort} onChange={(event) => setSort(event.target.value)}>
                  {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <button className={viewMode === 'grid' ? 'iconButton active' : 'iconButton'} onClick={() => setViewMode('grid')} aria-label="网格视图"><Grid2X2 size={17} /></button>
                <button className={viewMode === 'list' ? 'iconButton active' : 'iconButton'} onClick={() => setViewMode('list')} aria-label="列表视图"><LayoutList size={17} /></button>
              </div>
            </div>

            {filteredBooks.length ? (
              <div className={viewMode === 'grid' ? 'bookGrid' : 'bookList'}>
                {visibleBooks.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    viewMode={viewMode}
                    onOpen={setSelectedBookId}
                    onContextMenu={(event, bookId) => {
                      event.preventDefault();
                      setContextMenu({ bookId, x: event.clientX, y: event.clientY });
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="emptyState">
                <BookOpen size={42} />
                <h2>{activeView === 'trash' ? '回收站是空的' : search || filter !== 'all' ? '没有匹配的书籍' : selectedDirId ? '这个目录还没有书' : '这里还没有书'}</h2>
                <p>{activeView === 'trash' ? '从书架删除的书会先出现在这里。' : search || filter !== 'all' ? '可以清除搜索和状态筛选后重试。' : '添加第一本书，目录、章节和进度都会保存到书库根目录。'}</p>
                {search || filter !== 'all' ? (
                  <button className="secondaryButton" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button>
                ) : activeView !== 'trash' && (
                  <button className="primaryButton" onClick={() => setModal({ type: 'book' })}><Plus size={17} /> 添加书籍</button>
                )}
              </div>
            )}
            {filteredBooks.length > visibleBooks.length && (
              <div className="loadMore">
                <button type="button" className="secondaryButton" onClick={() => setVisibleLimit((value) => value + BOOK_PAGE_SIZE)}>
                  显示更多（剩余 {filteredBooks.length - visibleBooks.length} 本）
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      {modal?.type === 'book' && (
        <BookForm
          state={state}
          book={modal.book}
          defaultDirId={selectedDirId}
          onClose={() => setModal(null)}
          onSave={(form) => saveBook(form, modal.book?.id)}
        />
      )}
      {modal?.type === 'directory' && (
        <DirectoryForm
          directory={modal.directory}
          parentName={modal.parentId ? findDir(state.directories, modal.parentId)?.node.name : ''}
          onClose={() => setModal(null)}
          onSave={(name) => saveDirectory(name, modal.parentId, modal.dirId)}
        />
      )}
      {modal?.type === 'chapter' && (
        <ChapterForm
          chapter={modal.chapter}
          index={modal.index || 0}
          defaultStartPage={modal.chapter ? modal.chapter.startPage : Math.max(0, ...(state.books.find((book) => book.id === modal.bookId)?.chapters || []).map((chapter) => Number(chapter.endPage) || 0)) + 1}
          onClose={() => setModal(null)}
          onSave={(chapter) => saveChapter(modal.bookId, chapter, modal.chapter?.id)}
        />
      )}
      {modal?.type === 'move-category' && (
        <MoveCategoryForm
          state={state}
          book={modal.book}
          onClose={() => setModal(null)}
          onSave={(directoryId) => moveBookCategory(modal.book.id, directoryId)}
        />
      )}
      {modal?.type === 'cover-url' && (
        <CoverUrlForm
          book={modal.book}
          onClose={() => setModal(null)}
          onSave={(url) => setCoverFromUrl(modal.book.id, url)}
        />
      )}
      {modal?.type === 'settings' && (
        <SettingsModal
          rootPath={rootPath}
          onChooseRoot={chooseLibraryRoot}
          onOpenRoot={showDbLocation}
          onClose={() => setModal(null)}
        />
      )}

      {contextMenu && (() => {
        const book = state.books.find((item) => item.id === contextMenu.bookId);
        return book ? (
          <BookContextMenu
            menu={contextMenu}
            book={book}
            onClose={() => setContextMenu(null)}
            onEdit={() => setModal({ type: 'book', book })}
            onMove={() => setModal({ type: 'move-category', book })}
            onTrash={() => moveBookToTrash(book.id)}
            onRestore={() => restoreBook(book.id)}
            onDeleteForever={() => permanentlyDeleteBook(book.id)}
          />
        ) : null;
      })()}

      <div className="toastStack" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} role={item.type === 'error' ? 'alert' : 'status'} className={`toast ${item.type}`}>
            {item.message}
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ConfirmProvider><App /></ConfirmProvider>);
