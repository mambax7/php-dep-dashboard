// ============================================================
// app.bundle.js — Single-file build, no ES modules required.
// Works with file:// protocol (no server needed).
// ============================================================

// ── state.js ─────────────────────────────────────────────────
const bus = new EventTarget();

function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

function on(name, handler) {
  bus.addEventListener(name, (e) => handler(e.detail));
}

const state = {
  data: null,
  cy: null,
  cycles: [],
  selectedNode: null,
  focusDepth: 1,
  filtersActive: false,
};

// ── data-loader.js ───────────────────────────────────────────
async function loadData() {
  if (sessionStorage.getItem('forceFilePicker')) {
    sessionStorage.removeItem('forceFilePicker');
    return waitForFilePicker();
  }
  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    return processData(data);
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
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          hideDropZone();
          resolve(processData(data));
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

function processData(raw) {
  const internalFQCNs = new Set(raw.classes.map((c) => c.fqcn));
  const classMap = new Map();

  for (const cls of raw.classes) {
    classMap.set(cls.fqcn, {
      ...cls,
      external: false,
      namespace: getNamespaceKey(cls.fqcn, false),
    });
  }

  for (const edge of raw.edges) {
    for (const fqcn of [edge.source, edge.target]) {
      if (!classMap.has(fqcn)) {
        classMap.set(fqcn, {
          fqcn,
          type: 'class',
          file: null,
          line: null,
          dependencies: [],
          dependants: [],
          external: true,
          namespace: getNamespaceKey(fqcn, true),
        });
      }
    }
  }

  const cycles = detectCycles(raw.edges);

  const processed = {
    meta: raw.meta,
    classes: classMap,
    edges: raw.edges,
    warnings: raw.warnings || [],
    cycles,
  };

  state.data = processed;
  state.cycles = cycles;
  emit('data:loaded', processed);

  if (raw.meta.node_count > 200) {
    const banner = document.getElementById('large-dataset-banner');
    banner.textContent = `Large dataset (${raw.meta.node_count} nodes). Use namespace filters for better performance.`;
    banner.removeAttribute('hidden');
  }

  return processed;
}

function getNamespaceKey(fqcn, isExternal) {
  const parts = fqcn.split('\\');
  if (parts.length < 2) return parts[0];
  return isExternal ? parts[0] : parts.slice(0, 2).join('\\');
}

function detectCycles(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }

  const visited = new Set();
  const inStack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor, path);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

// ── graph-renderer.js ────────────────────────────────────────
let cy = null;

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
  const elements = buildElements(data);

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

  cy.nodes('[?external]').hide();

  cy.ready(() => runLayout('fcose'));

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    emit('node:selected', node.id());
  });

  cy.on('tap', 'edge', (evt) => {
    const edge = evt.target;
    emit('edge:selected', {
      source: edge.data('source'),
      target: edge.data('target'),
      type: edge.data('edgeType'),
      confidence: edge.data('confidence'),
      file: edge.data('file'),
      line: edge.data('line'),
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
    node.connectedEdges().forEach((edge) => {
      if (edge.source().id() === node.id()) {
        edge.addClass('edge-out');
      } else {
        edge.addClass('edge-in');
      }
    });
  });

  cy.on('mouseout', 'node', () => {
    cy.edges().removeClass('edge-out edge-in');
  });

  on('focus:node', ({ nodeId, depth }) => focusNode(nodeId, depth));
  on('focus:reset', () => resetFocus());
  on('layout:run', (name) => runLayout(name));

  emit('graph:ready', cy);
}

function buildElements(data) {
  const nodes = [];
  const edges = [];

  for (const [fqcn, cls] of data.classes) {
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

  for (let i = 0; i < data.edges.length; i++) {
    const e = data.edges[i];
    edges.push({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        edgeType: e.type,
        confidence: e.confidence,
        file: e.file,
        line: e.line,
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
        width: 1,
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
        width: s.width,
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
  ];
}

function runLayout(name) {
  if (!cy) return;

  const options =
    name === 'fcose'
      ? {
          name: 'fcose',
          animate: true,
          animationDuration: 500,
          fit: true,
          padding: 40,
          quality: 'default',
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
          edgeElasticity: 0.45,
          gravity: 0.25,
          gravityRange: 3.8,
          numIter: 2500,
          tile: true,
          packComponents: true,
        }
      : {
          name: 'cose',
          animate: true,
          animationDuration: 500,
          fit: true,
          padding: 40,
          nodeDimensionsIncludeLabels: true,
          idealEdgeLength: 120,
          nodeRepulsion: 8000,
        };

  const visibleEles = cy.elements(':visible');
  if (visibleEles.length === 0) return;

  try {
    visibleEles.layout(options).run();
  } catch (e) {
    console.warn('Layout "' + name + '" failed, falling back to cose:', e.message);
    visibleEles.layout({ name: 'cose', animate: true, fit: true, padding: 40 }).run();
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

// ── filter-manager.js ────────────────────────────────────────
let filtersEl;
let namespaces = [];

function initFilters(data) {
  filtersEl = document.getElementById('filters');
  namespaces = collectNamespaces(data);
  renderFilters(data);
  bindFilterEvents();
  on('data:loaded', (d) => {
    namespaces = collectNamespaces(d);
    renderFilters(d);
  });
}

function collectNamespaces(data) {
  const nsSet = new Set();
  for (const [, cls] of data.classes) {
    nsSet.add(cls.namespace);
  }
  return [...nsSet].sort();
}

function renderFilters(data) {
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

function bindFilterEvents() {
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
}

function toggleExternal(show) {
  if (!state.cy) return;
  state.cy.startBatch();
  const externals = state.cy.nodes('[?external]');
  if (show) {
    externals.show();
  } else {
    externals.hide();
  }
  state.cy.endBatch();
  emit('layout:run', document.getElementById('layout-select').value);
}

function applyFilters() {
  if (!state.cy) return;

  const activeTypes = getCheckedValues('type');
  const activeConfidences = getCheckedValues('confidence');
  const activeNamespaces = getCheckedValues('namespace');
  const showExternal = document.getElementById('filter-external').checked;

  state.cy.startBatch();

  state.cy.nodes().forEach((node) => {
    const d = node.data();
    const typeMatch = activeTypes.has(d.type);
    const nsMatch = activeNamespaces.has(d.namespace);
    const externalMatch = d.external ? showExternal : true;

    if (typeMatch && nsMatch && externalMatch) {
      node.show();
    } else {
      node.hide();
    }
  });

  state.cy.edges().forEach((edge) => {
    const confMatch = activeConfidences.has(edge.data('confidence'));
    const srcVisible = edge.source().visible();
    const tgtVisible = edge.target().visible();

    if (confMatch && srcVisible && tgtVisible) {
      edge.show();
    } else {
      edge.hide();
    }
  });

  state.cy.endBatch();
  state.filtersActive = true;
  emit('filters:applied');
}

function getCheckedValues(filterName) {
  const checks = filtersEl.querySelectorAll(
    `input[data-filter="${filterName}"]:checked`
  );
  return new Set([...checks].map((c) => c.value));
}

// ── detail-panel.js ──────────────────────────────────────────
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

  const outEdges = data.edges.filter((e) => e.source === nodeId);
  const inEdges = data.edges.filter((e) => e.target === nodeId);

  const inCycle = state.cycles.some((c) => c.includes(nodeId));

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
            <span class="edge-target">${panelShortName(e.target)}</span>
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
            <span class="edge-target">${panelShortName(e.source)}</span>
            <span class="edge-confidence conf--${e.confidence}">${e.confidence}</span>
          </li>
        `).join('')}
      </ul>
    </div>` : ''}
  `;

  panelEl.querySelectorAll('[data-depth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const depth = parseInt(btn.dataset.depth, 10);
      state.focusDepth = depth;
      emit('focus:node', { nodeId, depth });
      renderNode(nodeId);
    });
  });

  const resetBtn = panelEl.querySelector('#btn-reset-focus');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      emit('focus:reset');
      state.focusDepth = 1;
      renderNode(nodeId);
    });
  }

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

function panelShortName(fqcn) {
  return fqcn.split('\\').pop();
}

// ── warnings-panel.js ────────────────────────────────────────
let badgeEl;
let listEl;

function initWarnings(data) {
  badgeEl = document.getElementById('warnings-badge');
  listEl = document.getElementById('warnings-list');

  const total = data.warnings.length + data.cycles.length;
  updateBadge(total);
  renderWarningsList(data);

  badgeEl.addEventListener('click', () => {
    listEl.classList.toggle('visible');
  });

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

function renderWarningsList(data) {
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
        <span class="warning-message">${cycle.map(warningShortName).join(' -> ')} -> ${warningShortName(cycle[0])}</span>
      </li>
    `);
  }

  listEl.innerHTML = items.length
    ? `<ul class="warnings-ul">${items.join('')}</ul>`
    : '<p class="warnings-empty">No warnings detected.</p>';
}

function warningShortName(fqcn) {
  return fqcn.split('\\').pop();
}

// ── search.js ────────────────────────────────────────────────
let searchInputEl;
let searchResultsEl;

function initSearch() {
  searchInputEl = document.getElementById('search-input');
  searchResultsEl = document.getElementById('search-results');

  searchInputEl.addEventListener('input', onSearchInput);
  searchInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearch();
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchResultsEl.contains(e.target) && e.target !== searchInputEl) {
      searchResultsEl.classList.remove('visible');
    }
  });
}

function onSearchInput() {
  const query = searchInputEl.value.trim().toLowerCase();
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

  matches.sort((a, b) => b.score - a.score);

  if (state.cy) {
    state.cy.nodes().removeClass('search-match');
    state.cy.startBatch();
    for (const m of matches.slice(0, 20)) {
      state.cy.getElementById(m.fqcn).addClass('search-match');
    }
    state.cy.endBatch();
  }

  renderSearchResults(matches.slice(0, 15));
}

function scoreMatch(fqcn, query) {
  const shortName = fqcn.split('\\').pop();
  if (shortName === query) return 100;
  if (shortName.startsWith(query)) return 80;
  if (shortName.includes(query)) return 60;
  if (fqcn.startsWith(query)) return 40;
  return 20;
}

function renderSearchResults(matches) {
  if (matches.length === 0) {
    searchResultsEl.innerHTML = '<p class="search-empty">No results</p>';
    searchResultsEl.classList.add('visible');
    return;
  }

  searchResultsEl.innerHTML = `<ul class="search-list">${matches
    .map(
      (m) => `
      <li class="search-item" data-fqcn="${m.fqcn}">
        <span class="chip chip--${m.cls.type} chip--xs">${m.cls.type}</span>
        <span>${highlightMatch(m.fqcn, searchInputEl.value.trim())}</span>
      </li>`
    )
    .join('')}</ul>`;

  searchResultsEl.classList.add('visible');

  searchResultsEl.querySelectorAll('.search-item').forEach((li) => {
    li.addEventListener('click', () => {
      const fqcn = li.dataset.fqcn;
      emit('node:selected', fqcn);
      clearSearch();

      if (state.cy) {
        const node = state.cy.getElementById(fqcn);
        if (node && !node.empty()) {
          if (!node.visible()) node.show();
          state.cy.animate({ center: { eles: node }, duration: 300 });
        }
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
  searchInputEl.value = '';
  searchResultsEl.classList.remove('visible');
  searchResultsEl.innerHTML = '';
  if (state.cy) {
    state.cy.nodes().removeClass('search-match');
  }
}

// ── app.js ───────────────────────────────────────────────────
async function main() {
  const loading = document.getElementById('loading');
  loading.classList.add('visible');

  try {
    const data = await loadData();

    loading.classList.remove('visible');

    initGraph(data);
    initFilters(data);
    initDetailPanel();
    initWarnings(data);
    initSearch();

    if (data.cycles.length > 0) {
      markCycleNodes(data.cycles);
    }

    if (data.meta && data.meta.node_count > 200) {
      showLargeDatasetWarning(data.meta.node_count);
    }

    renderMeta(data.meta);

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
