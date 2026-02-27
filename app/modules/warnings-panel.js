import { on, state } from './state.js';

let badgeEl;
let listEl;

export function initWarnings(data) {
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
