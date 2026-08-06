let appState = {
  players: [],
  filteredPlayers: [],
  updatedAt: null
};

// Jerarquía de Rangos para ordenamiento en Valorant
const RANK_ORDER = {
  'Radiant': 8000,
  'Immortal 3': 7000,
  'Immortal 2': 6000,
  'Immortal 1': 5000,
  'Ascendant 3': 4300,
  'Ascendant 2': 4200,
  'Ascendant 1': 4100,
  'Diamond 3': 3300,
  'Diamond 2': 3200,
  'Diamond 1': 3100,
  'Platinum 3': 2300,
  'Platinum 2': 2200,
  'Platinum 1': 2100,
  'Gold 3': 1300,
  'Gold 2': 1200,
  'Gold 1': 1100,
  'Silver 3': 300,
  'Silver 2': 200,
  'Silver 1': 100,
  'Bronze 3': 30,
  'Bronze 2': 20,
  'Bronze 1': 10,
  'Iron 3': 3,
  'Iron 2': 2,
  'Iron 1': 1,
  'Unranked': 0,
  'Sin Clasificar': 0
};

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('Error al consultar la API');
    const data = await res.json();

    appState.players = data.players || [];
    appState.updatedAt = data.updatedAt;

    updateLastUpdatedText(data.updatedAt);
    applyFiltersAndSort();
    setupEventListeners();
  } catch (error) {
    console.error('Error cargando leaderboard:', error);
    const tbody = document.getElementById('leaderboardBody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-red-400 font-bold">Error al cargar las estadísticas.</td></tr>`;
    }
  }
}

function calculateScore(player) {
  const baseRankScore = RANK_ORDER[player.rank] || 0;
  const rrScore = player.rr || 0;
  return baseRankScore + rrScore;
}

function updateLastUpdatedText(dateStr) {
  const el = document.getElementById('lastUpdated');
  if (!el) return;
  if (!dateStr) {
    el.textContent = 'Hace instantes';
    return;
  }
  const date = new Date(dateStr);
  el.textContent = date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
}

function setupEventListeners() {
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');

  if (searchInput) searchInput.addEventListener('input', applyFiltersAndSort);
  if (sortSelect) sortSelect.addEventListener('change', applyFiltersAndSort);
}

function applyFiltersAndSort() {
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  
  const search = searchInput ? searchInput.value.toLowerCase() : '';
  const sortBy = sortSelect ? sortSelect.value : 'rank';

  appState.filteredPlayers = appState.players.filter(p => 
    `${p.name}#${p.tag}`.toLowerCase().includes(search)
  );

  appState.filteredPlayers.sort((a, b) => {
    if (sortBy === 'kd') return (b.stats?.kd || 0) - (a.stats?.kd || 0);
    if (sortBy === 'winrate') return (b.stats?.winRate || 0) - (a.stats?.winRate || 0);
    return calculateScore(b) - calculateScore(a);
  });

  renderPodium();
  renderLeaderboardTable();
}

function renderPodium() {
  const podiumContainer = document.getElementById('podiumContainer');
  if (!podiumContainer) return;
  podiumContainer.innerHTML = '';

  const top3 = appState.filteredPlayers.slice(0, 3);

  const crownColors = [
    { border: 'border-valGold', badge: 'bg-valGold/20 text-valGold', num: '1' },
    { border: 'border-valSilver', badge: 'bg-valSilver/20 text-valSilver', num: '2' },
    { border: 'border-valBronze', badge: 'bg-valBronze/20 text-valBronze', num: '3' }
  ];

  top3.forEach((player, idx) => {
    const style = crownColors[idx];
    const card = document.createElement('div');
    card.className = `podium-card p-6 rounded-2xl relative flex flex-col justify-between border-t-2 ${style.border}`;

    const wins = player.stats?.wins || 0;
    const losses = player.stats?.losses || 0;
    const winRate = player.stats?.winRate || 0;

    const cardImg = player.cardImage || 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=100&q=80';

    card.innerHTML = `
      <div class="absolute -top-3 right-4 ${style.badge} font-black px-3 py-0.5 rounded-full text-xs border border-white/10">
        TOP #${style.num}
      </div>

      <div>
        <div class="flex items-center space-x-4 mb-4">
          <img src="${cardImg}" class="w-12 h-12 rounded-xl object-cover border border-white/20 bg-gray-800">
          <div>
            <h3 class="text-xl font-black text-white leading-tight">${player.name}</h3>
            <div class="text-xs text-gray-400">#${player.tag}</div>
          </div>
        </div>

        <div class="flex items-center space-x-3 bg-black/40 p-3 rounded-xl mb-4 border border-white/5">
          ${player.rankImage ? `<img src="${player.rankImage}" class="w-10 h-10">` : '<div class="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center text-xs font-bold text-gray-400">?</div>'}
          <div>
            <div class="text-sm font-extrabold text-white">${player.rank}</div>
            <div class="text-xs text-valRed font-bold">${player.rr} LP / RR</div>
          </div>
        </div>
      </div>

      <div>
        <div class="flex justify-between text-xs font-bold mb-1.5">
          <span class="text-green-400">${wins}W</span>
          <span class="text-white font-extrabold">${winRate}% WR</span>
          <span class="text-red-400">${losses}L</span>
        </div>
        <div class="w-full bg-red-500/30 h-2 rounded-full overflow-hidden flex">
          <div class="bg-green-500 h-full" style="width: ${winRate}%"></div>
        </div>
      </div>
    `;
    podiumContainer.appendChild(card);
  });
}

function renderLeaderboardTable() {
  const tbody = document.getElementById('leaderboardBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!appState.filteredPlayers.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-gray-500">No hay participantes cargados</td></tr>`;
    return;
  }

  appState.filteredPlayers.forEach((player, index) => {
    const tr = document.createElement('tr');
    tr.className = "hover:bg-valCardHover/50 transition duration-150 border-b border-white/5";

    const wins = player.stats?.wins || 0;
    const losses = player.stats?.losses || 0;
    const winRate = player.stats?.winRate || 0;

    const streakHTML = player.matches && player.matches.length ? player.matches.slice(0, 5).map(m => {
      const isWin = m.result === 'Victoria';
      return `<span class="inline-block w-2.5 h-6 rounded-sm ${isWin ? 'bg-green-500' : 'bg-red-500'}" title="${m.map} - ${m.kills}/${m.deaths}/${m.assists}"></span>`;
    }).join('') : '<span class="text-xs text-gray-600">-</span>';

    const cardImg = player.cardImage || 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=100&q=80';

    tr.innerHTML = `
      <td class="py-4 px-4 text-center font-black ${index < 3 ? 'text-valRed text-base' : 'text-gray-400'}">
        ${index + 1}
      </td>
      <td class="py-4 px-4">
        <div class="flex items-center space-x-3">
          <img src="${cardImg}" class="w-9 h-9 rounded-lg object-cover border border-white/10 bg-gray-800">
          <div>
            <div class="font-bold text-white leading-tight">${player.name}</div>
            <div class="text-[11px] text-gray-400">#${player.tag}</div>
          </div>
        </div>
      </td>
      <td class="py-4 px-4">
        <div class="flex items-center space-x-2">
          ${player.rankImage ? `<img src="${player.rankImage}" class="w-7 h-7">` : ''}
          <div>
            <div class="text-xs font-bold text-white">${player.rank}</div>
            <div class="text-[10px] text-valRed font-semibold">${player.rr} RR</div>
          </div>
        </div>
      </td>
      <td class="py-4 px-4">
        <div class="w-48">
          <div class="flex justify-between text-[11px] font-bold mb-1">
            <span class="text-green-400">${wins}W <span class="text-gray-400 text-[10px]">(${winRate}%)</span></span>
            <span class="text-red-400">${losses}L</span>
          </div>
          <div class="w-full bg-red-500/40 h-1.5 rounded-full overflow-hidden flex">
            <div class="bg-green-500 h-full" style="width: ${winRate}%"></div>
          </div>
        </div>
      </td>
      <td class="py-4 px-4 text-center font-bold ${player.stats?.kd >= 1 ? 'text-green-400' : 'text-red-400'}">
        ${player.stats?.kd || '0.0'}
      </td>
      <td class="py-4 px-4 text-center font-bold text-valAccent">
        ${player.stats?.headshotPct || 0}%
      </td>
      <td class="py-4 px-4">
        <div class="flex items-center justify-center space-x-1">
          ${streakHTML}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}
