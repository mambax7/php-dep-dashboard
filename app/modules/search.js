import { emit, on, state } from './state.js';
import { navigateToScope } from './namespace-browser.js';

let inputEl;
let resultsEl;

export function initSearch() {
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
