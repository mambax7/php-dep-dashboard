import { emit, on, state } from './state.js';
import { getNamespaceKey } from './data-loader.js';

let filtersEl;
let namespaces = [];

export function initFilters(data) {
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
