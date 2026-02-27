import { loadData } from './modules/data-loader.js';
import { initGraph, markCycleNodes } from './modules/graph-renderer.js';
import { initFilters } from './modules/filter-manager.js';
import { initDetailPanel } from './modules/detail-panel.js';
import { initWarnings } from './modules/warnings-panel.js';
import { initSearch } from './modules/search.js';

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
