// ============================================================
// app.bundle.js — Single-file build, no ES modules required.
// Works with file:// protocol (no server needed).
// ============================================================

// ── constants.js ─────────────────────────────────────────
const EVENTS = {
  DATA_LOADED: 'data:loaded',
  NODE_SELECTED: 'node:selected',
  EDGE_SELECTED: 'edge:selected',
  SELECTION_CLEARED: 'selection:cleared',
  FOCUS_NODE: 'focus:node',
  FOCUS_RESET: 'focus:reset',
  LAYOUT_RUN: 'layout:run',
  FILTERS_APPLIED: 'filters:applied',
  NAMESPACE_REBUILD: 'namespace:rebuild',
  GRAPH_READY: 'graph:ready',
};

const DOM = {
  CY: 'cy',
  FILTERS: 'filters',
  DETAIL_PANEL: 'detail-panel',
  NS_BREADCRUMB: 'ns-breadcrumb',
  NS_PANEL: 'ns-panel',
  SEARCH_INPUT: 'search-input',
  SEARCH_RESULTS: 'search-results',
  WARNINGS_BADGE: 'warnings-badge',
  WARNINGS_LIST: 'warnings-list',
  META_STATS: 'meta-stats',
  LOADING: 'loading',
  LARGE_DATASET_BANNER: 'large-dataset-banner',
  GRAPH_STATUS: 'graph-status',
  BTN_NEW_ANALYSIS: 'btn-new-analysis',
  DROP_ZONE: 'drop-zone',
  LAYOUT_SELECT: 'layout-select',
  NS_SELECT_ALL: 'ns-select-all',
  NS_DESELECT_ALL: 'ns-deselect-all',
  NS_SEARCH: 'ns-search',
  FILTER_EXTERNAL: 'filter-external',
  BTN_RESET_FOCUS: 'btn-reset-focus',
  BTN_EXPORT_PNG: 'btn-export-png',
};

const NODE_TYPE = {
  NAMESPACE: 'namespace',
  CLASS: 'class',
};


// ── state.js ─────────────────────────────────────────────
const bus = new EventTarget();

function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

function on(name, handler) {
  bus.addEventListener(name, (e) => handler(e.detail));
}

// Shared application state
const state = {
  data: null,
  cy: null,
  cycles: [],
  selectedNode: null,
  focusDepth: 1,
  filtersActive: false,
};


// ── data-loader.js ───────────────────────────────────────

// Inline worker code — runs JSON.parse + data processing off the main thread.
// Uses String.fromCharCode(92) for backslash to avoid template-literal escaping issues.
const WORKER_CODE = `
  var SEP = String.fromCharCode(92);

  function getNamespaceKey(fqcn, isExternal) {
    var parts = fqcn.split(SEP);
    if (parts.length < 2) return parts[0];
    return isExternal ? parts[0] : parts.slice(0, 2).join(SEP);
  }

  function detectCycles(edges, nodeCount) {
    if (nodeCount > 3000) return [];
    var adj = new Map();
    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source).push(e.target);
    }
    var visited = new Set();
    var inStack = new Set();
    var cycles = [];
    var MAX_CYCLES = 50;

    function dfs(node, path) {
      if (cycles.length >= MAX_CYCLES) return;
      if (inStack.has(node)) {
        var cycleStart = path.indexOf(node);
        if (cycleStart !== -1) cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      path.push(node);
      var neighbors = adj.get(node) || [];
      for (var i = 0; i < neighbors.length; i++) dfs(neighbors[i], path);
      path.pop();
      inStack.delete(node);
    }

    var nodes = Array.from(adj.keys());
    for (var i = 0; i < nodes.length; i++) {
      if (!visited.has(nodes[i])) dfs(nodes[i], []);
    }
    return cycles;
  }

  self.onmessage = function(e) {
    try {
      var raw = JSON.parse(e.data);
      var seen = new Set(raw.classes.map(function(c) { return c.fqcn; }));
      var classesArray = raw.classes.map(function(cls) {
        return Object.assign({}, cls, {
          external: false,
          namespace: getNamespaceKey(cls.fqcn, false),
        });
      });
      for (var i = 0; i < raw.edges.length; i++) {
        var edge = raw.edges[i];
        var fqcns = [edge.source, edge.target];
        for (var j = 0; j < fqcns.length; j++) {
          var fqcn = fqcns[j];
          if (!seen.has(fqcn)) {
            seen.add(fqcn);
            classesArray.push({
              fqcn: fqcn, type: 'class', file: null, line: null,
              dependencies: [], dependants: [],
              external: true,
              namespace: getNamespaceKey(fqcn, true),
            });
          }
        }
      }
      var nodeCount = (raw.meta && raw.meta.node_count) || raw.classes.length;
      var cycles = detectCycles(raw.edges, nodeCount);
      self.postMessage({ ok: true, classesArray: classesArray, edges: raw.edges, meta: raw.meta, warnings: raw.warnings || [], cycles: cycles });
    } catch(err) {
      self.postMessage({ ok: false, error: err.message });
    }
  };
`;

function parseAndProcessInWorker(text) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      if (e.data.ok) {
        resolve(processWorkerResult(e.data));
      } else {
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = (err) => {
      URL.revokeObjectURL(url);
      worker.terminate();
      reject(new Error(err.message || 'Worker error'));
    };
    worker.postMessage(text);
  });
}

function processWorkerResult({ classesArray, edges, meta, warnings, cycles }) {
  const classMap = new Map(classesArray.map((cls) => [cls.fqcn, cls]));

  const processed = { meta, classes: classMap, edges, warnings, cycles };

  state.data = processed;
  state.cycles = cycles;
  emit('data:loaded', processed);

  if (meta && meta.node_count > 200) {
    const banner = document.getElementById('large-dataset-banner');
    banner.textContent = `Large dataset (${meta.node_count} nodes). Use namespace filters for better performance.`;
    banner.removeAttribute('hidden');
  }

  return processed;
}

/**
 * Try fetch, fallback to file picker UI.
 */
async function loadData() {
  if (sessionStorage.getItem('forceFilePicker')) {
    sessionStorage.removeItem('forceFilePicker');
    return waitForFilePicker();
  }
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(res.statusText);
    const text = await res.text();
    return await parseAndProcessInWorker(text);
  } catch {
    return waitForFilePicker();
  }
}

function showDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.classList.add('visible');
}

function hideDropZone() {
  const zone = document.getElementById('drop-zone');
  zone.classList.remove('visible');
}

function waitForFilePicker() {
  return new Promise((resolve) => {
    showDropZone();
    const zone = document.getElementById('drop-zone');
    const input = zone.querySelector('input[type="file"]');

    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const processed = await parseAndProcessInWorker(e.target.result);
          hideDropZone();
          resolve(processed);
        } catch {
          zone.querySelector('.drop-zone__error').textContent = 'Invalid JSON file.';
        }
      };
      reader.readAsText(file);
    }

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files.length) handleFile(input.files[0]);
    });
  });
}

/**
 * Get namespace key: first 2 segments for internal, first segment for external.
 */
function getNamespaceKey(fqcn, isExternal) {
  const parts = fqcn.split('\\');
  if (parts.length < 2) return parts[0];
  return isExternal ? parts[0] : parts.slice(0, 2).join('\\');
}


// ── namespace-browser.js ─────────────────────────────────

let currentScope = []; // array of namespace segments, e.g. ['App', 'Services']
let viewMode = 'folders'; // 'folders' | 'classes'
let nsData = null;

function getViewMode() {
  return viewMode;
}

function setViewMode(mode) {
  viewMode = mode;
  renderBreadcrumb();
  emit('selection:cleared');
  emit('namespace:rebuild');
}

/**
 * Build Cytoscape elements for the given scope level.
 *
 * At scope [] (root): one node per top-level namespace segment.
 * At scope ['App']: one node per child of App (sub-namespace folders or leaf classes).
 * Edges are aggregated between nodes at the current scope level.
 */
function buildNamespaceElementsAtScope(data, scope) {
  const SEP = '\\';
  const nodes = [];
  const edges = [];

  // Degree for class node sizing
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Only internal classes
  const allClasses = [...data.classes.values()].filter((c) => !c.external);

  // Group classes by their child segment at this scope level
  // Map: segment → { isFolder: bool, fqcns: Set<string> }
  const childInfo = new Map();

  for (const cls of allClasses) {
    const parts = cls.fqcn.split(SEP);

    // Skip if not under current scope
    if (scope.length > 0) {
      if (parts.length <= scope.length) continue;
      let match = true;
      for (let i = 0; i < scope.length; i++) {
        if (parts[i] !== scope[i]) { match = false; break; }
      }
      if (!match) continue;
    }

    const segment = parts[scope.length];
    if (segment === undefined) continue;

    if (!childInfo.has(segment)) {
      childInfo.set(segment, { isFolder: false, fqcns: new Set() });
    }
    childInfo.get(segment).fqcns.add(cls.fqcn);

    // If there are more parts, this segment is a namespace folder
    if (parts.length > scope.length + 1) {
      childInfo.get(segment).isFolder = true;
    }
  }

  // Cycle detection: which FQCNs are in cycles?
  const cycleSet = new Set((state.cycles || []).flat());

  // Build fqcn → nodeId mapping for edge aggregation
  const fqcnToNodeId = new Map();
  const prefix = scope.length > 0 ? scope.join(SEP) + SEP : '';

  for (const [segment, info] of childInfo) {
    const nsPath = prefix + segment;

    if (info.isFolder) {
      const nodeId = 'ns::' + nsPath;
      for (const fqcn of info.fqcns) fqcnToNodeId.set(fqcn, nodeId);

      const hasCycle = [...info.fqcns].some((fqcn) => cycleSet.has(fqcn));
      nodes.push({
        data: {
          id: nodeId,
          label: segment + '\n' + info.fqcns.size + (info.fqcns.size === 1 ? ' class' : ' classes'),
          nodeType: 'namespace',
          nsPath,
          classCount: info.fqcns.size,
          hasCycle,
        },
      });
    } else {
      const fqcn = [...info.fqcns][0];
      const cls = data.classes.get(fqcn);
      fqcnToNodeId.set(fqcn, fqcn);
      nodes.push({
        data: {
          id: fqcn,
          label: fqcn.split(SEP).pop(),
          fullLabel: fqcn,
          type: cls.type,
          nodeType: 'class',
          external: false,
          namespace: cls.namespace,
          file: cls.file,
          line: cls.line,
          depCount: cls.dependencies ? cls.dependencies.length : 0,
          dependantCount: cls.dependants ? cls.dependants.length : 0,
          degree: degree.get(fqcn) || 0,
        },
      });
    }
  }

  // Build aggregated edges
  const renderedNodeIds = new Set(nodes.map((n) => n.data.id));
  const CONFIDENCE_RANK = { certain: 4, high: 3, medium: 2, low: 1 };
  const edgeMap = new Map();

  for (const e of data.edges) {
    const srcId = fqcnToNodeId.get(e.source);
    const tgtId = fqcnToNodeId.get(e.target);
    if (!srcId || !tgtId || srcId === tgtId) continue;
    if (!renderedNodeIds.has(srcId) || !renderedNodeIds.has(tgtId)) continue;
    const key = srcId + '\u2192' + tgtId;
    if (!edgeMap.has(key)) edgeMap.set(key, { source: srcId, target: tgtId, entries: [] });
    edgeMap.get(key).entries.push(e);
  }

  let ei = 0;
  for (const group of edgeMap.values()) {
    const { source, target, entries } = group;
    const best = entries.reduce((a, b) =>
      (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b : a
    );
    edges.push({
      data: {
        id: 'e' + ei++,
        source,
        target,
        weight: entries.length,
        confidence: best.confidence,
        edgeType: entries.map((e) => e.type).join(', '),
        entries,
      },
    });
  }

  return [...nodes, ...edges];
}

/**
 * Build Cytoscape elements showing all individual classes at the given scope,
 * without grouping into namespace folders.
 */
function buildClassElementsAtScope(data, scope) {
  const SEP = '\\';
  const nodes = [];
  const edges = [];

  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  const allClasses = [...data.classes.values()].filter((c) => !c.external);

  for (const cls of allClasses) {
    if (scope.length > 0) {
      const parts = cls.fqcn.split(SEP);
      if (parts.length <= scope.length) continue;
      let match = true;
      for (let i = 0; i < scope.length; i++) {
        if (parts[i] !== scope[i]) { match = false; break; }
      }
      if (!match) continue;
    }

    nodes.push({
      data: {
        id: cls.fqcn,
        label: cls.fqcn.split(SEP).pop(),
        fullLabel: cls.fqcn,
        type: cls.type,
        nodeType: 'class',
        external: false,
        namespace: cls.namespace,
        file: cls.file,
        line: cls.line,
        depCount: cls.dependencies ? cls.dependencies.length : 0,
        dependantCount: cls.dependants ? cls.dependants.length : 0,
        degree: degree.get(cls.fqcn) || 0,
      },
    });
  }

  const renderedIds = new Set(nodes.map((n) => n.data.id));
  const CONFIDENCE_RANK = { certain: 4, high: 3, medium: 2, low: 1 };
  const edgeMap = new Map();

  for (const e of data.edges) {
    if (!renderedIds.has(e.source) || !renderedIds.has(e.target)) continue;
    const key = e.source + '\u2192' + e.target;
    if (!edgeMap.has(key)) edgeMap.set(key, { source: e.source, target: e.target, entries: [] });
    edgeMap.get(key).entries.push(e);
  }

  let ei = 0;
  for (const group of edgeMap.values()) {
    const { source, target, entries } = group;
    const best = entries.reduce((a, b) =>
      (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b : a
    );
    edges.push({
      data: {
        id: 'e' + ei++,
        source,
        target,
        weight: entries.length,
        confidence: best.confidence,
        edgeType: entries.map((e) => e.type).join(', '),
        entries,
      },
    });
  }

  return [...nodes, ...edges];
}

function navigateToScope(nsPath) {
  currentScope = nsPath ? nsPath.split('\\') : [];
  renderBreadcrumb();
  emit('selection:cleared');
  emit('namespace:rebuild');
}

function getCurrentScope() {
  return currentScope;
}

function renderBreadcrumb() {
  const el = document.getElementById('ns-breadcrumb');
  if (!el) return;

  const parts = currentScope;
  const items = [];

  if (parts.length === 0) {
    items.push('<span class="breadcrumb-item breadcrumb-item--current">root</span>');
  } else {
    items.push('<span class="breadcrumb-item" data-scope="">root</span>');
  }

  for (let i = 0; i < parts.length; i++) {
    const sc = parts.slice(0, i + 1).join('\\');
    items.push('<span class="breadcrumb-sep">›</span>');
    if (i === parts.length - 1) {
      items.push(
        '<span class="breadcrumb-item breadcrumb-item--current">' + escHtml(parts[i]) + '</span>'
      );
    } else {
      items.push(
        '<span class="breadcrumb-item" data-scope="' + escHtml(sc) + '">' + escHtml(parts[i]) + '</span>'
      );
    }
  }

  const isClassMode = viewMode === 'classes';
  const toggleLabel = isClassMode ? 'Namespaces' : 'Classes';
  const toggleTitle = isClassMode ? 'Afficher par namespaces' : 'Afficher toutes les classes';

  el.innerHTML =
    '<span class="breadcrumb-path">' + items.join('') + '</span>' +
    '<button class="view-mode-toggle' + (isClassMode ? ' view-mode-toggle--active' : '') +
    '" id="view-mode-toggle" title="' + toggleTitle + '">' + toggleLabel + '</button>';

  el.querySelectorAll('.breadcrumb-item[data-scope]').forEach((item) => {
    item.addEventListener('click', () => navigateToScope(item.dataset.scope));
  });

  el.querySelector('#view-mode-toggle').addEventListener('click', () => {
    setViewMode(viewMode === 'folders' ? 'classes' : 'folders');
  });
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initNamespaceBrowser(data) {
  nsData = data;
  currentScope = [];
  renderBreadcrumb();
}


// ── graph-renderer.js ────────────────────────────────────

let cy = null;

// Above this threshold, only the top N most-connected internal nodes are added
// to Cytoscape to prevent the initial render from freezing.
const MAX_RENDERED_NODES = 2000;

const NODE_COLORS = {
  class: '#3B82F6',
  interface: '#8B5CF6',
  trait: '#F59E0B',
  enum: '#10B981',
};

const NODE_SHAPES = {
  class: 'ellipse',
  interface: 'diamond',
  trait: 'hexagon',
  enum: 'rectangle',
};

const EDGE_STYLES = {
  certain: { width: 2, style: 'solid' },
  high: { width: 1, style: 'solid' },
  medium: { width: 1, style: 'dashed' },
  low: { width: 1, style: 'dotted' },
};

function initGraph(data) {
  initNamespaceBrowser(data);

  const elements = buildNamespaceElementsAtScope(data, []);

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    style: buildStylesheet(),
    layout: { name: 'preset' },
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  });

  state.cy = cy;

  cy.ready(() => runLayout('fcose'));

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    const d = node.data();
    if (d.nodeType === 'namespace') {
      navigateToScope(d.nsPath);
      return;
    }
    emit('node:selected', node.id());
  });

  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    emit('edge:selected', {
      source: edge.data('source'),
      target: edge.data('target'),
      weight: edge.data('weight'),
      confidence: edge.data('confidence'),
      entries: edge.data('entries'),
    });
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      resetFocus();
      emit('selection:cleared');
    }
  });

  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    const d = node.data();

    if (d.nodeType === 'namespace') {
      const neighborhood = node.closedNeighborhood();
      cy.startBatch();
      cy.elements().addClass('hover-dimmed');
      neighborhood.removeClass('hover-dimmed');
      node.addClass('hover-highlighted');
      cy.endBatch();
    }

    node.connectedEdges().forEach((edge) => {
      if (edge.source().id() === node.id()) {
        edge.addClass('edge-out');
      } else {
        edge.addClass('edge-in');
      }
    });
  });

  cy.on('mouseout', 'node', () => {
    cy.startBatch();
    cy.elements().removeClass('hover-dimmed hover-highlighted');
    cy.edges().removeClass('edge-out edge-in');
    cy.endBatch();
  });

  on('focus:node', ({ nodeId, depth }) => focusNode(nodeId, depth));
  on('focus:reset', () => resetFocus());
  on('layout:run', (name) => runLayout(name));

  on('namespace:rebuild', () => {
    if (!cy || !state.data) return;
    const scope = getCurrentScope();
    const els = getViewMode() === 'classes'
      ? buildClassElementsAtScope(state.data, scope)
      : buildNamespaceElementsAtScope(state.data, scope);
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();
    state.selectedNode = null;
    if (state.cycles && state.cycles.length > 0) markCycleNodes(state.cycles);
    runLayout('fcose');
  });

  const btnExport = document.getElementById('btn-export-png');
  if (btnExport) {
    btnExport.removeAttribute('hidden');
    btnExport.addEventListener('click', exportPng);
  }

  emit('graph:ready', cy);
}

function exportPng() {
  if (!cy) return;
  const dataUrl = cy.png({ output: 'blob', bg: '#0F172A', full: true, scale: 2 });
  const url = URL.createObjectURL(dataUrl);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'php-dep-graph.png';
  a.click();
  URL.revokeObjectURL(url);
}

function buildElements(data) {
  const nodes = [];
  const edges = [];

  // Compute degree (in + out) for each node from the raw edge list
  const degree = new Map();
  for (const e of data.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Determine which internal nodes to render (cap for large datasets)
  const internalNodes = [...data.classes.values()].filter((c) => !c.external);
  let allowedFQCNs = null; // null = all allowed

  if (internalNodes.length > MAX_RENDERED_NODES) {
    const sorted = [...internalNodes].sort(
      (a, b) => (degree.get(b.fqcn) || 0) - (degree.get(a.fqcn) || 0)
    );
    allowedFQCNs = new Set(sorted.slice(0, MAX_RENDERED_NODES).map((c) => c.fqcn));

    const banner = document.getElementById('large-dataset-banner');
    banner.textContent = `Large dataset: displaying top ${MAX_RENDERED_NODES} of ${internalNodes.length} most-connected nodes. Filter by namespace to explore specific subgraphs.`;
    banner.removeAttribute('hidden');
  }

  for (const [fqcn, cls] of data.classes) {
    // Skip external nodes (hidden by default anyway) and capped internal nodes
    if (cls.external) continue;
    if (allowedFQCNs && !allowedFQCNs.has(fqcn)) continue;

    const shortName = fqcn.split('\\').pop();
    nodes.push({
      data: {
        id: fqcn,
        label: shortName,
        fullLabel: fqcn,
        type: cls.type,
        external: cls.external,
        namespace: cls.namespace,
        file: cls.file,
        line: cls.line,
        depCount: cls.dependencies ? cls.dependencies.length : 0,
        dependantCount: cls.dependants ? cls.dependants.length : 0,
      },
    });
  }

  const renderedIds = new Set(nodes.map((n) => n.data.id));

  // Consolidate parallel edges
  const CONFIDENCE_RANK = { certain: 4, high: 3, medium: 2, low: 1 };
  const edgeMap = new Map();
  for (const e of data.edges) {
    // Only include edges where both endpoints are rendered
    if (!renderedIds.has(e.source) || !renderedIds.has(e.target)) continue;
    const key = `${e.source}\u2192${e.target}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source: e.source, target: e.target, entries: [] });
    }
    edgeMap.get(key).entries.push(e);
  }

  let i = 0;
  for (const group of edgeMap.values()) {
    const { source, target, entries } = group;
    const best = entries.reduce((a, b) =>
      (CONFIDENCE_RANK[b.confidence] || 0) > (CONFIDENCE_RANK[a.confidence] || 0) ? b : a
    );
    edges.push({
      data: {
        id: `e${i++}`,
        source,
        target,
        weight: entries.length,
        edgeType: entries.map((e) => e.type).join(', '),
        confidence: best.confidence,
        file: best.file,
        line: best.line,
        entries,
      },
    });
  }

  return [...nodes, ...edges];
}

function buildStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'font-size': 11,
        'font-family': 'Inter, system-ui, sans-serif',
        color: '#E2E8F0',
        'text-outline-color': '#0F172A',
        'text-outline-width': 2,
        width: 'mapData(degree, 0, 10, 20, 60)',
        height: 'mapData(degree, 0, 10, 20, 60)',
        'border-width': 2,
        'border-color': '#1E293B',
        'transition-property': 'opacity, background-color, border-color',
        'transition-duration': '200ms',
      },
    },
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[type="${type}"]`,
      style: {
        'background-color': color,
        shape: NODE_SHAPES[type],
      },
    })),
    {
      selector: 'node[?external]',
      style: {
        'background-color': '#9CA3AF',
        'border-style': 'dashed',
        'border-color': '#6B7280',
      },
    },
    {
      selector: 'node.in-cycle',
      style: {
        'border-color': '#EF4444',
        'border-width': 3,
      },
    },
    {
      selector: 'node.dimmed',
      style: { opacity: 0.15 },
    },
    {
      selector: 'edge.dimmed',
      style: { opacity: 0.15 },
    },
    {
      selector: 'node.highlighted',
      style: {
        'border-color': '#FACC15',
        'border-width': 4,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': '#94A3B8',
        'target-arrow-color': '#94A3B8',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
        'transition-property': 'opacity, line-color, target-arrow-color',
        'transition-duration': '200ms',
      },
    },
    ...Object.entries(EDGE_STYLES).map(([confidence, s]) => ({
      selector: `edge[confidence="${confidence}"]`,
      style: {
        'line-style': s.style,
      },
    })),
    {
      selector: 'edge.edge-out',
      style: {
        'line-color': '#EF4444',
        'target-arrow-color': '#EF4444',
        width: 2,
      },
    },
    {
      selector: 'edge.edge-in',
      style: {
        'line-color': '#22C55E',
        'target-arrow-color': '#22C55E',
        width: 2,
      },
    },
    {
      selector: 'node.search-match',
      style: {
        'border-color': '#F97316',
        'border-width': 4,
      },
    },
    {
      selector: 'node.hover-dimmed',
      style: { opacity: 0.12 },
    },
    {
      selector: 'edge.hover-dimmed',
      style: { opacity: 0.08 },
    },
    {
      selector: 'node.hover-highlighted',
      style: {
        'border-color': '#60A5FA',
        'border-width': 4,
      },
    },
    {
      selector: 'node[nodeType="namespace"]',
      style: {
        'background-color': '#0F4C81',
        'background-opacity': 0.95,
        shape: 'roundrectangle',
        width: 'mapData(classCount, 1, 80, 70, 160)',
        height: 'mapData(classCount, 1, 80, 70, 160)',
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': 13,
        'font-weight': 600,
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'text-outline-width': 0,
        color: '#E2E8F0',
        'border-color': '#3B82F6',
        'border-width': 2,
        cursor: 'pointer',
        'transition-property': 'border-color, border-width, background-color',
        'transition-duration': '150ms',
      },
    },
    {
      selector: 'node[nodeType="namespace"]:active',
      style: {
        'background-color': '#1E4D8C',
        'border-color': '#60A5FA',
        'border-width': 3,
      },
    },
  ];
}

function runLayout(name) {
  if (!cy) return;

  const visibleEles = cy.elements(':visible');
  if (visibleEles.length === 0) return;

  const visibleNodeCount = visibleEles.nodes().length;

  // For very large visible graphs, fall back to grid (instant, non-blocking)
  if (visibleNodeCount > 1500) {
    visibleEles.layout({ name: 'grid', animate: false, fit: true, padding: 40 }).run();
    return;
  }

  // For medium graphs, use fcose/cose but without animation and fewer iterations
  const large = visibleNodeCount > 500;

  const options =
    name === 'fcose'
      ? {
          name: 'fcose',
          animate: !large,
          animationDuration: large ? 0 : 500,
          fit: true,
          padding: 40,
          quality: large ? 'draft' : 'default',
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
          edgeElasticity: 0.45,
          gravity: 0.25,
          gravityRange: 3.8,
          numIter: large ? 500 : 2500,
          tile: true,
          packComponents: true,
        }
      : {
          name: 'cose',
          animate: !large,
          animationDuration: large ? 0 : 500,
          fit: true,
          padding: 40,
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
        };

  try {
    visibleEles.layout(options).run();
  } catch (e) {
    console.warn('Layout "' + name + '" failed, falling back to grid:', e.message);
    visibleEles.layout({ name: 'grid', animate: false, fit: true, padding: 40 }).run();
  }
}

function focusNode(nodeId, depth = 1) {
  if (!cy) return;

  const node = cy.getElementById(nodeId);
  if (!node || node.empty()) return;

  const neighborhood = node.closedNeighborhood();
  let focus = neighborhood;

  if (depth === 2) {
    focus = neighborhood.closedNeighborhood();
  }

  cy.startBatch();
  cy.elements().addClass('dimmed');
  focus.removeClass('dimmed');
  node.addClass('highlighted');
  cy.endBatch();

  state.selectedNode = nodeId;
  state.focusDepth = depth;
}

function resetFocus() {
  if (!cy) return;
  cy.startBatch();
  cy.elements().removeClass('dimmed highlighted');
  cy.endBatch();
  state.selectedNode = null;
}

function markCycleNodes(cycles) {
  if (!cy) return;
  const nodesInCycles = new Set();
  for (const cycle of cycles) {
    for (const fqcn of cycle) {
      nodesInCycles.add(fqcn);
    }
  }
  cy.startBatch();
  for (const fqcn of nodesInCycles) {
    cy.getElementById(fqcn).addClass('in-cycle');
  }
  cy.endBatch();
}


// ── filter-manager.js ────────────────────────────────────

let filtersEl;
let namespaces = [];

function initFilters(data) {
  filtersEl = document.getElementById('filters');
  namespaces = collectNamespaces(data);
  render(data);
  bindEvents();
  on('data:loaded', (d) => {
    namespaces = collectNamespaces(d);
    render(d);
  });
}

function collectNamespaces(data) {
  const nsSet = new Set();
  for (const [, cls] of data.classes) {
    nsSet.add(cls.namespace);
  }
  return [...nsSet].sort();
}

function render(data) {
  const types = ['class', 'interface', 'trait', 'enum'];
  const confidences = ['certain', 'high', 'medium', 'low'];

  filtersEl.innerHTML = `
    <div class="filter-section">
      <h3>Show external</h3>
      <label class="toggle-label">
        <input type="checkbox" id="filter-external"> Show vendor / external classes
      </label>
    </div>

    <div class="filter-section">
      <h3>Type</h3>
      ${types
        .map(
          (t) => `
        <label class="filter-check">
          <input type="checkbox" data-filter="type" value="${t}" checked>
          <span class="chip chip--${t}">${t}</span>
        </label>`
        )
        .join('')}
    </div>

    <div class="filter-section">
      <h3>Confidence</h3>
      ${confidences
        .map(
          (c) => `
        <label class="filter-check">
          <input type="checkbox" data-filter="confidence" value="${c}" checked>
          ${c}
        </label>`
        )
        .join('')}
    </div>

    <div class="filter-section">
      <h3>Namespace</h3>
      <div class="namespace-actions">
        <button class="btn btn--sm" id="ns-select-all">All</button>
        <button class="btn btn--sm" id="ns-deselect-all">None</button>
      </div>
      <input type="text" id="ns-search" class="ns-search-input" placeholder="Filter namespaces…" autocomplete="off">
      <div class="namespace-filters">
        ${namespaces
          .map(
            (ns) => `
          <label class="filter-check">
            <input type="checkbox" data-filter="namespace" value="${ns}" checked>
            ${ns}
          </label>`
          )
          .join('')}
      </div>
    </div>

    <div class="filter-section">
      <h3>Layout</h3>
      <select id="layout-select">
        <option value="fcose" selected>Force-directed (fcose)</option>
        <option value="cose">CoSE (fallback)</option>
      </select>
    </div>
  `;
}

function bindEvents() {
  filtersEl.addEventListener('change', (e) => {
    const target = e.target;

    if (target.id === 'filter-external') {
      toggleExternal(target.checked);
      return;
    }

    if (target.id === 'layout-select') {
      emit('layout:run', target.value);
      return;
    }

    if (target.dataset.filter) {
      applyFilters();
    }
  });

  filtersEl.addEventListener('click', (e) => {
    const target = e.target;

    if (target.id === 'ns-select-all' || target.id === 'ns-deselect-all') {
      const checked = target.id === 'ns-select-all';
      filtersEl
        .querySelectorAll('input[data-filter="namespace"]')
        .forEach((cb) => { cb.checked = checked; });
      applyFilters();
    }
  });

  filtersEl.addEventListener('input', (e) => {
    if (e.target.id === 'ns-search') {
      const query = e.target.value.trim().toLowerCase();
      filtersEl.querySelectorAll('.namespace-filters .filter-check').forEach((label) => {
        const ns = label.querySelector('input').value.toLowerCase();
        label.style.display = ns.includes(query) ? '' : 'none';
      });
    }
  });
}

function toggleExternal(show) {
  const cy = state.cy;
  if (!cy) return;
  cy.startBatch();
  const externals = cy.nodes('[?external]');
  if (show) {
    externals.show();
  } else {
    externals.hide();
  }
  cy.endBatch();
  emit('layout:run', document.getElementById('layout-select').value);
}

function applyFilters() {
  const cy = state.cy;
  if (!cy) return;

  const activeTypes = getCheckedValues('type');
  const activeConfidences = getCheckedValues('confidence');
  const activeNamespaces = getCheckedValues('namespace');
  const showExternal = document.getElementById('filter-external').checked;

  cy.startBatch();

  // Filter nodes
  cy.nodes().forEach((node) => {
    const d = node.data();

    // Namespace folder nodes are always visible — they're navigational
    if (d.nodeType === 'namespace') {
      node.show();
      return;
    }

    const typeMatch = activeTypes.has(d.type);
    const nsMatch = activeNamespaces.has(d.namespace);
    const externalMatch = d.external ? showExternal : true;

    if (typeMatch && nsMatch && externalMatch) {
      node.show();
    } else {
      node.hide();
    }
  });

  // Filter edges by confidence and visibility of endpoints
  cy.edges().forEach((edge) => {
    const confMatch = activeConfidences.has(edge.data('confidence'));
    const srcVisible = edge.source().visible();
    const tgtVisible = edge.target().visible();

    if (confMatch && srcVisible && tgtVisible) {
      edge.show();
    } else {
      edge.hide();
    }
  });

  cy.endBatch();
  state.filtersActive = true;
  emit('filters:applied');
}

function getCheckedValues(filterName) {
  const checks = filtersEl.querySelectorAll(
    `input[data-filter="${filterName}"]:checked`
  );
  return new Set([...checks].map((c) => c.value));
}


// ── detail-panel.js ──────────────────────────────────────

let panelEl;

function initDetailPanel() {
  panelEl = document.getElementById('detail-panel');
  renderEmpty();

  on('node:selected', (nodeId) => renderNode(nodeId));
  on('edge:selected', (edgeData) => renderEdge(edgeData));
  on('selection:cleared', () => renderEmpty());
}

function renderEmpty() {
  panelEl.innerHTML = `
    <div class="detail-empty">
      <p>Click a node or edge to see details.</p>
    </div>
  `;
}

function renderNode(nodeId) {
  const data = state.data;
  if (!data) return;

  const cls = data.classes.get(nodeId);
  if (!cls) return;

  // Compute in/out edges, deduplicated by target/source
  const outEdges = deduplicateEdges(
    data.edges.filter((e) => e.source === nodeId), 'target'
  );
  const inEdges = deduplicateEdges(
    data.edges.filter((e) => e.target === nodeId), 'source'
  );

  // Check if in cycle
  const inCycle = state.cycles.some((c) => c.includes(nodeId));

  // Focus the node on the graph
  emit('focus:node', { nodeId, depth: state.focusDepth });

  panelEl.innerHTML = `
    <div class="detail-header">
      <span class="chip chip--${cls.type}">${cls.type}</span>
      ${cls.external ? '<span class="chip chip--external">external</span>' : ''}
      ${inCycle ? '<span class="chip chip--cycle">circular dep</span>' : ''}
    </div>
    <h3 class="detail-title">${cls.fqcn}</h3>
    ${cls.file ? `<p class="detail-file">${cls.file}:${cls.line}</p>` : ''}

    <div class="detail-metrics">
      <div class="metric">
        <span class="metric-value">${outEdges.length}</span>
        <span class="metric-label">Dependencies (fan-out)</span>
      </div>
      <div class="metric">
        <span class="metric-value">${inEdges.length}</span>
        <span class="metric-label">Dependants (fan-in)</span>
      </div>
    </div>

    <div class="detail-section">
      <h4>Focus depth</h4>
      <div class="depth-controls">
        <button class="btn btn--sm ${state.focusDepth === 1 ? 'btn--active' : ''}" data-depth="1">1</button>
        <button class="btn btn--sm ${state.focusDepth === 2 ? 'btn--active' : ''}" data-depth="2">2</button>
        <button class="btn btn--sm" id="btn-reset-focus">Reset view</button>
      </div>
    </div>

    ${outEdges.length > 0 ? `
    <div class="detail-section">
      <h4>Dependencies</h4>
      <ul class="detail-list">
        ${outEdges.map((e) => `
          <li class="detail-list-item" data-fqcn="${e.target}">
            <span class="edge-type">${e.type}</span>
            <span class="edge-target">${shortName(e.target)}</span>
            <span class="edge-confidence conf--${e.confidence}">${e.confidence}</span>
          </li>
        `).join('')}
      </ul>
    </div>` : ''}

    ${inEdges.length > 0 ? `
    <div class="detail-section">
      <h4>Dependants</h4>
      <ul class="detail-list">
        ${inEdges.map((e) => `
          <li class="detail-list-item" data-fqcn="${e.source}">
            <span class="edge-type">${e.type}</span>
            <span class="edge-target">${shortName(e.source)}</span>
            <span class="edge-confidence conf--${e.confidence}">${e.confidence}</span>
          </li>
        `).join('')}
      </ul>
    </div>` : ''}
  `;

  // Bind depth buttons
  panelEl.querySelectorAll('[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const depth = parseInt(btn.dataset.depth, 10);
      state.focusDepth = depth;
      emit('focus:node', { nodeId, depth });
      renderNode(nodeId);
    });
  });

  // Reset focus button
  const resetBtn = panelEl.querySelector('#btn-reset-focus');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      emit('focus:reset');
      state.focusDepth = 1;
      renderNode(nodeId);
    });
  }

  // Click on dep/dependant to navigate
  panelEl.querySelectorAll('.detail-list-item').forEach((li) => {
    li.addEventListener('click', () => {
      const fqcn = li.dataset.fqcn;
      emit('node:selected', fqcn);
    });
  });
}

function renderEdge(edgeData) {
  panelEl.innerHTML = `
    <div class="detail-header">
      <span class="chip">edge</span>
      <span class="edge-confidence conf--${edgeData.confidence}">${edgeData.confidence}</span>
    </div>
    <h3 class="detail-title">${edgeData.type}</h3>
    <p class="detail-file">${edgeData.file || 'unknown'}${edgeData.line ? ':' + edgeData.line : ''}</p>
    <div class="detail-section">
      <p><strong>From:</strong> ${edgeData.source}</p>
      <p><strong>To:</strong> ${edgeData.target}</p>
    </div>
  `;
}

function shortName(fqcn) {
  return fqcn.split('\\').pop();
}

// Merge edges that share the same key (target or source), combining their types
function deduplicateEdges(edges, key) {
  const map = new Map();
  for (const e of edges) {
    const k = e[key];
    if (map.has(k)) {
      const existing = map.get(k);
      if (!existing.type.includes(e.type)) {
        existing.type += `, ${e.type}`;
      }
    } else {
      map.set(k, { ...e });
    }
  }
  return Array.from(map.values());
}


// ── warnings-panel.js ────────────────────────────────────

let badgeEl;
let listEl;

function initWarnings(data) {
  badgeEl = document.getElementById('warnings-badge');
  listEl = document.getElementById('warnings-list');

  const total = data.warnings.length + data.cycles.length;
  updateBadge(total);
  renderList(data);

  badgeEl.addEventListener('click', () => {
    listEl.classList.toggle('visible');
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!listEl.contains(e.target) && !badgeEl.contains(e.target)) {
      listEl.classList.remove('visible');
    }
  });
}

function updateBadge(count) {
  if (count > 0) {
    badgeEl.textContent = `Warnings (${count})`;
    badgeEl.classList.add('has-warnings');
  } else {
    badgeEl.textContent = 'No warnings';
  }
}

function renderList(data) {
  const items = [];

  for (const w of data.warnings) {
    items.push(`
      <li class="warning-item">
        <span class="warning-type">${w.type}</span>
        <span class="warning-message">${w.message}</span>
        <span class="warning-location">${w.file}:${w.line}</span>
      </li>
    `);
  }

  for (const cycle of data.cycles) {
    items.push(`
      <li class="warning-item warning-item--cycle">
        <span class="warning-type">circular dependency</span>
        <span class="warning-message">${cycle.map(shortName).join(' -> ')} -> ${shortName(cycle[0])}</span>
      </li>
    `);
  }

  listEl.innerHTML = items.length
    ? `<ul class="warnings-ul">${items.join('')}</ul>`
    : '<p class="warnings-empty">No warnings detected.</p>';
}

function shortName(fqcn) {
  return fqcn.split('\\').pop();
}


// ── search.js ────────────────────────────────────────────

let inputEl;
let resultsEl;

function initSearch() {
  inputEl = document.getElementById('search-input');
  resultsEl = document.getElementById('search-results');

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
    }
  });

  // Close results on outside click
  document.addEventListener('click', (e) => {
    if (!resultsEl.contains(e.target) && e.target !== inputEl) {
      resultsEl.classList.remove('visible');
    }
  });
}

function onInput() {
  const query = inputEl.value.trim().toLowerCase();
  if (query.length < 2) {
    clearSearch();
    return;
  }

  const data = state.data;
  if (!data) return;

  const matches = [];
  for (const [fqcn, cls] of data.classes) {
    if (fqcn.toLowerCase().includes(query)) {
      matches.push({ fqcn, cls, score: scoreMatch(fqcn.toLowerCase(), query) });
    }
  }

  // Sort by relevance (shorter = more specific match)
  matches.sort((a, b) => b.score - a.score);

  // Highlight on graph
  const cy = state.cy;
  if (cy) {
    cy.nodes().removeClass('search-match');
    cy.startBatch();
    for (const m of matches.slice(0, 20)) {
      cy.getElementById(m.fqcn).addClass('search-match');
    }
    cy.endBatch();
  }

  renderResults(matches.slice(0, 15));
}

function scoreMatch(fqcn, query) {
  // Exact class name match scores highest
  const shortName = fqcn.split('\\').pop();
  if (shortName === query) return 100;
  if (shortName.startsWith(query)) return 80;
  if (shortName.includes(query)) return 60;
  if (fqcn.startsWith(query)) return 40;
  return 20;
}

function renderResults(matches) {
  if (matches.length === 0) {
    resultsEl.innerHTML = '<p class="search-empty">No results</p>';
    resultsEl.classList.add('visible');
    return;
  }

  resultsEl.innerHTML = `<ul class="search-list">${matches
    .map(
      (m) => `
      <li class="search-item" data-fqcn="${m.fqcn}">
        <span class="chip chip--${m.cls.type} chip--xs">${m.cls.type}</span>
        <span>${highlightMatch(m.fqcn, inputEl.value.trim())}</span>
      </li>`
    )
    .join('')}</ul>`;

  resultsEl.classList.add('visible');

  resultsEl.querySelectorAll('.search-item').forEach((li) => {
    li.addEventListener('click', () => {
      const fqcn = li.dataset.fqcn;
      clearSearch();

      const cy = state.cy;
      if (!cy) return;

      const node = cy.getElementById(fqcn);
      if (node && !node.empty()) {
        // Node is already in the current view
        if (!node.visible()) node.show();
        cy.animate({ center: { eles: node }, duration: 300 });
        emit('node:selected', fqcn);
      } else {
        // Node is inside a collapsed namespace — navigate to its scope
        const parts = fqcn.split('\\');
        const scopePath = parts.slice(0, -1).join('\\');
        navigateToScope(scopePath);
        // Wait for rebuild + layout, then center and select
        setTimeout(() => {
          const n = cy.getElementById(fqcn);
          if (n && !n.empty()) {
            cy.animate({ center: { eles: n }, duration: 400 });
            emit('node:selected', fqcn);
          }
        }, 600);
      }
    });
  });
}

function highlightMatch(fqcn, query) {
  const idx = fqcn.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(fqcn);
  const before = fqcn.slice(0, idx);
  const match = fqcn.slice(idx, idx + query.length);
  const after = fqcn.slice(idx + query.length);
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearSearch() {
  inputEl.value = '';
  resultsEl.classList.remove('visible');
  resultsEl.innerHTML = '';
  const cy = state.cy;
  if (cy) {
    cy.nodes().removeClass('search-match');
  }
}


// ── app.js ───────────────────────────────────────────────

async function main() {
  // Show loading state
  const loading = document.getElementById('loading');
  loading.classList.add('visible');

  try {
    const data = await loadData();

    loading.classList.remove('visible');

    // Initialize all modules
    initGraph(data);
    initFilters(data);
    initDetailPanel();
    initWarnings(data);
    initSearch();

    // Mark cycle nodes after graph is ready
    if (data.cycles.length > 0) {
      markCycleNodes(data.cycles);
    }

    // Warn if dataset is large
    if (data.meta && data.meta.node_count > 200) {
      showLargeDatasetWarning(data.meta.node_count);
    }

    // Update meta stats
    renderMeta(data.meta);

    // Show new analysis button
    const btnNew = document.getElementById('btn-new-analysis');
    btnNew.removeAttribute('hidden');
    btnNew.addEventListener('click', () => {
      sessionStorage.setItem('forceFilePicker', '1');
      location.reload();
    });
  } catch (err) {
    loading.classList.remove('visible');
    console.error('Failed to initialize app:', err);
  }
}

function renderMeta(meta) {
  const el = document.getElementById('meta-stats');
  if (!el) return;
  el.innerHTML = `
    <span>${meta.file_count} files</span>
    <span>${meta.class_count} classes</span>
    <span>${meta.node_count} nodes</span>
    <span>${meta.edge_count} edges</span>
  `;
}

function showLargeDatasetWarning(nodeCount) {
  const banner = document.getElementById('large-dataset-banner');
  if (!banner) return;
  banner.textContent = `Large dataset (${nodeCount} nodes). Use namespace filters for better performance.`;
  banner.removeAttribute('hidden');
}

main();

