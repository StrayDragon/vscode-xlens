import * as vscode from 'vscode';

export interface FileTreeNode {
    kind: 'folder' | 'file';
    name: string;
    path: string;
    children?: FileTreeNode[];
    fileCount?: number;
    directFileCount?: number;
}

export interface PresetSelection {
    files: string[];
    dirs: string[];
}

export function buildFileTree(filePaths: string[]): FileTreeNode[] {
    interface Mutable {
        kind: 'folder' | 'file';
        name: string;
        path: string;
        children: Map<string, Mutable>;
        fileCount: number;
        directFileCount: number;
    }

    const root: Mutable = {
        kind: 'folder',
        name: '',
        path: '',
        children: new Map(),
        fileCount: 0,
        directFileCount: 0,
    };

    for (const filePath of filePaths) {
        const parts = filePath.split('/').filter(Boolean);
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;

            if (isFile) {
                current.children.set(part, {
                    kind: 'file',
                    name: part,
                    path: filePath,
                    children: new Map(),
                    fileCount: 0,
                    directFileCount: 0,
                });
            } else {
                const folderPath = parts.slice(0, i + 1).join('/');
                let folder = current.children.get(part);
                if (!folder) {
                    folder = {
                        kind: 'folder',
                        name: part,
                        path: folderPath,
                        children: new Map(),
                        fileCount: 0,
                        directFileCount: 0,
                    };
                    current.children.set(part, folder);
                }
                current = folder;
            }
        }
    }

    function computeCounts(node: Mutable): number {
        let directCount = 0;
        let totalCount = 0;
        for (const child of node.children.values()) {
            if (child.kind === 'file') {
                directCount++;
                totalCount++;
            } else {
                totalCount += computeCounts(child);
            }
        }
        node.fileCount = totalCount;
        node.directFileCount = directCount;
        return totalCount;
    }

    function toPublic(node: Mutable): FileTreeNode {
        const children = Array.from(node.children.values())
            .sort((a, b) => {
                if (a.kind !== b.kind) { return a.kind === 'folder' ? -1 : 1; }
                return a.name.localeCompare(b.name);
            })
            .map(toPublic);

        if (node.kind === 'file') {
            return { kind: 'file', name: node.name, path: node.path };
        }

        return {
            kind: 'folder',
            name: node.name,
            path: node.path,
            fileCount: node.fileCount,
            directFileCount: node.directFileCount,
            children,
        };
    }

    computeCounts(root);
    return Array.from(root.children.values())
        .sort((a, b) => {
            if (a.kind !== b.kind) { return a.kind === 'folder' ? -1 : 1; }
            return a.name.localeCompare(b.name);
        })
        .map(toPublic);
}

function getWebviewHtml(tree: FileTreeNode[], nonce: string): string {
    const treeJson = JSON.stringify(tree);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Custom Preset</title>
  <style>
    :root {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
    }
    .toolbar {
      padding: 8px 12px 6px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .toolbar-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      margin-bottom: 6px;
    }
    .toolbar-hint {
      font-size: 11px;
      opacity: 0.75;
      margin-bottom: 6px;
      line-height: 1.35;
    }
    #filter {
      width: 100%;
      height: 26px;
      padding: 0 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    #filter:focus { border-color: var(--vscode-focusBorder); }
    #filter::placeholder { color: var(--vscode-input-placeholderForeground); }
    #tree {
      flex: 1;
      overflow: auto;
      padding: 2px 0 8px;
    }
    .node-row {
      display: flex;
      align-items: center;
      height: 24px;
      line-height: 24px;
      padding-right: 10px;
      position: relative;
      cursor: pointer;
      border-radius: 3px;
      margin: 0 4px;
    }
    .node-row:hover { background: var(--vscode-list-hoverBackground); }
    .node-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .node-row.selected .meta { opacity: 0.7; }
    .node-row .indent-guides {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      pointer-events: none;
    }
    .node-row .indent-guides span {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--vscode-tree-indentGuidesStroke);
    }
    .twistie {
      width: 16px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      cursor: pointer;
      color: var(--vscode-icon-foreground);
    }
    .twistie.hidden { visibility: hidden; pointer-events: none; }
    .twistie svg, .icon svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .checkbox-wrap {
      width: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .checkbox-wrap input {
      margin: 0;
      width: 14px;
      height: 14px;
      cursor: pointer;
      accent-color: var(--vscode-focusBorder);
    }
    .icon {
      width: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-right: 2px;
      color: var(--vscode-icon-foreground);
    }
    .icon.folder { color: var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground)); }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }
    .meta {
      opacity: 0.55;
      font-size: 11px;
      margin-left: 8px;
      flex-shrink: 0;
    }
    .filter-note {
      padding: 8px 12px;
      opacity: 0.75;
      font-size: 12px;
    }
    footer {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    #summary { flex: 1; font-size: 12px; opacity: 0.85; }
    button {
      height: 26px;
      padding: 0 12px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    #confirm {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #confirm:disabled { opacity: 0.45; cursor: default; }
    #cancel {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .link-btn {
      background: transparent;
      color: var(--vscode-textLink-foreground);
      padding: 0 6px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">Pick files to watch</div>
    <div class="toolbar-hint">
      Click a folder twice to cycle: unchecked → track directory ([-]) → select all files recursively ([x]).
      Directory paths are re-resolved on every refresh.
    </div>
    <input id="filter" type="search" placeholder="Filter files..." spellcheck="false" />
  </div>
  <div id="tree"></div>
  <footer>
    <span id="summary">0 selected</span>
    <button class="link-btn" id="select-all">All</button>
    <button class="link-btn" id="clear-all">Clear</button>
    <button id="cancel">Cancel</button>
    <button id="confirm" disabled>Confirm</button>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TREE = ${treeJson};
    const FILTER_LIMIT = 800;

    const ICONS = {
      chevronRight: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6 4l4 4-4 4z"/></svg>',
      chevronDown: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>',
      folder: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 3.5h5l1.5 1.5h6.5v8.5h-13v-10z"/></svg>',
      folderOpen: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 3.5h5l1.5 1.5h6.5v2h-13v-3.5z M1.5 8.5h13v5h-13v-5z"/></svg>',
    };

    const FILE_COLORS = {
      ts: '#3178c6', tsx: '#3178c6',
      js: '#d4b000', jsx: '#d4b000', mjs: '#d4b000', esm: '#d4b000',
      json: '#c9a000',
      md: '#2980b9', mdx: '#2980b9',
      css: '#2965f1', scss: '#c6538c', sass: '#c6538c', less: '#1d365d', styl: '#b3d107',
      html: '#e34c26', htm: '#e34c26',
      py: '#3572a5',
      go: '#00add8',
      rs: '#dea584',
      java: '#b07219',
      cpp: '#f34b7d', c: '#555555', h: '#a8b9cc', hpp: '#f34b7d',
      cs: '#178600',
      rb: '#701516',
      php: '#4f5d95',
      swift: '#ffac45',
      kt: '#a97bff',
      dart: '#00b4ab',
      vue: '#41b883',
      yaml: '#cb171e', yml: '#cb171e',
      toml: '#9c4121',
      xml: '#0060ac',
      sql: '#f29111',
      sh: '#89e051', bash: '#89e051', zsh: '#89e051', fish: '#89e051',
      png: '#26a69a', jpg: '#26a69a', jpeg: '#26a69a', gif: '#26a69a', svg: '#26a69a', webp: '#26a69a', ico: '#26a69a', bmp: '#26a69a',
      mp4: '#26a69a', mov: '#26a69a', avi: '#26a69a', mkv: '#26a69a', webm: '#26a69a',
      mp3: '#26a69a', wav: '#26a69a', ogg: '#26a69a', flac: '#26a69a',
      pdf: '#e53935',
      zip: '#78909c', tar: '#78909c', gz: '#78909c', rar: '#78909c', '7z': '#78909c', bz2: '#78909c', xz: '#78909c',
      doc: '#2b579a', docx: '#2b579a',
      xls: '#217346', xlsx: '#217346', csv: '#217346',
      ppt: '#d24726', pptx: '#d24726',
      lock: '#90a4ae',
      gitignore: '#f05032', dockerignore: '#2496ed', npmignore: '#cb3837',
    };

    function fileIconSvg(fileName) {
      const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      const color = FILE_COLORS[ext] || '#78909c';
      return '<svg viewBox="0 0 16 16">' +
        '<path fill="currentColor" d="M3 1.5h5.5l4.5 4.5v9h-10v-13.5z" opacity="0.85"/>' +
        '<path fill="' + color + '" d="M3 12h10v2.5h-10z"/>' +
        '<path fill="currentColor" d="M8.5 1.5v4h4.5" opacity="0.5"/>' +
        '</svg>';
    }

    /** @type {Set<string>} Explicitly selected file paths. */
    const checkedFiles = new Set();
    /** @type {Set<string>} Directory paths tracked as directories. */
    const checkedDirs = new Set();
    /** @type {Set<string>} */
    const expanded = new Set();
    /** @type {Map<string, object>} */
    const nodeByPath = new Map();

    let filterText = '';
    let filterTimer = 0;
    let renderScheduled = false;

    function indexTree(nodes) {
      for (const n of nodes) {
        nodeByPath.set(n.path, n);
        if (n.children) indexTree(n.children);
      }
    }

    function getDescendantFiles(node, out) {
      for (const c of node.children || []) {
        if (c.kind === 'file') out.push(c.path);
        else getDescendantFiles(c, out);
      }
    }

    function getDescendantDirs(node, out) {
      for (const c of node.children || []) {
        if (c.kind === 'folder') {
          out.push(c.path);
          getDescendantDirs(c, out);
        }
      }
    }

    function hasSelectedDescendant(node) {
      for (const c of node.children || []) {
        if (c.kind === 'file') {
          if (checkedFiles.has(c.path)) return true;
        } else {
          if (checkedDirs.has(c.path)) return true;
          if (hasSelectedDescendant(c)) return true;
        }
      }
      return false;
    }

    function isDirFullySelected(node) {
      const files = [];
      getDescendantFiles(node, files);
      if (files.length === 0) return false; // empty dirs don't count as fully selected
      return files.every(f => checkedFiles.has(f));
    }

    function getAncestorDirPaths(filePath) {
      const parts = filePath.split('/').filter(Boolean);
      const ancestors = [];
      for (let i = 1; i < parts.length; i++) {
        ancestors.push(parts.slice(0, i).join('/'));
      }
      return ancestors;
    }

    function isSelected(node) {
      if (node.kind === 'file') return checkedFiles.has(node.path);
      if (checkedDirs.has(node.path)) return true;
      return isDirFullySelected(node);
    }

    function getDisplayState(node) {
      if (node.kind === 'file') {
        return checkedFiles.has(node.path) ? 'checked' : 'unchecked';
      }
      if (checkedDirs.has(node.path)) return 'dir';
      if (isDirFullySelected(node)) return 'checked';
      if (hasSelectedDescendant(node)) return 'partial';
      return 'unchecked';
    }

    function clearDescendants(node) {
      const files = [];
      getDescendantFiles(node, files);
      for (const f of files) checkedFiles.delete(f);
      const dirs = [];
      getDescendantDirs(node, dirs);
      for (const d of dirs) checkedDirs.delete(d);
    }

    function toggleFile(node) {
      if (checkedFiles.has(node.path)) {
        checkedFiles.delete(node.path);
      } else {
        checkedFiles.add(node.path);
        for (const ancestor of getAncestorDirPaths(node.path)) {
          checkedDirs.delete(ancestor);
        }
      }
      scheduleRender();
      updateSummary();
    }

    function toggleDir(node) {
      if (checkedDirs.has(node.path)) {
        // [-] -> [x]: track dir becomes select all descendant files
        checkedDirs.delete(node.path);
        const dirs = [];
        getDescendantDirs(node, dirs);
        for (const d of dirs) checkedDirs.delete(d);
        const files = [];
        getDescendantFiles(node, files);
        for (const f of files) checkedFiles.add(f);
      } else if (isDirFullySelected(node)) {
        // [x] -> unchecked
        const files = [];
        getDescendantFiles(node, files);
        for (const f of files) checkedFiles.delete(f);
      } else if (hasSelectedDescendant(node)) {
        // partial -> [x]: select all remaining descendant files
        const dirs = [];
        getDescendantDirs(node, dirs);
        for (const d of dirs) checkedDirs.delete(d);
        const files = [];
        getDescendantFiles(node, files);
        for (const f of files) checkedFiles.add(f);
      } else {
        // unchecked -> [-]: track dir
        checkedDirs.add(node.path);
      }
      scheduleRender();
      updateSummary();
    }

    function toggleCheck(node) {
      if (node.kind === 'file') toggleFile(node);
      else toggleDir(node);
    }

    function selectedItems() {
      return {
        files: [...checkedFiles].sort(),
        dirs: [...checkedDirs].sort(),
      };
    }

    function updateSummary() {
      const sel = selectedItems();
      const parts = [];
      if (sel.files.length) parts.push(sel.files.length + ' file' + (sel.files.length !== 1 ? 's' : ''));
      if (sel.dirs.length) parts.push(sel.dirs.length + ' dir' + (sel.dirs.length !== 1 ? 's' : ''));
      const summary = parts.length ? parts.join(' · ') : '0 selected';
      document.getElementById('summary').textContent = summary;
      document.getElementById('confirm').disabled = sel.files.length === 0 && sel.dirs.length === 0;
    }

    function indentGuides(depth) {
      const wrap = document.createElement('div');
      wrap.className = 'indent-guides';
      for (let i = 0; i < depth; i++) {
        const g = document.createElement('span');
        g.style.left = (8 + i * 8) + 'px';
        wrap.appendChild(g);
      }
      return wrap;
    }

    function createRow(node, depth) {
      const isFolder = node.kind === 'folder';
      const isOpen = isFolder && expanded.has(node.path);
      const s = getDisplayState(node);
      const selected = isSelected(node);

      const row = document.createElement('div');
      row.className = 'node-row' + (selected ? ' selected' : '');
      row.style.paddingLeft = (depth * 8 + 4) + 'px';
      if (depth > 0) row.appendChild(indentGuides(depth));

      const twistie = document.createElement('span');
      twistie.className = 'twistie' + (isFolder && node.children?.length ? '' : ' hidden');
      twistie.innerHTML = isOpen ? ICONS.chevronDown : ICONS.chevronRight;
      twistie.onclick = (e) => {
        e.stopPropagation();
        if (!isFolder) return;
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        scheduleRender();
      };

      const cbWrap = document.createElement('span');
      cbWrap.className = 'checkbox-wrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s === 'checked';
      cb.indeterminate = s === 'dir' || s === 'partial';
      cb.onclick = (e) => { e.stopPropagation(); toggleCheck(node); };
      cbWrap.appendChild(cb);

      const icon = document.createElement('span');
      icon.className = 'icon' + (isFolder ? ' folder' : '');
      if (isFolder) {
        icon.innerHTML = isOpen ? ICONS.folderOpen : ICONS.folder;
      } else {
        icon.innerHTML = fileIconSvg(node.name);
      }

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;

      row.append(twistie, cbWrap, icon, label);
      row.onclick = (e) => {
        if (e.target.closest('.twistie') || e.target.closest('.checkbox-wrap')) return;
        toggleCheck(node);
      };

      if (isFolder) {
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = String(node.fileCount || 0);
        row.appendChild(meta);
      }

      return row;
    }

    function renderChildren(container, nodes, depth) {
      for (const node of nodes) {
        container.appendChild(createRow(node, depth));
        if (node.kind === 'folder' && node.children?.length && expanded.has(node.path)) {
          const childWrap = document.createElement('div');
          childWrap.className = 'children';
          renderChildren(childWrap, node.children, depth + 1);
          container.appendChild(childWrap);
        }
      }
    }

    function flattenMatches(query) {
      const q = query.toLowerCase();
      const matches = [];
      function walk(node) {
        if (node.kind === 'file') {
          const path = node.path.toLowerCase();
          if (node.name.toLowerCase().includes(q) || path.includes(q)) matches.push(node);
          return;
        }
        for (const c of node.children || []) walk(c);
      }
      for (const n of TREE) walk(n);
      return matches;
    }

    function renderFilterResults(container, query) {
      const matches = flattenMatches(query);
      const limited = matches.slice(0, FILTER_LIMIT);
      if (matches.length > FILTER_LIMIT) {
        const note = document.createElement('div');
        note.className = 'filter-note';
        note.textContent = 'Showing first ' + FILTER_LIMIT + ' of ' + matches.length + ' matches';
        container.appendChild(note);
      }
      for (const node of limited) {
        const row = createRow(node, 0);
        const label = row.querySelector('.label');
        if (label && node.path.includes('/')) label.textContent = node.path;
        container.appendChild(row);
      }
    }

    function render() {
      const root = document.getElementById('tree');
      root.replaceChildren();
      if (filterText) {
        renderFilterResults(root, filterText);
        return;
      }
      renderChildren(root, TREE, 0);
    }

    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        render();
      });
    }

    indexTree(TREE);
    for (const n of TREE) {
      if (n.kind === 'folder') expanded.add(n.path);
    }
    render();
    updateSummary();

    document.getElementById('filter').addEventListener('input', (e) => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        filterText = e.target.value.trim();
        scheduleRender();
      }, 180);
    });

    document.getElementById('select-all').onclick = () => {
      const targets = filterText ? flattenMatches(filterText) : TREE;
      for (const node of targets) {
        if (node.kind === 'file') {
          checkedFiles.add(node.path);
          for (const ancestor of getAncestorDirPaths(node.path)) {
            checkedDirs.delete(ancestor);
          }
        } else {
          checkedDirs.add(node.path);
          clearDescendants(node);
        }
      }
      scheduleRender();
      updateSummary();
    };

    document.getElementById('clear-all').onclick = () => {
      checkedFiles.clear();
      checkedDirs.clear();
      scheduleRender();
      updateSummary();
    };

    document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
    document.getElementById('confirm').onclick = () => {
      const sel = selectedItems();
      if (sel.files.length === 0 && sel.dirs.length === 0) return;
      vscode.postMessage({ type: 'confirm', files: sel.files, dirs: sel.dirs });
    };
  </script>
</body>
</html>`;
}

export async function openPresetPickerWebview(filePaths: string[]): Promise<PresetSelection | undefined> {
    if (filePaths.length === 0) {
        vscode.window.showWarningMessage('XLens: No files available to pick from.');
        return undefined;
    }

    const tree = buildFileTree(filePaths);

    return new Promise((resolve) => {
        let settled = false;

        const panel = vscode.window.createWebviewPanel(
            'xlensPresetPicker',
            'XLens: Custom Preset',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: false },
        );

        const finish = (selection: PresetSelection | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(selection);
            panel.dispose();
        };

        const nonce = String(Date.now());
        panel.webview.html = getWebviewHtml(tree, nonce);

        panel.webview.onDidReceiveMessage((msg: { type: string; files?: string[]; dirs?: string[] }) => {
            if (msg.type === 'confirm') {
                const files = Array.isArray(msg.files) ? msg.files : [];
                const dirs = Array.isArray(msg.dirs) ? msg.dirs : [];
                if (files.length === 0 && dirs.length === 0) {
                    vscode.window.showWarningMessage('XLens: Nothing selected.');
                    return;
                }
                finish({ files, dirs });
            } else if (msg.type === 'cancel') {
                finish(undefined);
            }
        });

        panel.onDidDispose(() => finish(undefined));
    });
}
