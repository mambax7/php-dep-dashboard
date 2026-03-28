import { emit, on, state } from './state.js';

let panelEl;

export function initDetailPanel() {
  panelEl = document.getElementById('detail-panel');
  renderEmpty();

  on('node:selected', (nodeId) => renderNode(nodeId));
  on('edge:selected', (edgeData) => renderEdge(edgeData));
  on('namespace:selected', (nodeData) => renderNamespace(nodeData));
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
    ${cls.instability !== null && cls.instability !== undefined ? renderInstability(cls.instability) : ''}

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

function renderNamespace(nodeData) {
  const cy = state.cy;
  const node = cy ? cy.getElementById(nodeData.id) : null;

  // Collect outgoing / incoming namespace edges from the live graph
  const outEdges = [];
  const inEdges = [];
  if (node && !node.empty()) {
    node.connectedEdges().forEach((edge) => {
      const d = edge.data();
      if (edge.source().id() === nodeData.id) outEdges.push(d);
      else inEdges.push(d);
    });
  }

  const instabilityHtml = nodeData.instability !== null && nodeData.instability !== undefined
    ? renderInstability(nodeData.instability)
    : '';

  const nsPath = nodeData.nsPath || '';
  const parentPath = nsPath.includes('\\') ? nsPath.split('\\').slice(0, -1).join('\\') : '';

  const makeEdgeList = (edges, dirKey, dirLabel) => {
    if (!edges.length) return '';
    return `
      <div class="detail-section">
        <h4>${dirLabel}</h4>
        <ul class="detail-list">
          ${edges.map((e) => `
            <li class="detail-list-item detail-list-item--static">
              <span class="edge-badge">${e.weight || 1}</span>
              <span class="edge-target">${shortNs(e[dirKey])}</span>
              <span class="edge-confidence conf--${e.confidence}">${e.confidence}</span>
            </li>
          `).join('')}
        </ul>
      </div>`;
  };

  panelEl.innerHTML = `
    <div class="detail-header">
      <span class="chip chip--namespace">namespace</span>
      ${nodeData.hasCycle ? '<span class="chip chip--cycle">circular dep</span>' : ''}
    </div>
    <h3 class="detail-title">${shortNs(nsPath)}</h3>
    ${parentPath ? `<p class="detail-file">${parentPath}</p>` : ''}

    <div class="detail-metrics detail-metrics--3">
      <div class="metric">
        <span class="metric-value">${nodeData.classCount || 0}</span>
        <span class="metric-label">Classes</span>
      </div>
      <div class="metric">
        <span class="metric-value">${nodeData.fanOut || 0}</span>
        <span class="metric-label">Fan-out (Ce)</span>
      </div>
      <div class="metric">
        <span class="metric-value">${nodeData.fanIn || 0}</span>
        <span class="metric-label">Fan-in (Ca)</span>
      </div>
    </div>

    ${instabilityHtml}

    <div class="detail-section">
      <button class="btn btn--primary btn--full" id="btn-drilldown">
        Drill down into namespace →
      </button>
    </div>

    ${makeEdgeList(outEdges, 'target', 'Depends on')}
    ${makeEdgeList(inEdges, 'source', 'Depended by')}
  `;

  panelEl.querySelector('#btn-drilldown').addEventListener('click', () => {
    emit('namespace:navigate', nsPath);
  });
}

function shortNs(nsPath) {
  if (!nsPath) return '';
  const parts = nsPath.replace(/^ns::/, '').split('\\');
  return parts[parts.length - 1];
}

function renderEdge(edgeData) {
  const isAggregated = edgeData.weight > 1;
  const entriesList = isAggregated && edgeData.entries ? `
    <div class="detail-section">
      <h4>${edgeData.weight} dependencies</h4>
      <ul class="detail-list">
        ${edgeData.entries.map((e) => `
          <li class="detail-list-item detail-list-item--static">
            <span class="edge-type">${e.type}</span>
            <span class="edge-target">${shortName(e.source)} → ${shortName(e.target)}</span>
            <span class="edge-confidence conf--${e.confidence}">${e.confidence}</span>
          </li>
        `).join('')}
      </ul>
    </div>` : '';

  panelEl.innerHTML = `
    <div class="detail-header">
      <span class="chip">edge</span>
      <span class="edge-confidence conf--${edgeData.confidence}">${edgeData.confidence}</span>
      ${isAggregated ? `<span class="chip chip--weight">${edgeData.weight} deps</span>` : ''}
    </div>
    <div class="detail-section">
      <p><strong>From:</strong> ${edgeData.source}</p>
      <p><strong>To:</strong> ${edgeData.target}</p>
    </div>
    ${entriesList}
  `;
}

function renderInstability(value) {
  const pct = Math.round(value * 100);
  const color = value < 0.33 ? '#22C55E' : value < 0.67 ? '#F59E0B' : '#EF4444';
  const label = value < 0.33 ? 'Stable' : value < 0.67 ? 'Balanced' : 'Unstable';
  return `
    <div class="detail-instability">
      <div class="instability-header">
        <span class="instability-label">Instability (I)</span>
        <span class="instability-value" style="color:${color}">${value.toFixed(2)} — ${label}</span>
      </div>
      <div class="instability-bar-bg">
        <div class="instability-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <p class="instability-hint">I = Ce / (Ca + Ce) &nbsp;·&nbsp; 0 = stable, 1 = instable</p>
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
