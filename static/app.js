// ===== State =====
const state = {
    activeTab: 'browse',
    theme: localStorage.getItem('glitchi-theme') || 'dark',
    searchTimeout: null,
    devMode: localStorage.getItem('glitchi-dev') === 'true',
    debugMode: localStorage.getItem('glitchi-debug') === 'true',
    showApiLog: localStorage.getItem('glitchi-api-log') === 'true',
    defaultQuality: localStorage.getItem('glitchi-quality') || 'LOSSLESS',
    defaultDownloader: localStorage.getItem('glitchi-downloader') || 'spotiflac',
    playlists: JSON.parse(localStorage.getItem('glitchi-playlists') || '[]'),
    downloadedFiles: JSON.parse(localStorage.getItem('glitchi-downloaded-files') || '[]'),
    searchHistory: JSON.parse(localStorage.getItem('glitchi-search-history') || '[]'),
    detailItem: null,
    currentAudio: null,
    playerTrack: null,
    librarySegment: 'files',     // 'files' | 'playlists'
    browseCategories: [],       // loaded from API
    nowPlayingOpen: false,
    adminKey: 'glitchi-admin-2024',
};

// ===== Logger (dev mode) =====
const devLogs = [];
function devLog(msg, data) {
    const ts = new Date().toISOString().split('T')[1].slice(0, 12);
    const entry = `[${ts}] ${msg}` + (data !== undefined ? ' ' + JSON.stringify(data) : '');
    devLogs.push(entry);
    if (devLogs.length > 200) devLogs.shift();
    if (state.devMode) {
        const el = document.getElementById('dev-logs-content');
        if (el) el.textContent = devLogs.slice(-50).join('\n');
    }
    if (state.debugMode) console.log('[Glitchi]', msg, data);
}

// ===== Device Detection =====
function detectDevice() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const html = document.documentElement;
    if (/android/i.test(ua)) html.setAttribute('data-platform', 'android');
    else if (/iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) html.setAttribute('data-platform', 'ios');
    else if (/windows/i.test(ua) || /win/i.test(platform)) html.setAttribute('data-platform', 'windows');
    else if (/mac/i.test(platform) || /macintosh/i.test(ua)) html.setAttribute('data-platform', 'mac');
    else if (/linux/i.test(platform)) html.setAttribute('data-platform', 'linux');
    else html.setAttribute('data-platform', 'other');

    const isMobile = /android|iphone|ipad|ipod|webos|blackberry|iemobile|opera mini/i.test(ua)
        || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        || (window.innerWidth <= 768);
    html.setAttribute('data-mobile', isMobile ? 'true' : 'false');
    html.setAttribute('data-touch', ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 'true' : 'false');
    devLog('Device detected', { platform: html.getAttribute('data-platform'), mobile: isMobile });
    return isMobile;
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    detectDevice();
    applyTheme(state.theme);
    document.getElementById('settings-theme').value = state.theme;
    document.getElementById('settings-quality').value = state.defaultQuality;
    document.getElementById('settings-downloader').value = state.defaultDownloader;
    setupNavigation();
    setupBrowse();
    setupSearch();
    setupLibrary();
    setupFiles();
    setupDownload();
    setupThemeSwitcher();
    setupFilterChips();
    setupFileCardDelegation();
    setupResultCardDelegation();
    setupModals();
    setupSettings();
    setupPlaylists();
    setupSearchHistory();
    setupNowPlaying();
    fetchAvailableDownloaders();
    openTab(state.activeTab);
    loadFiles();
    renderPlaylists();
    resumeActiveDownloads();
    if (state.devMode) unlockDevUI();
    devLog('App initialized', { theme: state.theme, devMode: state.devMode });
});

// ===== Theme =====
function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    state.theme = name;
    localStorage.setItem('glitchi-theme', name);
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === name));
    const sel = document.getElementById('settings-theme');
    if (sel) sel.value = name;
}

function setupThemeSwitcher() {
    document.querySelectorAll('.theme-btn').forEach(btn => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));
}

// ===== Navigation (Desktop sidebar + Mobile tab bar) =====
function setupNavigation() {
    const allNavItems = document.querySelectorAll('.nav-item[data-tab], .mobile-tab[data-tab]');
    allNavItems.forEach(item => item.addEventListener('click', () => openTab(item.dataset.tab)));
}

function openTab(name) {
    state.activeTab = name;
    // Update sidebar nav
    document.querySelectorAll('.nav-item[data-tab]').forEach(i => i.classList.toggle('active', i.dataset.tab === name));
    // Update mobile tabs
    document.querySelectorAll('.mobile-tab[data-tab]').forEach(i => i.classList.toggle('active', i.dataset.tab === name));
    // Show/hide tab content
    document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id === `tab-${name}`));
    if (name === 'browse' && state.browseCategories.length === 0) loadBrowseContent();
    if (name === 'search') document.getElementById('search-input')?.focus();
    if (name === 'library') { loadFiles(); renderPlaylists(); }
    if (name === 'download') {
        const sel = document.getElementById('download-quality');
        if (sel) sel.value = state.defaultQuality;
    }
}

// ===== Browse Tab =====
let _pendingGenreRequest = null; // abort stale requests on rapid chip switching

function setupBrowse() {
    // Event delegation for cards rendered in browse filtered results
    document.getElementById('browse-filtered-content').addEventListener('click', handleBrowseCardClick);
}

function handleBrowseCardClick(e) {
    const card = e.target.closest('.card, .artist-item');
    if (!card) return;
    if (e.target.closest('.track-dl')) return;
    const itemType = card.dataset.type;
    const url = card.dataset.url;
    const id = card.dataset.id || url?.split('/').pop();
    const name = card.dataset.title || card.querySelector('.card-title')?.textContent || '';
    const artists = card.dataset.artist || card.querySelector('.card-subtitle')?.textContent || '';
    const cover = card.dataset.cover || card.querySelector('.card-cover')?.src || '';
    const tracksCount = card.dataset.tracks || '';
    openDetailView({ type: itemType, id, name, artists, cover, url, tracksCount });
}

async function loadBrowseContent() {
    const categories = await fetchCategories();
    renderGenreChips(categories);
    await Promise.all([
        fetchFeatured(),
        fetchNewReleases(),
        fetchTrending(),
    ]);
}

async function fetchCategories() {
    try {
        const res = await fetch('/browse/categories');
        if (!res.ok) throw new Error('Failed to load categories');
        const data = await res.json();
        state.browseCategories = data.categories || [];
        return state.browseCategories;
    } catch (e) {
        devLog('Browse categories error', { error: e.message });
        return [];
    }
}

function renderGenreChips(categories) {
    const scroll = document.getElementById('browse-filters-scroll');
    scroll.innerHTML = categories.map(cat =>
        `<button class="genre-chip" data-genre="${escapeHtml(cat.id)}" style="--genre-color: ${escapeHtml(cat.color)}">${escapeHtml(cat.name)}</button>`
    ).join('');

    // Click handlers for genre chips
    const allChips = document.querySelectorAll('#browse-filters .genre-chip');
    allChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const genre = chip.dataset.genre;
            // Update active state on all chips
            allChips.forEach(c => c.classList.toggle('active', c.dataset.genre === genre));
            if (genre) {
                applyGenreFilter(genre);
            } else {
                clearGenreFilter();
            }
        });
    });
}

async function applyGenreFilter(genreId) {
    const cat = state.browseCategories.find(c => c.id === genreId);
    const genreName = cat?.name || genreId;
    devLog('Genre filter applied', { genreId, genreName });

    // Hide default browse content, show filtered area
    document.getElementById('browse-content').classList.add('hidden');
    const filtered = document.getElementById('browse-filtered');
    filtered.classList.remove('hidden');
    document.getElementById('browse-filtered-title').textContent = genreName;
    const content = document.getElementById('browse-filtered-content');
    content.innerHTML = '<div class="spinner"></div>';

    try {
        // Race-condition guard: only honor the most recently requested genre
        const requestId = Symbol();
        _pendingGenreRequest = requestId;
        const res = await fetch(`/browse/category/${encodeURIComponent(genreId)}?limit=30`);
        if (_pendingGenreRequest !== requestId) return; // stale request, discard
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        let html = '';
        if (data.playlists && data.playlists.length > 0) {
            html += '<h3 style="margin-bottom:12px;font-size:15px;color:var(--text-secondary)">Playlists</h3>';
            html += '<div class="results-grid" style="margin-bottom:24px">';
            data.playlists.forEach(pl => {
                const imgHtml = pl.image_url
                    ? `<img src="${escapeHtml(pl.image_url)}" class="card-cover" loading="lazy" onerror="this.style.display='none'">`
                    : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
                html += `<div class="card" data-type="playlist" data-id="${escapeHtml(pl.id)}" data-title="${escapeHtml(pl.name)}" data-artist="${escapeHtml(pl.owner)}" data-cover="${escapeHtml(pl.image_url)}" data-url="${escapeHtml(pl.url)}" data-tracks="${pl.tracks_count}">
                    ${imgHtml}
                    <div class="card-title">${escapeHtml(pl.name)}</div>
                    <div class="card-subtitle">By ${escapeHtml(pl.owner)}</div>
                    <div class="card-meta">${pl.tracks_count} tracks</div>
                </div>`;
            });
            html += '</div>';
        }
        if (data.tracks && data.tracks.length > 0) {
            html += '<h3 style="margin-bottom:12px;font-size:15px;color:var(--text-secondary)">Tracks</h3>';
            html += '<div class="track-list">';
            data.tracks.forEach((t, i) => {
                const img = t.album_image_url ? `<img class="track-cover" src="${escapeHtml(t.album_image_url)}" onerror="this.remove()">` : '';
                html += `<div class="track-row" data-url="${escapeHtml(t.url)}" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.album_image_url)}">
                    <span class="track-num">${i+1}</span>
                    ${img}
                    <div class="track-info">
                        <div class="track-name">${escapeHtml(t.name)}</div>
                        <div class="track-artist">${escapeHtml(t.artists)}</div>
                    </div>
                    <span class="track-duration">${formatDuration(t.duration_ms)}</span>
                    <button class="track-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>`;
            });
            html += '</div>';
        }
        if (!data.playlists?.length && !data.tracks?.length) {
            html = '<p style="color:var(--text-tertiary);padding:16px">No results for this genre</p>';
        }
        content.innerHTML = html;
        // Download handlers for track rows
        content.querySelectorAll('.track-row').forEach(row => {
            const dl = row.querySelector('.track-dl');
            if (dl) dl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name);
            });
            row.addEventListener('click', (e) => {
                if (e.target.closest('.track-dl')) return;
                if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name);
            });
        });
    } catch (e) {
        devLog('Genre filter error', { genreId, error: e.message });
        content.innerHTML = '<p style="color:#ef4444;padding:16px">Failed to load</p>';
    }
}

function clearGenreFilter() {
    _pendingGenreRequest = null;
    document.getElementById('browse-content').classList.remove('hidden');
    document.getElementById('browse-filtered').classList.add('hidden');
    document.getElementById('browse-filtered-content').innerHTML = '';
}

async function fetchFeatured() {
    const container = document.getElementById('browse-featured');
    try {
        const res = await fetch('/browse/featured?limit=12');
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const items = [...(data.playlists || []), ...(data.tracks || [])].slice(0, 12);
        renderHScrollCards(container, items, 'playlist');
    } catch (e) {
        container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">Failed to load</p>';
    }
}

async function fetchNewReleases() {
    const container = document.getElementById('browse-new-releases');
    try {
        const res = await fetch('/browse/new-releases?limit=12');
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const items = [...(data.albums || []), ...(data.tracks || [])].slice(0, 12);
        renderHScrollCards(container, items, 'album');
    } catch (e) {
        container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">Failed to load</p>';
    }
}

async function fetchTrending() {
    const container = document.getElementById('browse-trending');
    try {
        const res = await fetch('/browse/trending?limit=12');
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        renderHScrollCards(container, data.tracks || [], 'track');
    } catch (e) {
        container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">Failed to load</p>';
    }
}

function renderHScrollCards(container, items, defaultType) {
    if (!items.length) {
        container.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">Nothing here yet</p>';
        return;
    }
    container.innerHTML = items.map(item => {
        const imgUrl = item.image_url || item.album_image_url || '';
        const title = item.name || '';
        const subtitle = item.artists || item.owner || item.album || '';
        const itemType = item.type || defaultType;
        const imgHtml = imgUrl
            ? `<img src="${escapeHtml(imgUrl)}" class="h-card-cover" loading="lazy" onerror="this.style.display='none'">`
            : '<div class="h-card-cover" style="display:flex;align-items:center;justify-content:center;background:var(--bg-cover-placeholder)"><svg viewBox="0 0 24 24" fill="none" style="width:32px;height:32px;color:var(--text-tertiary)"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg></div>';
        return `<div class="h-card" data-type="${escapeHtml(itemType)}" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(title)}" data-artist="${escapeHtml(subtitle)}" data-cover="${escapeHtml(imgUrl)}" data-url="${escapeHtml(item.url)}">
            ${imgHtml}
            <div class="h-card-title">${escapeHtml(title)}</div>
            <div class="h-card-subtitle">${escapeHtml(subtitle)}</div>
        </div>`;
    }).join('');

    // Click handlers for h-cards → open detail view
    container.querySelectorAll('.h-card').forEach(card => {
        card.addEventListener('click', () => {
            const itemType = card.dataset.type;
            const url = card.dataset.url;
            const id = card.dataset.id || url?.split('/').pop();
            const name = card.dataset.title || '';
            const artists = card.dataset.artist || '';
            const cover = card.dataset.cover || '';
            openDetailView({ type: itemType, id, name, artists, cover, url });
        });
    });
}

// ===== Library Segment Control =====
function setupLibrary() {
    document.querySelectorAll('#library-segment .segment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.librarySegment = btn.dataset.segment;
            document.querySelectorAll('#library-segment .segment-btn').forEach(b => b.classList.toggle('active', b.dataset.segment === state.librarySegment));
            document.querySelectorAll('.segment-panel').forEach(p => p.classList.toggle('active', p.id === `segment-${state.librarySegment}`));
        });
    });
}

// ===== Toast =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        toast.style.transition = 'all 250ms ease';
        setTimeout(() => toast.remove(), 250);
    }, 3500);
}

// ===== Filter Chips =====
let _activeFilter = 'all';
function setupFilterChips() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            _activeFilter = chip.dataset.filter;
            const input = document.getElementById('search-input');
            if (input.value.trim().length > 0) doSearch();
        });
    });
}

// ===== Search =====
function setupSearch() {
    const input = document.getElementById('search-input');
    let debounceTimer;
    input.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(doSearch, 400); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounceTimer); doSearch(); } });
    input.addEventListener('focus', showSearchHistory);
    input.addEventListener('blur', () => setTimeout(() => { document.getElementById('search-history').style.display = 'none'; }, 200));
}

function getActiveTypes() {
    if (_activeFilter === 'all') return 'track,album,artist,playlist';
    return _activeFilter;
}

function formatDuration(ms) {
    if (!ms) return '';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

async function doSearch() {
    const query = document.getElementById('search-input').value.trim();
    const resultsEl = document.getElementById('search-results');
    if (!query) {
        resultsEl.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><p>Search for music to get started</p></div>`;
        return;
    }
    addSearchHistory(query);
    devLog('Searching', { query });
    resultsEl.innerHTML = '<div class="spinner"></div>';
    const types = getActiveTypes();
    const url = `/search/?q=${encodeURIComponent(query)}&type=${encodeURIComponent(types)}&limit=20`;
    try {
        const res = await fetch(url);
        if (state.showApiLog) devLog('API Response', { status: res.status, url });
        if (!res.ok) { const err = await res.json().catch(() => ({ detail: 'Search failed' })); throw new Error(err.detail || 'Search failed'); }
        const data = await res.json();
        if (state.showApiLog) devLog('Search results', { tracks: data.tracks?.length, albums: data.albums?.length, artists: data.artists?.length, playlists: data.playlists?.length });
        renderSearchResults(data, query);
    } catch (e) {
        devLog('Search error', { error: e.message });
        resultsEl.innerHTML = `<div class="empty-state"><p style="color:#ef4444">${escapeHtml(e.message)}</p></div>`;
    }
}

// ===== Search History =====
function setupSearchHistory() {
    document.getElementById('search-history').addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.history-remove');
        if (removeBtn) { e.stopPropagation(); removeSearchHistory(removeBtn.dataset.query); showSearchHistory(); return; }
        const clearBtn = e.target.closest('.history-clear');
        if (clearBtn) { e.stopPropagation(); clearSearchHistory(); return; }
        const item = e.target.closest('.search-history-item');
        if (item) { document.getElementById('search-input').value = item.dataset.query || item.textContent; document.getElementById('search-history').style.display = 'none'; doSearch(); }
    });
}

function addSearchHistory(query) {
    state.searchHistory = state.searchHistory.filter(q => q !== query);
    state.searchHistory.unshift(query);
    if (state.searchHistory.length > 20) state.searchHistory.pop();
    localStorage.setItem('glitchi-search-history', JSON.stringify(state.searchHistory));
}

function removeSearchHistory(query) {
    state.searchHistory = state.searchHistory.filter(q => q !== query);
    localStorage.setItem('glitchi-search-history', JSON.stringify(state.searchHistory));
}

function clearSearchHistory() {
    state.searchHistory = [];
    localStorage.setItem('glitchi-search-history', '[]');
    document.getElementById('search-history').style.display = 'none';
}

function showSearchHistory() {
    const el = document.getElementById('search-history');
    if (state.searchHistory.length === 0) { el.style.display = 'none'; return; }
    el.innerHTML = state.searchHistory.map(q => `<div class="search-history-item" data-query="${escapeHtml(q)}"><span class="history-text">${escapeHtml(q)}</span><button type="button" class="history-remove" data-query="${escapeHtml(q)}" title="Remove">&times;</button></div>`).join('')
        + '<div class="history-clear">Clear all history</div>';
    el.style.display = 'block';
}

// ===== Event delegation for result cards =====
function setupResultCardDelegation() {
    document.getElementById('search-results').addEventListener('click', (e) => {
        const card = e.target.closest('.card, .artist-item');
        if (!card) return;
        if (e.target.closest('.card-stream')) {
            const name = card.dataset.title || card.querySelector('.card-title')?.textContent || '';
            const artists = card.dataset.artist || card.querySelector('.card-subtitle')?.textContent || '';
            const cover = card.dataset.cover || card.querySelector('.card-cover')?.src || '';
            const query = `${artists} ${name}`.trim();
            if (query) streamTrack(query, name, artists, cover);
            return;
        }
        if (e.target.closest('.card-dl')) {
            const url = card.dataset.url;
            const artist = card.dataset.artist || '';
            const title = card.dataset.title || '';
            if (url) {
                card.querySelector('.card-dl').disabled = true;
                card.querySelector('.card-dl').style.opacity = '0.4';
                startDownloadWithProgress(url, 'inline', card, { artist, title });
            }
            return;
        }
        const itemType = card.dataset.type;
        const url = card.dataset.url;
        const id = card.dataset.id || url?.split('/').pop();
        const name = card.dataset.title || card.querySelector('.card-title')?.textContent || '';
        const artists = card.dataset.artist || card.querySelector('.card-subtitle')?.textContent || '';
        const cover = card.dataset.cover || card.querySelector('.card-cover')?.src || '';
        const releaseDate = card.dataset.release || '';
        const duration = card.dataset.duration || '';
        const album = card.dataset.album || '';
        const genres = card.dataset.genres || '';
        const tracksCount = card.dataset.tracks || '';
        openDetailView({ type: itemType, id, name, artists, cover, url, releaseDate, duration, album, genres, tracksCount });
    });
}

// ===== Detail View Modal =====
function openDetailView(item) {
    state.detailItem = item;
    devLog('Opening detail view', { type: item.type, name: item.name });
    document.getElementById('detail-download-progress').classList.add('hidden');
    document.getElementById('detail-type').textContent = item.type?.toUpperCase() || '';
    document.getElementById('detail-title').textContent = item.name || '';
    document.getElementById('detail-subtitle').textContent = item.artists || '';
    document.getElementById('detail-meta').textContent = [
        item.album ? `Album: ${item.album}` : '',
        item.releaseDate ? `Released: ${item.releaseDate}` : '',
        item.duration ? formatDuration(parseInt(item.duration)) : '',
        item.genres ? `Genres: ${item.genres}` : '',
        item.tracksCount ? `${item.tracksCount} tracks` : '',
    ].filter(Boolean).join(' · ') || '';

    const coverEl = document.getElementById('detail-cover');
    if (item.cover) { coverEl.src = item.cover; coverEl.style.display = ''; }
    else { coverEl.style.display = 'none'; }

    const tracksSection = document.getElementById('detail-tracks');
    if (item.type === 'artist' || item.type === 'playlist') {
        tracksSection.style.display = 'none';
    } else {
        tracksSection.style.display = '';
        if (item.type === 'album' && item.id) fetchAlbumTracks(item.id, item.cover);
        else document.getElementById('detail-tracks-list').innerHTML = '';
    }

    const btnDownload = document.getElementById('btn-detail-download');
    const btnStream = document.getElementById('btn-detail-stream');
    const btnAddPlaylist = document.getElementById('btn-detail-add-playlist');
    const btnOpenSpotify = document.getElementById('btn-detail-open-spotify');
    btnDownload.style.display = ''; btnStream.style.display = ''; btnAddPlaylist.style.display = ''; btnOpenSpotify.style.display = '';
    if (item.type === 'playlist') { btnDownload.style.display = 'none'; btnStream.style.display = 'none'; btnAddPlaylist.style.display = 'none'; }
    if (item.type === 'artist') { btnStream.style.display = 'none'; }

    btnDownload.onclick = () => {
        if (item.url) downloadFromDetail(item.url, item.artists, item.name);
        else showToast('No Spotify URL available', 'error');
    };
    btnStream.onclick = () => {
        const query = `${item.artists || ''} ${item.name || ''}`.trim();
        if (query) streamTrack(query, item.name, item.artists, item.cover);
        else showToast('No track info to stream', 'error');
    };
    btnAddPlaylist.onclick = () => openPlaylistPicker(item);
    btnOpenSpotify.onclick = () => { if (item.url) window.open(item.url, '_blank'); };

    document.getElementById('detail-modal').style.display = 'flex';
}

async function fetchAlbumTracks(albumId, coverUrl) {
    const listEl = document.getElementById('detail-tracks-list');
    listEl.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
    try {
        const res = await fetch(`/playlists/album-tracks/${encodeURIComponent(albumId)}`);
        if (!res.ok) throw new Error('Failed to fetch album tracks');
        const data = await res.json();
        if (data.tracks && data.tracks.length > 0) {
            listEl.innerHTML = data.tracks.map((t, i) => {
                const img = t.album_image_url || coverUrl;
                return `<div class="track-row" data-url="${escapeHtml(t.url)}" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(img)}">
                    <span class="track-num">${i + 1}</span>
                    ${img ? `<img class="track-cover" src="${escapeHtml(img)}" onerror="this.remove()">` : ''}
                    <div class="track-info"><div class="track-name">${escapeHtml(t.name)}</div><div class="track-artist">${escapeHtml(t.artists)}</div></div>
                    <span class="track-duration">${formatDuration(t.duration_ms)}</span>
                    <button class="track-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>`;
            }).join('');
            listEl.querySelectorAll('.track-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.track-dl')) { if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name); return; }
                    if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name);
                });
            });
        } else {
            listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">No tracks found</p>';
        }
    } catch (e) {
        listEl.innerHTML = '<p style="color:#ef4444;padding:16px">Failed to load tracks</p>';
        devLog('Album tracks error', { albumId, error: e.message });
    }
}

async function downloadFromDetail(url, artist, title) {
    devLog('Starting task-based download from detail', { url, artist, title });
    startDownloadWithProgress(url, 'detail', null, { artist: artist || '', title: title || '' });
}

// ===== Modals =====
function setupModals() {
    document.getElementById('modal-close').addEventListener('click', () => document.getElementById('detail-modal').style.display = 'none');
    document.getElementById('detail-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; });
    document.getElementById('btn-settings').addEventListener('click', () => {
        document.getElementById('settings-modal').style.display = 'flex';
        document.getElementById('settings-theme').value = state.theme;
        document.getElementById('settings-quality').value = state.defaultQuality;
        document.getElementById('settings-downloader').value = state.defaultDownloader;
        fetchAvailableDownloaders();
    });
    document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-modal').style.display = 'none');
    document.getElementById('settings-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) { e.currentTarget.style.display = 'none'; fetchAvailableDownloaders(); } });
    document.getElementById('playlist-picker-close').addEventListener('click', () => document.getElementById('playlist-picker-modal').style.display = 'none');
    document.getElementById('playlist-picker-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; });
    document.getElementById('btn-new-playlist-picker').addEventListener('click', () => {
        document.getElementById('playlist-picker-modal').style.display = 'none';
        createNewPlaylistWithItem(state._pendingPlaylistItem);
    });
}

// ===== Settings =====
function setupSettings() {
    document.getElementById('settings-theme').addEventListener('change', (e) => applyTheme(e.target.value));
    document.getElementById('settings-quality').addEventListener('change', (e) => {
        state.defaultQuality = e.target.value;
        localStorage.setItem('glitchi-quality', e.target.value);
    });
    document.getElementById('settings-downloader').addEventListener('change', (e) => {
        state.defaultDownloader = e.target.value;
        localStorage.setItem('glitchi-downloader', e.target.value);
        devLog('Downloader changed', { downloader: e.target.value });
        showToast(`Download engine: ${e.target.value}`, 'info');
    });
    document.getElementById('btn-dev-unlock').addEventListener('click', () => {
        const key = document.getElementById('dev-key-input').value.trim();
        if (key === state.adminKey) {
            state.devMode = true;
            localStorage.setItem('glitchi-dev', 'true');
            unlockDevUI();
            showToast('Dev mode unlocked! 🔓', 'success');
            devLog('Dev mode activated');
        } else { showToast('Invalid admin key', 'error'); }
    });
    document.getElementById('toggle-logs').addEventListener('change', function() { document.getElementById('dev-logs').style.display = this.checked ? 'block' : 'none'; });
    document.getElementById('toggle-debug').addEventListener('change', function() { state.debugMode = this.checked; localStorage.setItem('glitchi-debug', this.checked ? 'true' : 'false'); });
    document.getElementById('toggle-api-log').addEventListener('change', function() { state.showApiLog = this.checked; localStorage.setItem('glitchi-api-log', this.checked ? 'true' : 'false'); });
    document.getElementById('btn-clear-storage').addEventListener('click', () => {
        if (confirm('Clear ALL local data?')) {
            localStorage.clear();
            state.playlists = []; state.downloadedFiles = []; state.searchHistory = []; state.devMode = false; state.debugMode = false; state.showApiLog = false;
            showToast('All local data cleared', 'info');
            document.getElementById('dev-section').style.display = 'none';
            renderPlaylists(); loadFiles();
        }
    });
    document.getElementById('btn-export-data').addEventListener('click', () => {
        const data = { playlists: state.playlists, downloadedFiles: state.downloadedFiles, searchHistory: state.searchHistory, theme: state.theme, quality: state.defaultQuality };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'glitchi-data.json'; a.click();
        showToast('Data exported!', 'success');
    });
}

function unlockDevUI() {
    document.getElementById('dev-section').style.display = 'block';
    document.getElementById('toggle-debug').checked = state.debugMode;
    document.getElementById('toggle-api-log').checked = state.showApiLog;
    document.getElementById('dev-logs').style.display = document.getElementById('toggle-logs').checked ? 'block' : 'none';
    const logsEl = document.getElementById('dev-logs-content');
    if (logsEl) logsEl.textContent = devLogs.slice(-50).join('\n');
}

// ===== Files =====
function loadFiles() { renderLocalFiles(); }
function saveDownloadedFiles() { localStorage.setItem('glitchi-downloaded-files', JSON.stringify(state.downloadedFiles)); }
function trackDownloadedFile(filename) {
    const displayName = filename.split('/').pop() || filename;
    if (!state.downloadedFiles.find(f => f.filename === filename)) {
        state.downloadedFiles.unshift({ filename, displayName, downloadedAt: Date.now() });
        saveDownloadedFiles();
    }
}
function renderLocalFiles() {
    const container = document.getElementById('files-list');
    if (state.downloadedFiles.length === 0) {
        container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" class="empty-icon"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><p>No downloaded files yet</p></div>`;
        return;
    }
    container.innerHTML = state.downloadedFiles.map(f => {
        const date = new Date(f.downloadedAt).toLocaleDateString();
        const displayName = f.displayName || f.filename.split('/').pop() || 'download';
        return `<div class="file-card"><div class="file-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg></div>
            <div class="file-details"><div class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(displayName)}</div><div class="file-size">Downloaded ${date}</div></div>
            <div class="file-actions">
                <button class="file-btn file-btn-stream" data-filename="${escapeHtml(f.filename)}" title="Play"><svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg></button>
                <button class="file-btn file-btn-download" data-filename="${escapeHtml(f.filename)}" title="Download"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div></div>`;
    }).join('');
}
function setupFiles() {
    document.getElementById('refresh-files').addEventListener('click', loadFiles);
    document.getElementById('clear-files').addEventListener('click', () => {
        if (confirm('Clear downloaded files list from local storage?')) { state.downloadedFiles = []; saveDownloadedFiles(); renderLocalFiles(); showToast('Files list cleared', 'info'); }
    });
}
function setupFileCardDelegation() {
    document.getElementById('files-list').addEventListener('click', (e) => {
        const streamBtn = e.target.closest('.file-btn-stream');
        const downloadBtn = e.target.closest('.file-btn-download');
        if (streamBtn) playFile(streamBtn.dataset.filename);
        if (downloadBtn) downloadFile(downloadBtn.dataset.filename);
    });
}
function playFile(filename) {
    const rawName = filename.split('/').pop() || filename;
    let query = rawName.replace(/\.[^.]+$/, '').replace(/_\d{6,}$/, '');
    devLog('Playing via yt-dlp stream', { filename, query });
    streamTrack(query, query, 'Local file', null);
}
function downloadFile(filename) {
    window.open(`/files/download/${encodeURIComponent(filename)}`, '_blank');
    showToast('Download started', 'success');
}

// ===== Now Playing (Mini bar + Fullscreen sheet) =====
function setupNowPlaying() {
    // Tap mini player → open fullscreen
    document.getElementById('mini-player-tap').addEventListener('click', () => openNowPlaying());
    // Close fullscreen
    document.getElementById('np-close').addEventListener('click', () => closeNowPlaying());
    document.getElementById('now-playing-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeNowPlaying();
    });
    // Play/Pause (both mini and fullscreen)
    document.getElementById('ctrl-play').addEventListener('click', togglePlay);
    document.getElementById('ctrl-play-lg').addEventListener('click', togglePlay);
    // Progress bar seek (fullscreen)
    document.getElementById('np-progress-track').addEventListener('click', (e) => {
        if (!state.currentAudio || !state.currentAudio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        state.currentAudio.currentTime = pct * state.currentAudio.duration;
    });
    // Volume
    const volSlider = document.getElementById('player-volume-slider');
    volSlider.addEventListener('input', () => { if (state.currentAudio) state.currentAudio.volume = volSlider.value / 100; });
    document.getElementById('ctrl-volume').addEventListener('click', () => {
        if (state.currentAudio) { state.currentAudio.muted = !state.currentAudio.muted; document.getElementById('ctrl-volume').classList.toggle('active', state.currentAudio.muted); }
    });
    // Now Playing download button
    document.getElementById('btn-now-download').addEventListener('click', () => {
        if (state.playerTrack?.url) {
            downloadFromDetail(state.playerTrack.url, state.playerTrack.artists, state.playerTrack.name);
            showToast('Download queued', 'info');
        }
    });
}

function openNowPlaying() {
    if (!state.currentAudio) return;
    document.getElementById('now-playing-overlay').classList.remove('hidden');
    state.nowPlayingOpen = true;
    document.body.style.overflow = 'hidden';
}

function closeNowPlaying() {
    document.getElementById('now-playing-overlay').classList.add('hidden');
    state.nowPlayingOpen = false;
    document.body.style.overflow = '';
}

function togglePlay() {
    if (!state.currentAudio) return;
    if (state.currentAudio.paused) state.currentAudio.play().catch(() => {});
    else state.currentAudio.pause();
}

// ===== Streaming =====
async function streamTrack(query, name, artists, cover) {
    devLog('Streaming track', { query, name, artists });
    if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio.remove(); state.currentAudio = null; }

    // Show mini player
    const miniPlayer = document.getElementById('mini-player');
    miniPlayer.classList.remove('hidden');

    // Update mini player
    document.getElementById('mini-player-track').textContent = name || query;
    document.getElementById('mini-player-artist').textContent = artists || '';
    document.getElementById('mini-player-progress-fill').style.width = '0%';

    const miniCover = document.getElementById('mini-player-cover-img');
    if (cover) { miniCover.src = cover; miniCover.style.display = ''; }
    else { miniCover.style.display = 'none'; }

    // Update fullscreen
    document.getElementById('np-track-name').textContent = name || query;
    document.getElementById('np-artist-name').textContent = artists || '';
    document.getElementById('np-progress-fill').style.width = '0%';
    document.getElementById('np-time-current').textContent = '0:00';
    document.getElementById('np-time-total').textContent = '...';

    const npCover = document.getElementById('np-cover');
    const npPlaceholder = document.getElementById('np-cover-placeholder');
    if (cover) { npCover.src = cover; npCover.style.display = ''; npPlaceholder.style.display = 'none'; }
    else { npCover.style.display = 'none'; npPlaceholder.style.display = 'flex'; }

    // Loading state
    const playBtns = [document.getElementById('ctrl-play'), document.getElementById('ctrl-play-lg')];
    playBtns.forEach(b => { if (b) b.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>'; });

    const audio = new Audio(`/stream/audio?q=${encodeURIComponent(query)}`);
    state.currentAudio = audio;
    state.playerTrack = { name, artists, cover, query };

    audio.addEventListener('loadedmetadata', () => {
        const dur = formatTime(audio.duration || 0);
        document.getElementById('np-time-total').textContent = dur;
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>'; });
    });
    audio.addEventListener('play', () => {
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>'; });
    });
    audio.addEventListener('pause', () => {
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>'; });
    });
    audio.addEventListener('timeupdate', () => {
        if (audio.duration) {
            const pct = (audio.currentTime / audio.duration) * 100;
            document.getElementById('mini-player-progress-fill').style.width = `${pct}%`;
            document.getElementById('np-progress-fill').style.width = `${pct}%`;
            document.getElementById('np-time-current').textContent = formatTime(audio.currentTime);
        }
    });
    audio.addEventListener('ended', () => {
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>'; });
        document.getElementById('mini-player-progress-fill').style.width = '0%';
        document.getElementById('np-progress-fill').style.width = '0%';
        document.getElementById('np-time-current').textContent = '0:00';
    });
    audio.addEventListener('error', () => {
        showToast('Failed to stream track', 'error');
        devLog('Stream error', { query });
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>'; });
    });

    try {
        await audio.play();
        showToast(`Now playing: ${name || query}`, 'info');
    } catch (e) {
        showToast('Tap play to start', 'info');
        playBtns.forEach(b => { if (b) b.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>'; });
        devLog('Autoplay blocked', { error: e.message });
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== Render Search Results =====
function renderSearchResults(data, query) {
    const resultsEl = document.getElementById('search-results');
    let html = '';
    if (data.tracks && data.tracks.length > 0) {
        html += `<div class="result-section"><h2>Tracks <span class="count">${data.tracks.length} results</span></h2><div class="results-grid">`;
        data.tracks.forEach(t => {
            const imgHtml = t.album_image_url
                ? `<img src="${escapeHtml(t.album_image_url)}" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>';
            html += `<div class="card" data-type="track" data-id="${escapeHtml(t.id)}" data-title="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.album_image_url)}" data-url="${escapeHtml(t.url)}" data-duration="${t.duration_ms}" data-album="${escapeHtml(t.album)}">
                ${imgHtml}
                <div class="card-title">${escapeHtml(t.name)}</div>
                <div class="card-subtitle">${escapeHtml(t.artists)}</div>
                <div class="card-meta">${escapeHtml(t.album)} &middot; ${formatDuration(t.duration_ms)}</div>
                <div class="card-actions-row">
                    <button class="card-stream" title="Stream"><svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg></button>
                    <button class="card-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>
            </div>`;
        });
        html += '</div></div>';
    }
    if (data.albums && data.albums.length > 0) {
        html += `<div class="result-section"><h2>Albums <span class="count">${data.albums.length} results</span></h2><div class="results-grid">`;
        data.albums.forEach(a => {
            const imgHtml = a.image_url
                ? `<img src="${escapeHtml(a.image_url)}" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg></div>';
            html += `<div class="card" data-type="album" data-id="${escapeHtml(a.id)}" data-title="${escapeHtml(a.name)}" data-artist="${escapeHtml(a.artists)}" data-cover="${escapeHtml(a.image_url)}" data-url="${escapeHtml(a.url)}" data-release="${escapeHtml(a.release_date)}" data-tracks="${a.total_tracks}">
                ${imgHtml}<div class="card-title">${escapeHtml(a.name)}</div><div class="card-subtitle">${escapeHtml(a.artists)}</div><div class="card-meta">${escapeHtml(a.release_date)}</div>
            </div>`;
        });
        html += '</div></div>';
    }
    if (data.artists && data.artists.length > 0) {
        html += `<div class="result-section"><h2>Artists <span class="count">${data.artists.length} results</span></h2><div style="display:flex;flex-direction:column;gap:4px">`;
        data.artists.forEach(ar => {
            const avatarHtml = ar.image_url
                ? `<img src="${escapeHtml(ar.image_url)}" class="artist-avatar" loading="lazy" onerror="this.style.display='none'">`
                : '<div class="artist-avatar" style="display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="none" style="width:24px;height:24px;color:var(--text-tertiary)"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="2"/></svg></div>';
            html += `<div class="artist-item" data-type="artist" data-id="${escapeHtml(ar.id)}" data-title="${escapeHtml(ar.name)}" data-cover="${escapeHtml(ar.image_url)}" data-url="${escapeHtml(ar.url)}" data-genres="${escapeHtml(ar.genres)}">
                ${avatarHtml}<div><div class="artist-name">${escapeHtml(ar.name)}</div>${ar.genres ? `<div class="artist-meta">${escapeHtml(ar.genres)}</div>` : ''}</div>
            </div>`;
        });
        html += '</div></div>';
    }
    if (data.playlists && data.playlists.length > 0) {
        html += `<div class="result-section"><h2>Playlists <span class="count">${data.playlists.length} results</span></h2><div class="results-grid">`;
        data.playlists.forEach(pl => {
            const imgHtml = pl.image_url
                ? `<img src="${escapeHtml(pl.image_url)}" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
            html += `<div class="card" data-type="playlist" data-id="${escapeHtml(pl.id)}" data-title="${escapeHtml(pl.name)}" data-artist="${escapeHtml(pl.owner)}" data-cover="${escapeHtml(pl.image_url)}" data-url="${escapeHtml(pl.url)}" data-tracks="${pl.tracks_count}">
                ${imgHtml}<div class="card-title">${escapeHtml(pl.name)}</div><div class="card-subtitle">By ${escapeHtml(pl.owner)}</div><div class="card-meta">${pl.tracks_count} tracks</div>
            </div>`;
        });
        html += '</div></div>';
    }
    if (!data.tracks?.length && !data.albums?.length && !data.artists?.length && !data.playlists?.length) {
        html = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><p>No results found for "${escapeHtml(query)}"</p></div>`;
    }
    resultsEl.innerHTML = html;
}

// ===== Download =====
function setupDownload() { document.getElementById('btn-download').addEventListener('click', triggerDownload); }

async function triggerDownload() {
    const urlInput = document.getElementById('download-url');
    const url = urlInput.value.trim();
    if (!url) { showToast('Please enter a Spotify URL', 'error'); return; }
    if (!url.includes('spotify.com')) { showToast('Please enter a valid Spotify URL', 'error'); return; }
    devLog('Starting download from tab', { url, downloader: state.defaultDownloader });
    startDownloadWithProgress(url, 'tab');
}

// ===== Download Progress System =====
const PROGRESS_PCT_MAP = { pending: 5, downloading: 30, processing: 75, complete: 100, failed: 100 };
let _activePollTimers = {};

async function startDownloadWithProgress(url, source, cardEl, extraFields = {}) {
    let progressEl, stageEl, pctEl, fillEl, btn, isInline = false;
    if (source === 'detail') {
        progressEl = document.getElementById('detail-download-progress');
        stageEl = document.getElementById('detail-progress-stage');
        pctEl = document.getElementById('detail-progress-pct');
        fillEl = document.getElementById('detail-progress-fill-dl');
        btn = document.getElementById('btn-detail-download');
    } else if (source === 'inline' && cardEl) {
        isInline = true;
        const existing = cardEl.querySelector('.card-progress');
        if (existing) existing.remove();
        progressEl = document.createElement('div');
        progressEl.className = 'card-progress';
        progressEl.innerHTML = '<div class="card-progress-track"><div class="card-progress-fill"></div></div><div class="card-progress-text">Queued...</div>';
        cardEl.appendChild(progressEl);
        stageEl = progressEl.querySelector('.card-progress-text');
        fillEl = progressEl.querySelector('.card-progress-fill');
        pctEl = null;
        btn = cardEl.querySelector('.card-dl');
    } else {
        progressEl = document.getElementById('download-progress');
        stageEl = document.getElementById('progress-stage');
        pctEl = document.getElementById('progress-pct');
        fillEl = document.getElementById('progress-fill-dl');
        btn = document.getElementById('btn-download');
        document.getElementById('download-status').classList.add('hidden');
        progressEl.classList.remove('hidden');
    }
    if (btn && !isInline) { btn.disabled = true; btn.style.opacity = '0.6'; }
    if (!isInline) showToast('Download queued...', 'info');
    try {
        const res = await fetch('/download/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality: state.defaultQuality, downloader: state.defaultDownloader, ...extraFields }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Failed to start download' }));
            showToast(err.detail || 'Failed to start download', 'error');
            if (isInline && progressEl) progressEl.remove(); else progressEl.classList.add('hidden');
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
            return;
        }
        const data = await res.json();
        const taskId = data.task_id;
        devLog('Download task created', { taskId, source });
        localStorage.setItem('glitchi-active-download', JSON.stringify({ taskId, url, source, startedAt: Date.now() }));
        pollDownloadProgress(taskId, progressEl, stageEl, pctEl, fillEl, source, btn, isInline, cardEl);
    } catch (e) {
        if (!isInline) showToast('Download failed to start', 'error');
        devLog('Download task start error', { error: e.message });
        if (isInline && progressEl) progressEl.remove(); else progressEl.classList.add('hidden');
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
}

function pollDownloadProgress(taskId, progressEl, stageEl, pctEl, fillEl, source, btn, isInline, cardEl) {
    if (_activePollTimers[taskId]) clearInterval(_activePollTimers[taskId]);
    const poll = async () => {
        try {
            const res = await fetch(`/download/progress/${taskId}`);
            if (!res.ok) { clearInterval(_activePollTimers[taskId]); delete _activePollTimers[taskId]; return; }
            const task = await res.json();
            if (isInline) {
                const pct = PROGRESS_PCT_MAP[task.status] || 0;
                fillEl.style.width = `${pct}%`;
                stageEl.textContent = task.stage || task.status;
                if (task.status === 'complete') fillEl.style.background = '#22c55e';
                if (task.status === 'failed') fillEl.style.background = '#ef4444';
            } else { updateProgressBar(task, progressEl, fillEl, pctEl, stageEl); }
            if (task.status === 'complete') {
                clearInterval(_activePollTimers[taskId]); delete _activePollTimers[taskId];
                localStorage.removeItem('glitchi-active-download');
                if (btn) { btn.disabled = false; btn.style.opacity = ''; }
                if (isInline && progressEl) { stageEl.textContent = '✅ Ready!'; fillEl.style.width = '100%'; fillEl.style.background = '#22c55e'; setTimeout(() => progressEl.remove(), 3000); }
                if (task.filename) {
                    const displayName = task.filename.split('/').pop() || 'download.mp3';
                    showToast(`Downloaded: ${displayName}`, 'success');
                    setTimeout(async () => {
                        try {
                            const fileRes = await fetch(`/files/download/${encodeURIComponent(task.filename)}`);
                            if (!fileRes.ok) { showToast('Failed to fetch file', 'error'); return; }
                            const blob = await fileRes.blob();
                            const blobUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a'); a.href = blobUrl; a.download = task.filename.split('/').pop() || 'download.mp3';
                            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(blobUrl);
                        } catch (e) { showToast('Download payload failed', 'error'); }
                    }, 300);
                    trackDownloadedFile(task.filename);
                    if (!isInline) setTimeout(() => { progressEl.classList.add('hidden'); if (source === 'tab') document.getElementById('download-url').value = ''; renderLocalFiles(); }, 2000);
                }
            } else if (task.status === 'failed') {
                clearInterval(_activePollTimers[taskId]); delete _activePollTimers[taskId];
                localStorage.removeItem('glitchi-active-download');
                if (btn) { btn.disabled = false; btn.style.opacity = ''; }
                if (!isInline) showToast(task.error || 'Download failed', 'error');
                if (isInline && progressEl) { stageEl.textContent = '❌ Failed'; fillEl.style.background = '#ef4444'; setTimeout(() => progressEl.remove(), 4000); }
                else setTimeout(() => progressEl.classList.add('hidden'), 4000);
            }
        } catch (e) { devLog('Progress poll error', { taskId, error: e.message }); }
    };
    poll();
    _activePollTimers[taskId] = setInterval(poll, 1000);
}

function updateProgressBar(task, progressEl, fillEl, pctEl, stageEl) {
    const pct = PROGRESS_PCT_MAP[task.status] || 0;
    fillEl.style.width = `${pct}%`; pctEl.textContent = `${pct}%`; stageEl.textContent = task.stage || task.status;
    fillEl.className = 'progress-fill-dl';
    if (task.status === 'complete') fillEl.classList.add('complete');
    else if (task.status === 'failed') fillEl.classList.add('failed');
    else if (task.status === 'downloading') fillEl.classList.add('indeterminate');
    const steps = progressEl.querySelectorAll('.progress-step');
    const statusOrder = ['pending', 'downloading', 'processing', 'complete'];
    const currentIdx = statusOrder.indexOf(task.status);
    if (task.status === 'failed') { steps.forEach(s => { s.className = 'progress-step failed'; }); return; }
    steps.forEach((step, i) => { step.className = 'progress-step'; if (i < currentIdx) step.classList.add('done'); else if (i === currentIdx) step.classList.add('active'); });
}

function resumeActiveDownloads() {
    const active = localStorage.getItem('glitchi-active-download');
    if (!active) return;
    try {
        const info = JSON.parse(active);
        const age = Date.now() - info.startedAt;
        if (age > 600000) { localStorage.removeItem('glitchi-active-download'); return; }
        if (info.source === 'inline') { localStorage.removeItem('glitchi-active-download'); return; }
        const isDetail = info.source === 'detail';
        const progressEl = document.getElementById(isDetail ? 'detail-download-progress' : 'download-progress');
        const stageEl = document.getElementById(isDetail ? 'detail-progress-stage' : 'progress-stage');
        const pctEl = document.getElementById(isDetail ? 'detail-progress-pct' : 'progress-pct');
        const fillEl = document.getElementById(isDetail ? 'detail-progress-fill-dl' : 'progress-fill-dl');
        const btn = document.getElementById(isDetail ? 'btn-detail-download' : 'btn-download');
        if (progressEl) { progressEl.classList.remove('hidden'); pollDownloadProgress(info.taskId, progressEl, stageEl, pctEl, fillEl, info.source, btn); }
    } catch (e) { localStorage.removeItem('glitchi-active-download'); }
}

// ===== Playlists =====
function setupPlaylists() { document.getElementById('btn-new-playlist').addEventListener('click', () => createNewPlaylist()); }
function createNewPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    const playlist = { id: Date.now().toString(), name: name.trim(), tracks: [], createdAt: Date.now() };
    state.playlists.unshift(playlist); savePlaylists(); renderPlaylists();
    showToast(`Playlist "${playlist.name}" created!`, 'success');
}
function createNewPlaylistWithItem(item) {
    if (!item) return;
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    const playlist = { id: Date.now().toString(), name: name.trim(), tracks: [{ name: item.name, artists: item.artists, cover: item.cover, url: item.url, duration: item.duration || '', album: item.album || '', addedAt: Date.now() }], createdAt: Date.now() };
    state.playlists.unshift(playlist); savePlaylists(); renderPlaylists();
    showToast(`Added to "${playlist.name}"!`, 'success');
}
function savePlaylists() { localStorage.setItem('glitchi-playlists', JSON.stringify(state.playlists)); }
function renderPlaylists() {
    const container = document.getElementById('playlists-list');
    if (state.playlists.length === 0) {
        container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" class="empty-icon"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><p>No playlists yet. Create one to get started!</p></div>`;
        return;
    }
    container.innerHTML = state.playlists.map(p => `<div class="playlist-card" data-playlist-id="${p.id}">
        <div class="playlist-card-name">${escapeHtml(p.name)}</div><div class="playlist-card-count">${p.tracks.length} track${p.tracks.length !== 1 ? 's' : ''}</div>
        <div class="playlist-card-actions">
            <button class="playlist-card-btn download" data-action="download-zip">📦 Download ZIP</button>
            <button class="playlist-card-btn delete" data-action="delete">🗑 Delete</button>
        </div></div>`).join('');
    container.querySelectorAll('.playlist-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const action = e.target.dataset.action; const playlistId = card.dataset.playlistId;
            const playlist = state.playlists.find(p => p.id === playlistId); if (!playlist) return;
            if (action === 'download-zip') { e.stopPropagation(); downloadPlaylistZip(playlist); }
            else if (action === 'delete') { e.stopPropagation(); if (confirm(`Delete playlist "${playlist.name}"?`)) { state.playlists = state.playlists.filter(p => p.id !== playlistId); savePlaylists(); renderPlaylists(); showToast('Playlist deleted', 'info'); } }
            else openPlaylistView(playlist);
        });
    });
}
function openPlaylistView(playlist) {
    const modal = document.getElementById('detail-modal');
    document.getElementById('detail-type').textContent = 'PLAYLIST';
    document.getElementById('detail-title').textContent = playlist.name;
    document.getElementById('detail-subtitle').textContent = `${playlist.tracks.length} tracks`;
    document.getElementById('detail-meta').textContent = `Created ${new Date(playlist.createdAt).toLocaleDateString()}`;
    document.getElementById('detail-cover').style.display = 'none';
    document.getElementById('detail-tracks').style.display = '';
    const listEl = document.getElementById('detail-tracks-list');
    if (playlist.tracks.length === 0) { listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">No tracks in this playlist</p>'; }
    else {
        listEl.innerHTML = playlist.tracks.map((t, i) => {
            const img = t.cover ? `<img class="track-cover" src="${escapeHtml(t.cover)}" onerror="this.remove()">` : '';
            return `<div class="track-row" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.cover)}" data-url="${escapeHtml(t.url)}">
                <span class="track-num">${i+1}</span>${img}
                <div class="track-info"><div class="track-name">${escapeHtml(t.name)}</div><div class="track-artist">${escapeHtml(t.artists)}</div></div>
                <span class="track-duration">${t.duration || ''}</span>
                <button class="track-remove" title="Remove" data-index="${i}"><svg viewBox="0 0 24 24" fill="none" style="width:14px;height:14px"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
                <button class="track-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>`;
        }).join('');
        listEl.querySelectorAll('.track-remove').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation(); const idx = parseInt(btn.dataset.index);
            playlist.tracks.splice(idx, 1); savePlaylists(); openPlaylistView(playlist); renderPlaylists(); showToast('Track removed', 'info');
        }));
        listEl.querySelectorAll('.track-row').forEach(row => {
            const plArtist = row.dataset.artist, plName = row.dataset.name;
            row.addEventListener('click', (e) => {
                if (e.target.closest('.track-remove') || e.target.closest('.track-dl')) return;
                if (row.dataset.url) downloadFromDetail(row.dataset.url, plArtist, plName);
            });
            const dl = row.querySelector('.track-dl');
            if (dl) dl.addEventListener('click', (e) => { e.stopPropagation(); if (row.dataset.url) downloadFromDetail(row.dataset.url, plArtist, plName); });
        });
    }
    document.getElementById('btn-detail-download').onclick = () => downloadPlaylistZip(playlist);
    document.getElementById('btn-detail-add-playlist').style.display = 'none';
    document.getElementById('btn-detail-open-spotify').style.display = 'none';
    document.getElementById('detail-modal').style.display = 'flex';
}
async function downloadPlaylistZip(playlist) {
    if (playlist.tracks.length === 0) { showToast('Playlist is empty', 'error'); return; }
    const localFiles = state.downloadedFiles;
    if (localFiles.length === 0) { showToast('No downloaded files yet', 'error'); return; }
    const matchedFiles = [], unmatchedTracks = [];
    for (const track of playlist.tracks) {
        let found = false;
        const trackWords = track.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        for (const lf of localFiles) {
            const sfName = (lf.displayName || lf.filename || '').toLowerCase();
            if (trackWords.length > 0 && trackWords.every(w => sfName.includes(w))) { matchedFiles.push(lf.filename); found = true; break; }
        }
        if (!found) unmatchedTracks.push(track);
    }
    if (matchedFiles.length === 0) { showToast('No matching files found', 'error'); return; }
    if (unmatchedTracks.length > 0) showToast(`Zipping ${matchedFiles.length} tracks (${unmatchedTracks.length} not yet downloaded)`, 'info');
    try {
        const res = await fetch('/playlists/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filenames: matchedFiles }) });
        if (res.ok) { const blob = await res.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${playlist.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`; a.click(); showToast('ZIP download started!', 'success'); }
        else { const err = await res.json().catch(() => ({ detail: 'ZIP creation failed' })); showToast(err.detail || 'ZIP creation failed', 'error'); }
    } catch (e) { showToast('ZIP download failed', 'error'); }
}

// ===== Playlist Picker =====
function openPlaylistPicker(item) {
    state._pendingPlaylistItem = item;
    const listEl = document.getElementById('playlist-picker-list');
    if (state.playlists.length === 0) { listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:8px">No playlists yet</p>'; }
    else {
        listEl.innerHTML = state.playlists.map(p => `<div class="playlist-picker-item" data-playlist-id="${p.id}">${escapeHtml(p.name)} <span style="color:var(--text-tertiary);font-size:12px">(${p.tracks.length} tracks)</span></div>`).join('');
        listEl.querySelectorAll('.playlist-picker-item').forEach(el => el.addEventListener('click', () => {
            const playlist = state.playlists.find(p => p.id === el.dataset.playlistId);
            if (playlist && item) { playlist.tracks.push({ name: item.name, artists: item.artists, cover: item.cover, url: item.url, duration: item.duration || '', album: item.album || '', addedAt: Date.now() }); savePlaylists(); showToast(`Added to "${playlist.name}"`, 'success'); }
            document.getElementById('playlist-picker-modal').style.display = 'none';
        }));
    }
    document.getElementById('playlist-picker-modal').style.display = 'flex';
}

// ===== Utilities =====
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div'); div.textContent = str; return div.innerHTML;
}

async function fetchAvailableDownloaders() {
    try {
        const res = await fetch('/download/available');
        if (!res.ok) return;
        const data = await res.json();
        const sel = document.getElementById('settings-downloader');
        if (!sel) return;
        const current = state.defaultDownloader;
        sel.innerHTML = '';
        const allOptions = [
            { value: 'spotiflac', label: 'SpotiFLAC (Lossless, Qobuz/Tidal)' },
            { value: 'ytdlp', label: 'yt-dlp (YouTube Audio)' },
            { value: 'spotdl', label: 'SpotDL (Spotify → YouTube)' },
        ];
        for (const opt of allOptions) {
            const available = data.available.includes(opt.value);
            const option = document.createElement('option');
            option.value = opt.value; option.textContent = opt.label + (available ? '' : ' [NOT INSTALLED]'); option.disabled = !available;
            sel.appendChild(option);
        }
        if (data.available.includes(current)) sel.value = current;
        else if (data.available.length > 0) { sel.value = data.available[0]; state.defaultDownloader = data.available[0]; localStorage.setItem('glitchi-downloader', data.available[0]); }
    } catch (e) { devLog('Failed to fetch downloaders', { error: e.message }); }
}
