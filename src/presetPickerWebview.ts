import * as vscode from 'vscode';

export interface FileTreeNode {
    kind: 'folder' | 'file';
    name: string;
    path: string;
    children?: FileTreeNode[];
    fileCount?: number;
}

export function buildFileTree(filePaths: string[]): FileTreeNode[] {
    interface Mutable {
        kind: 'folder' | 'file';
        name: string;
        path: string;
        children: Map<string, Mutable>;
        fileCount: number;
    }

    const root: Mutable = {
        kind: 'folder',
        name: '',
        path: '',
        children: new Map(),
        fileCount: 0,
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
                    };
                    current.children.set(part, folder);
                }
                current = folder;
            }
        }
    }

    function computeCounts(node: Mutable): number {
        let count = 0;
        for (const child of node.children.values()) {
            count += child.kind === 'file' ? 1 : computeCounts(child);
        }
        node.fileCount = count;
        return count;
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
      height: 22px;
      line-height: 22px;
      padding-right: 8px;
      position: relative;
    }
    .node-row:hover { background: var(--vscode-list-hoverBackground); }
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
      chevronRight: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4z"/></svg>',
      chevronDown: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4z"/></svg>',
      file: '<svg viewBox="0 0 16 16"><path d="M4 2h6l3 3v9H4V2zm6 0v3h3"/></svg>',
      folder: '<svg viewBox="0 0 16 16"><path d="M2 4h5l1 1h6v7H2V4z"/></svg>',
      folderOpen: '<svg viewBox="0 0 16 16"><path d="M2 5h5l1 1h6v1H2V5zm0 2h12v5H2V7z"/></svg>',
    };

    /** @type {Map<string, 'checked'|'unchecked'|'partial'>} */
    const state = new Map();
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
        state.set(n.path, 'unchecked');
        if (n.children) indexTree(n.children);
      }
    }

    function collectFilePaths(node, out) {
      if (node.kind === 'file') { out.push(node.path); return; }
      for (const c of node.children || []) collectFilePaths(c, out);
    }

    function setSubtree(node, value) {
      state.set(node.path, value);
      for (const c of node.children || []) setSubtree(c, value);
    }

    function refreshFolder(node) {
      if (node.kind !== 'folder' || !node.children?.length) return;
      let checked = 0, partial = 0;
      for (const c of node.children) {
        const s = state.get(c.path);
        if (s === 'checked') checked++;
        else if (s === 'partial') partial++;
      }
      const total = node.children.length;
      if (checked === total && partial === 0) state.set(node.path, 'checked');
      else if (checked === 0 && partial === 0) state.set(node.path, 'unchecked');
      else state.set(node.path, 'partial');
    }

    function updateAncestors(path) {
      const parts = path.split('/');
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts.slice(0, i + 1).join('/');
        const node = nodeByPath.get(p);
        if (node?.kind === 'folder') refreshFolder(node);
      }
    }

    function toggleCheck(node) {
      const next = state.get(node.path) === 'checked' ? 'unchecked' : 'checked';
      setSubtree(node, next);
      updateAncestors(node.path);
      scheduleRender();
      updateSummary();
    }

    function selectedFiles() {
      const out = [];
      function walk(node) {
        const s = state.get(node.path);
        if (node.kind === 'file') {
          if (s === 'checked') out.push(node.path);
          return;
        }
        if (s === 'checked') {
          collectFilePaths(node, out);
          return;
        }
        for (const c of node.children || []) walk(c);
      }
      for (const n of TREE) walk(n);
      return [...new Set(out)].sort();
    }

    function updateSummary() {
      const count = selectedFiles().length;
      document.getElementById('summary').textContent = count + ' selected';
      document.getElementById('confirm').disabled = count === 0;
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
      const s = state.get(node.path);

      const row = document.createElement('div');
      row.className = 'node-row';
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
      cb.indeterminate = s === 'partial';
      cb.onclick = (e) => { e.stopPropagation(); toggleCheck(node); };
      cbWrap.appendChild(cb);

      const icon = document.createElement('span');
      icon.className = 'icon' + (isFolder ? ' folder' : '');
      if (isFolder) {
        icon.innerHTML = isOpen ? ICONS.folderOpen : ICONS.folder;
      } else {
        icon.innerHTML = ICONS.file;
      }

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      label.onclick = () => {
        if (isFolder && node.children?.length) twistie.click();
        else toggleCheck(node);
      };

      row.append(twistie, cbWrap, icon, label);

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
      const targets = filterText
        ? flattenMatches(filterText)
        : (() => { const all = []; for (const n of TREE) collectFilePaths(n, all); return all.map(p => nodeByPath.get(p)).filter(Boolean); })();
      for (const node of targets) setSubtree(node, 'checked');
      for (const n of TREE) if (n.kind === 'folder') refreshFolder(n);
      scheduleRender();
      updateSummary();
    };

    document.getElementById('clear-all').onclick = () => {
      for (const [path] of state) state.set(path, 'unchecked');
      scheduleRender();
      updateSummary();
    };

    document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
    document.getElementById('confirm').onclick = () => {
      vscode.postMessage({ type: 'confirm', files: selectedFiles() });
    };
  </script>
</body>
</html>`;
}

export async function openPresetPickerWebview(filePaths: string[]): Promise<string[] | undefined> {
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

        const finish = (files: string[] | undefined) => {
            if (settled) { return; }
            settled = true;
            resolve(files);
            panel.dispose();
        };

        const nonce = String(Date.now());
        panel.webview.html = getWebviewHtml(tree, nonce);

        panel.webview.onDidReceiveMessage((msg: { type: string; files?: string[] }) => {
            if (msg.type === 'confirm' && Array.isArray(msg.files)) {
                if (msg.files.length === 0) {
                    vscode.window.showWarningMessage('XLens: No files selected.');
                    return;
                }
                finish(msg.files);
            } else if (msg.type === 'cancel') {
                finish(undefined);
            }
        });

        panel.onDidDispose(() => finish(undefined));
    });
}
