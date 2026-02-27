import { emit, state } from './state.js';

/**
 * Try fetch, fallback to file picker UI.
 */
export async function loadData() {
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

/**
 * Process raw JSON: index classes, detect externals, detect cycles.
 */
function processData(raw) {
  const internalFQCNs = new Set(raw.classes.map((c) => c.fqcn));
  const classMap = new Map();

  // Index internal classes
  for (const cls of raw.classes) {
    classMap.set(cls.fqcn, {
      ...cls,
      external: false,
      namespace: getNamespaceKey(cls.fqcn, false),
    });
  }

  // Discover external nodes from edges
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

/**
 * Get namespace key: first 2 segments for internal, first segment for external.
 */
export function getNamespaceKey(fqcn, isExternal) {
  const parts = fqcn.split('\\');
  if (parts.length < 2) return parts[0];
  return isExternal ? parts[0] : parts.slice(0, 2).join('\\');
}

/**
 * Detect cycles using DFS (returns array of cycle arrays).
 */
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
