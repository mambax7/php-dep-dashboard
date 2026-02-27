import { emit, on, state } from './state.js';

let panelEl;

export function initDetailPanel() {
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

  // Compute in/out edges
  const outEdges = data.edges.filter((e) => e.source === nodeId);
  const inEdges = data.edges.filter((e) => e.target === nodeId);

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
