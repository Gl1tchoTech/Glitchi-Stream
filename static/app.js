// ===== Constants =====
const ADMIN_KEY = 'glitchi-admin-2024';

// ===== State =====
const state = {
    activeTab: 'search',
    theme: localStorage.getItem('glitchi-theme') || 'dark',
    searchTimeout: null,
    currentAudio: null,
    currentFilename: null,
    isPlaying: false,
    shuffle: false,
    loop: false,
    shuffleHistory: [], // stack of previously played indices for shuffle prev
    devMode: localStorage.getItem('glitchi-dev') === 'true',
    debugMode: localStorage.getItem('glitchi-debug') === 'true',
    showApiLog: localStorage.getItem('glitchi-api-log') === 'true',
    defaultQuality: localStorage.getItem('glitchi-quality') || 'LOSSLESS',
    playlists: JSON.parse(localStorage.getItem('glitchi-playlists') || '[]'),
    downloadedFiles: JSON.parse(localStorage.getItem('glitchi-downloaded-files') || '[]'),
    searchHistory: JSON.parse(localStorage.getItem('glitchi-search-history') || '[]'),
    detailItem: null, // current item in detail view
    queueOrder: [], // shuffled track order for stream bar
    queueIndex: 0,
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

    // Detect OS
    if (/android/i.test(ua)) {
        html.setAttribute('data-platform', 'android');
    } else if (/iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
        html.setAttribute('data-platform', 'ios');
    } else if (/windows/i.test(ua) || /win/i.test(platform)) {
        html.setAttribute('data-platform', 'windows');
    } else if (/mac/i.test(platform) || /macintosh/i.test(ua)) {
        html.setAttribute('data-platform', 'mac');
    } else if (/linux/i.test(platform)) {
        html.setAttribute('data-platform', 'linux');
    } else {
        html.setAttribute('data-platform', 'other');
    }

    // Detect mobile vs desktop
    const isMobile = /android|iphone|ipad|ipod|webos|blackberry|iemobile|opera mini/i.test(ua)
        || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        || (window.innerWidth <= 768);
    html.setAttribute('data-mobile', isMobile ? 'true' : 'false');

    // Detect touch capability
    html.setAttribute('data-touch', ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 'true' : 'false');

    devLog('Device detected', {
        platform: html.getAttribute('data-platform'),
        mobile: isMobile,
        touch: html.getAttribute('data-touch'),
        width: window.innerWidth,
        ua: ua.substring(0, 80),
    });

    return isMobile;
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    detectDevice();
    applyTheme(state.theme);
    document.getElementById('settings-theme').value = state.theme;
    document.getElementById('settings-quality').value = state.defaultQuality;
    setupNavigation();
    setupSearch();
    setupFiles();
    setupDownload();
    setupThemeSwitcher();
    setupFilterChips();
    setupPlayerControls();
    setupFileCardDelegation();
    setupResultCardDelegation();
    setupModals();
    setupSettings();
    setupPlaylists();
    setupSearchHistory();
    openTab(state.activeTab);
    loadFiles();
    renderPlaylists();
    if (state.devMode) unlockDevUI();
    devLog('App initialized', { theme: state.theme, devMode: state.devMode });
});

// ===== Theme =====
function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    state.theme = name;
    localStorage.setItem('glitchi-theme', name);
    document.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === name);
    });
    const sel = document.getElementById('settings-theme');
    if (sel) sel.value = name;
}

function setupThemeSwitcher() {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
}

// ===== Navigation =====
function setupNavigation() {
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
        item.addEventListener('click', () => openTab(item.dataset.tab));
    });
}

function openTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.nav-item[data-tab]').forEach(i =>
        i.classList.toggle('active', i.dataset.tab === name)
    );
    document.querySelectorAll('.tab-content').forEach(t =>
        t.classList.toggle('active', t.id === `tab-${name}`)
    );
    if (name === 'search') document.getElementById('search-input')?.focus();
    if (name === 'files') loadFiles();
    if (name === 'playlists') renderPlaylists();
    if (name === 'download') {
        // Sync quality selector with settings default
        const sel = document.getElementById('download-quality');
        if (sel) sel.value = state.defaultQuality;
    }
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

// ===== Filter Chips (Single-select, like Spotify) =====
let _activeFilter = 'all';

function setupFilterChips() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            _activeFilter = chip.dataset.filter;
            // Re-run search if there's a query
            const input = document.getElementById('search-input');
            if (input.value.trim().length > 0) doSearch();
        });
    });
}

// ===== Search =====
function setupSearch() {
    const input = document.getElementById('search-input');
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, 400);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            doSearch();
        }
    });

    input.addEventListener('focus', showSearchHistory);
    input.addEventListener('blur', () => setTimeout(() => {
        document.getElementById('search-history').style.display = 'none';
    }, 200));
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
        resultsEl.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <p>Search for music to get started</p></div>`;
        return;
    }

    // Save to history
    addSearchHistory(query);
    devLog('Searching', { query });

    resultsEl.innerHTML = '<div class="spinner"></div>';

    const types = getActiveTypes();
    const url = `/search/?q=${encodeURIComponent(query)}&type=${encodeURIComponent(types)}&limit=20`;

    try {
        const res = await fetch(url);
        if (state.showApiLog) devLog('API Response', { status: res.status, url });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Search failed' }));
            throw new Error(err.detail || 'Search failed');
        }
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
        // Remove single item
        const removeBtn = e.target.closest('.history-remove');
        if (removeBtn) {
            e.stopPropagation();
            const query = removeBtn.dataset.query;
            removeSearchHistory(query);
            showSearchHistory();
            return;
        }
        // Clear all
        const clearBtn = e.target.closest('.history-clear');
        if (clearBtn) {
            e.stopPropagation();
            clearSearchHistory();
            return;
        }
        // Click item to search
        const item = e.target.closest('.search-history-item');
        if (item) {
            document.getElementById('search-input').value = item.dataset.query || item.textContent;
            document.getElementById('search-history').style.display = 'none';
            doSearch();
        }
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
    devLog('Removed from search history', { query });
}

function clearSearchHistory() {
    state.searchHistory = [];
    localStorage.setItem('glitchi-search-history', '[]');
    document.getElementById('search-history').style.display = 'none';
    devLog('Cleared all search history');
}

function showSearchHistory() {
    const el = document.getElementById('search-history');
    if (state.searchHistory.length === 0) {
        el.style.display = 'none';
        return;
    }
    el.innerHTML = state.searchHistory.map(q =>
        `<div class="search-history-item" data-query="${escapeHtml(q)}">
            <span class="history-text">${escapeHtml(q)}</span>
            <button type="button" class="history-remove" data-query="${escapeHtml(q)}" title="Remove">&times;</button>
        </div>`
    ).join('') + `<div class="history-clear">Clear all history</div>`;
    el.style.display = 'block';
}

// ===== Event delegation for result cards =====
function setupResultCardDelegation() {
    document.getElementById('search-results').addEventListener('click', (e) => {
        const card = e.target.closest('.card, .artist-item');
        if (!card) return;

        // If play button was clicked on a track card
        if (e.target.closest('.card-play')) {
            const track = card.dataset.track || card.dataset.title;
            const artist = card.dataset.artist;
            const cover = card.dataset.cover;
            const url = card.dataset.url;
            const trackId = card.dataset.id;
            if (track) {
                updatePlayerUI(track, artist, cover);
                downloadAndPlay(url, track, artist, cover, trackId);
            }
            return;
        }

        // Otherwise open detail view
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

        openDetailView({
            type: itemType,
            id, name, artists, cover, url,
            releaseDate, duration, album, genres, tracksCount
        });
    });
}

// ===== Detail View Modal =====
function openDetailView(item) {
    state.detailItem = item;
    devLog('Opening detail view', { type: item.type, name: item.name, id: item.id });

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
    if (item.cover) {
        coverEl.src = item.cover;
        coverEl.style.display = '';
    } else {
        coverEl.style.display = 'none';
    }

    // Hide tracks section for artists and playlists
    const tracksSection = document.getElementById('detail-tracks');
    if (item.type === 'artist' || item.type === 'playlist') {
        tracksSection.style.display = 'none';
    } else {
        tracksSection.style.display = '';
        // Fetch album tracks if it's an album
        if (item.type === 'album' && item.id) {
            fetchAlbumTracks(item.id, item.cover);
        } else {
            document.getElementById('detail-tracks-list').innerHTML = '';
        }
    }

    // Setup detail buttons
    const btnDownload = document.getElementById('btn-detail-download');
    const btnPlay = document.getElementById('btn-detail-play');
    const btnAddPlaylist = document.getElementById('btn-detail-add-playlist');
    const btnOpenSpotify = document.getElementById('btn-detail-open-spotify');

    // Restore button visibility (may have been hidden by playlist view)
    btnDownload.style.display = '';
    btnPlay.style.display = '';
    btnAddPlaylist.style.display = '';
    btnOpenSpotify.style.display = '';

    // Playlists can't be downloaded/played directly via SpotiFLAC
    if (item.type === 'playlist') {
        btnDownload.style.display = 'none';
        btnPlay.style.display = 'none';
        btnAddPlaylist.style.display = 'none';
    }

    btnDownload.onclick = () => {
        if (item.url) downloadFromDetail(item.url);
        else showToast('No Spotify URL available', 'error');
    };
    btnPlay.onclick = () => {
        if (item.url) {
            updatePlayerUI(item.name, item.artists, item.cover);
            downloadAndPlay(item.url, item.name, item.artists, item.cover, item.id);
        }
    };
    btnAddPlaylist.onclick = () => openPlaylistPicker(item);
    btnOpenSpotify.onclick = () => {
        if (item.url) window.open(item.url, '_blank');
    };

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
                return `<div class="track-row" data-url="${escapeHtml(t.url)}" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(img)}" data-trackid="${escapeHtml(t.id || '')}">
                    <span class="track-num">${i + 1}</span>
                    ${img ? `<img class="track-cover" src="${escapeHtml(img)}" alt="" onerror="this.remove()">` : ''}
                    <div class="track-info">
                        <div class="track-name">${escapeHtml(t.name)}</div>
                        <div class="track-artist">${escapeHtml(t.artists)}</div>
                    </div>
                    <span class="track-duration">${formatDuration(t.duration_ms)}</span>
                    <button class="track-dl" title="Download this track"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>`;
            }).join('');

            // Add click handlers for track rows
            listEl.querySelectorAll('.track-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.track-dl')) {
                        const url = row.dataset.url;
                        if (url) downloadFromDetail(url);
                        return;
                    }
                    updatePlayerUI(row.dataset.name, row.dataset.artist, row.dataset.cover);
                    if (row.dataset.url) {
                        downloadAndPlay(row.dataset.url, row.dataset.name, row.dataset.artist, row.dataset.cover, row.dataset.trackid || '');
                    }
                });
            });
        } else {
            listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">No tracks found for this album</p>';
        }
    } catch (e) {
        listEl.innerHTML = '<p style="color:#ef4444;padding:16px">Failed to load tracks</p>';
        devLog('Album tracks error', { albumId, error: e.message });
    }
}

async function downloadFromDetail(url) {
    showToast('Downloading...', 'info');
    devLog('Direct download from detail', { url });
    try {
        const res = await fetch('/download/now', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality: state.defaultQuality }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Download failed' }));
            showToast(err.detail || 'Download failed', 'error');
            return;
        }
        // Get the blob and trigger browser download
        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        let filename = 'download.mp3';
        const fnameMatch = disposition.match(/filename="?([^";\n]+)"?/);
        if (fnameMatch) filename = fnameMatch[1];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        showToast('Download complete!', 'success');
        devLog('Direct download complete', { filename });
        // Refresh files list
        setTimeout(() => loadFiles(), 1000);
    } catch (e) {
        showToast('Download failed', 'error');
        devLog('Direct download error', { error: e.message });
    }
}

// ===== Modals =====
function setupModals() {
    // Detail modal close
    document.getElementById('modal-close').addEventListener('click', () => {
        document.getElementById('detail-modal').style.display = 'none';
    });
    document.getElementById('detail-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // Settings modal
    document.getElementById('btn-settings').addEventListener('click', () => {
        document.getElementById('settings-modal').style.display = 'flex';
        document.getElementById('settings-theme').value = state.theme;
        document.getElementById('settings-quality').value = state.defaultQuality;
    });
    document.getElementById('settings-close').addEventListener('click', () => {
        document.getElementById('settings-modal').style.display = 'none';
    });
    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    // Playlist picker modal
    document.getElementById('playlist-picker-close').addEventListener('click', () => {
        document.getElementById('playlist-picker-modal').style.display = 'none';
    });
    document.getElementById('playlist-picker-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    document.getElementById('btn-new-playlist-picker').addEventListener('click', () => {
        document.getElementById('playlist-picker-modal').style.display = 'none';
        createNewPlaylistWithItem(state._pendingPlaylistItem);
    });
}

// ===== Settings =====
function setupSettings() {
    document.getElementById('settings-theme').addEventListener('change', (e) => {
        applyTheme(e.target.value);
    });
    document.getElementById('settings-quality').addEventListener('change', (e) => {
        state.defaultQuality = e.target.value;
        localStorage.setItem('glitchi-quality', e.target.value);
    });

    // Dev unlock
    document.getElementById('btn-dev-unlock').addEventListener('click', () => {
        const key = document.getElementById('dev-key-input').value.trim();
        if (key === ADMIN_KEY) {
            state.devMode = true;
            localStorage.setItem('glitchi-dev', 'true');
            unlockDevUI();
            showToast('Dev mode unlocked! 🔓', 'success');
            devLog('Dev mode activated');
        } else {
            showToast('Invalid admin key', 'error');
        }
    });

    // Dev toggles
    document.getElementById('toggle-logs').addEventListener('change', function() {
        document.getElementById('dev-logs').style.display = this.checked ? 'block' : 'none';
    });
    document.getElementById('toggle-debug').addEventListener('change', function() {
        state.debugMode = this.checked;
        localStorage.setItem('glitchi-debug', this.checked ? 'true' : 'false');
    });
    document.getElementById('toggle-api-log').addEventListener('change', function() {
        state.showApiLog = this.checked;
        localStorage.setItem('glitchi-api-log', this.checked ? 'true' : 'false');
    });

    document.getElementById('btn-clear-storage').addEventListener('click', () => {
        if (confirm('Clear ALL local data? This cannot be undone.')) {
            localStorage.clear();
            state.playlists = [];
            state.downloadedFiles = [];
            state.searchHistory = [];
            state.devMode = false;
            state.debugMode = false;
            state.showApiLog = false;
            showToast('All local data cleared', 'info');
            document.getElementById('dev-section').style.display = 'none';
            renderPlaylists();
            loadFiles();
        }
    });

    document.getElementById('btn-export-data').addEventListener('click', () => {
        const data = {
            playlists: state.playlists,
            downloadedFiles: state.downloadedFiles,
            searchHistory: state.searchHistory,
            theme: state.theme,
            quality: state.defaultQuality,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'glitchi-data.json';
        a.click();
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
async function loadFiles() {
    const container = document.getElementById('files-list');
    container.innerHTML = '<div class="spinner"></div>';

    try {
        const res = await fetch('/files/');
        if (!res.ok) throw new Error('Failed to load files');
        const data = await res.json();
        // Merge with localStorage downloaded files
        const serverFiles = data.files || [];
        serverFiles.forEach(f => {
            if (!state.downloadedFiles.find(df => df.filename === f.filename)) {
                state.downloadedFiles.push({
                    filename: f.filename,
                    size_mb: f.size_mb,
                    extension: f.extension,
                    downloadedAt: Date.now(),
                });
            }
        });
        saveDownloadedFiles();
        renderFiles(serverFiles);
    } catch (e) {
        devLog('Load files error', { error: e.message });
        // Show from localStorage if server fails
        if (state.downloadedFiles.length > 0) {
            renderLocalFiles();
        } else {
            container.innerHTML = `<div class="empty-state"><p style="color:#ef4444">${escapeHtml(e.message)}</p></div>`;
        }
    }
}

function saveDownloadedFiles() {
    localStorage.setItem('glitchi-downloaded-files', JSON.stringify(state.downloadedFiles));
}

function addDownloadedFile(url) {
    const name = url.split('/').pop() || 'unknown';
    if (!state.downloadedFiles.find(f => f.filename.includes(name))) {
        state.downloadedFiles.unshift({
            filename: name,
            size_mb: 0,
            extension: '',
            downloadedAt: Date.now(),
            url,
        });
        saveDownloadedFiles();
    }
}

function renderLocalFiles() {
    const container = document.getElementById('files-list');
    if (state.downloadedFiles.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <p>No downloaded files yet</p></div>`;
        return;
    }
    container.innerHTML = state.downloadedFiles.map(f => {
        const date = new Date(f.downloadedAt).toLocaleDateString();
        return `<div class="file-card">
            <div class="file-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg></div>
            <div class="file-details">
                <div class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</div>
                <div class="file-size">Downloaded ${date}</div>
            </div>
        </div>`;
    }).join('');
}

function setupFiles() {
    document.getElementById('refresh-files').addEventListener('click', loadFiles);
    document.getElementById('clear-files').addEventListener('click', () => {
        if (confirm('Clear downloaded files list from local storage?')) {
            state.downloadedFiles = [];
            saveDownloadedFiles();
            renderLocalFiles();
            showToast('Files list cleared', 'info');
        }
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

function playFile(filename, seekTime = 0, displayName = null, displayArtist = null) {
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio.remove();
        state.currentAudio = null;
    }

    devLog('Playing file', { filename, seekTime });
    const audio = new Audio(`/files/stream?filename=${encodeURIComponent(filename)}`);
    audio.addEventListener('loadedmetadata', () => {
        updatePlayerUI(
            displayName || filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
            displayArtist || 'Local File',
            null
        );
        state.currentFilename = filename;
        state.isPlaying = true;
        updatePlayButton();
        document.getElementById('btn-play').disabled = false;
        document.getElementById('btn-prev').disabled = false;
        document.getElementById('btn-next').disabled = false;
        updateTimeDisplay(audio);
        if (seekTime > 0 && audio.duration) {
            audio.currentTime = Math.min(seekTime, audio.duration);
        }
    });
    audio.addEventListener('timeupdate', () => updateTimeDisplay(audio));
    audio.addEventListener('ended', () => {
        if (state.loop) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        } else {
            playNextInQueue();
        }
    });
    audio.addEventListener('error', () => {
        showToast('Failed to play file', 'error');
        devLog('Playback error', { filename });
        resetPlayer();
    });
    audio.play().catch(() => showToast('Playback blocked by browser. Click play to try again.', 'error'));
    state.currentAudio = audio;
    showToast(`Playing: ${filename}`, 'info');

    // Add to queue for shuffle
    if (!state.queueOrder.includes(filename)) {
        state.queueOrder.push(filename);
    }
    state.queueIndex = state.queueOrder.indexOf(filename);
}

function updateTimeDisplay(audio) {
    const pct = (audio.currentTime / audio.duration) * 100 || 0;
    document.getElementById('progress-fill').style.width = `${pct}%`;
    document.getElementById('time-current').textContent = formatTime(audio.currentTime);
    document.getElementById('time-total').textContent = formatTime(audio.duration || 0);
}

function downloadFile(filename) {
    window.open(`/files/download/${encodeURIComponent(filename)}`, '_blank');
    showToast('Download started', 'success');
    devLog('Downloading file', { filename });
}

function resetPlayer() {
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio = null;
    }
    state.currentFilename = null;
    state.isPlaying = false;
    state.queueOrder = [];
    state.queueIndex = 0;
    state.shuffleHistory = [];
    updatePlayButton();
    document.getElementById('player-cover').innerHTML = '';
    document.getElementById('player-track').textContent = 'No track selected';
    document.getElementById('player-artist').textContent = '\u00A0';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('time-current').textContent = '0:00';
    document.getElementById('time-total').textContent = '0:00';
    document.getElementById('btn-play').disabled = true;
    document.getElementById('btn-prev').disabled = true;
    document.getElementById('btn-next').disabled = true;
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updatePlayButton() {
    const btn = document.getElementById('btn-play');
    if (state.isPlaying) {
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h4v12H6V6zm8 0h4v12h-4V6z"/></svg>';
    } else {
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
}

function playNextInQueue() {
    if (state.queueOrder.length === 0) {
        resetPlayer();
        return;
    }
    if (state.shuffle) {
        // Push current to history before picking new
        if (state.queueOrder.length > 0 && state.queueIndex >= 0) {
            state.shuffleHistory.push(state.queueIndex);
            if (state.shuffleHistory.length > 50) state.shuffleHistory.shift();
        }
        // Pick a random index different from current if possible
        let nextIdx;
        if (state.queueOrder.length === 1) {
            nextIdx = 0;
        } else {
            do {
                nextIdx = Math.floor(Math.random() * state.queueOrder.length);
            } while (nextIdx === state.queueIndex && state.queueOrder.length > 1);
        }
        state.queueIndex = nextIdx;
    } else {
        state.queueIndex = (state.queueIndex + 1) % state.queueOrder.length;
    }
    const nextEntry = state.queueOrder[state.queueIndex];
    if (nextEntry && nextEntry.startsWith('stream:')) {
        const payload = nextEntry.replace('stream:', '');
        const parts = payload.split('||');
        streamAndPlay(parts[0] || 'Unknown', parts[1] || 'Unknown', parts[2] || null, '');
    } else if (nextEntry) {
        playFile(nextEntry);
    } else {
        resetPlayer();
    }
}

// ===== Player Controls =====
function setupPlayerControls() {
    document.getElementById('btn-play').addEventListener('click', () => {
        if (!state.currentAudio) return;
        if (state.currentAudio.paused) {
            state.currentAudio.play();
            state.isPlaying = true;
        } else {
            state.currentAudio.pause();
            state.isPlaying = false;
        }
        updatePlayButton();
        devLog(state.isPlaying ? 'Play' : 'Pause');
    });

    document.getElementById('btn-prev').addEventListener('click', () => {
        if (state.queueOrder.length === 0) return;
        if (state.shuffle && state.shuffleHistory.length > 0) {
            // Go back to previous track in shuffle history
            state.queueIndex = state.shuffleHistory.pop();
        } else {
            state.queueIndex = state.queueIndex > 0 ? state.queueIndex - 1 : state.queueOrder.length - 1;
        }
        const prevEntry = state.queueOrder[state.queueIndex];
        if (prevEntry && prevEntry.startsWith('stream:')) {
            const payload = prevEntry.replace('stream:', '');
            const parts = payload.split('||');
            streamAndPlay(parts[0] || 'Unknown', parts[1] || 'Unknown', parts[2] || null, '');
        } else if (prevEntry) {
            playFile(prevEntry);
        }
    });

    document.getElementById('btn-next').addEventListener('click', () => {
        playNextInQueue();
    });

    document.getElementById('progress-track').addEventListener('click', (e) => {
        if (!state.currentAudio) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        state.currentAudio.currentTime = pct * state.currentAudio.duration;
    });

    // Shuffle
    document.getElementById('btn-shuffle').addEventListener('click', () => {
        state.shuffle = !state.shuffle;
        document.getElementById('btn-shuffle').classList.toggle('active', state.shuffle);
        if (!state.shuffle) state.shuffleHistory = []; // Reset history when shuffle off
        showToast(state.shuffle ? 'Shuffle ON' : 'Shuffle OFF', 'info');
        devLog('Shuffle toggled', { shuffle: state.shuffle });
    });

    // Loop
    document.getElementById('btn-loop').addEventListener('click', () => {
        state.loop = !state.loop;
        document.getElementById('btn-loop').classList.toggle('active', state.loop);
        showToast(state.loop ? 'Loop ON' : 'Loop OFF', 'info');
        devLog('Loop toggled', { loop: state.loop });
    });
}

function updatePlayerUI(track, artist, coverUrl) {
    const cover = document.getElementById('player-cover');
    if (coverUrl) {
        cover.innerHTML = `<img src="${escapeHtml(coverUrl)}" alt="" onerror="this.remove()">`;
    } else {
        cover.innerHTML = '';
    }
    document.getElementById('player-track').textContent = track || 'No track';
    document.getElementById('player-artist').textContent = artist || '';
    devLog('Player UI updated', { track, artist });
}

// ===== Render Search Results =====
function renderSearchResults(data, query) {
    const resultsEl = document.getElementById('search-results');
    let html = '';

    if (data.tracks && data.tracks.length > 0) {
        html += `<div class="result-section"><h2>Tracks <span class="count">${data.tracks.length} results</span></h2><div class="results-grid">`;
        data.tracks.forEach(t => {
            const imgHtml = t.album_image_url
                ? `<img src="${escapeHtml(t.album_image_url)}" alt="" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>';
            html += `<div class="card" data-type="track" data-id="${escapeHtml(t.id)}" data-title="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.album_image_url)}" data-url="${escapeHtml(t.url)}" data-duration="${t.duration_ms}" data-album="${escapeHtml(t.album)}" data-track="${escapeHtml(t.name)}">
                ${imgHtml}
                <div class="card-title">${escapeHtml(t.name)}</div>
                <div class="card-subtitle">${escapeHtml(t.artists)}</div>
                <div class="card-meta">${escapeHtml(t.album)} &middot; ${formatDuration(t.duration_ms)}</div>
                <button class="card-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
            </div>`;
        });
        html += '</div></div>';
    }

    if (data.albums && data.albums.length > 0) {
        html += `<div class="result-section"><h2>Albums <span class="count">${data.albums.length} results</span></h2><div class="results-grid">`;
        data.albums.forEach(a => {
            const imgHtml = a.image_url
                ? `<img src="${escapeHtml(a.image_url)}" alt="" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/></svg></div>';
            html += `<div class="card" data-type="album" data-id="${escapeHtml(a.id)}" data-title="${escapeHtml(a.name)}" data-artist="${escapeHtml(a.artists)}" data-cover="${escapeHtml(a.image_url)}" data-url="${escapeHtml(a.url)}" data-release="${escapeHtml(a.release_date)}" data-tracks="${a.total_tracks}">
                ${imgHtml}
                <div class="card-title">${escapeHtml(a.name)}</div>
                <div class="card-subtitle">${escapeHtml(a.artists)}</div>
                <div class="card-meta">${escapeHtml(a.release_date)}</div>
            </div>`;
        });
        html += '</div></div>';
    }

    if (data.artists && data.artists.length > 0) {
        html += `<div class="result-section"><h2>Artists <span class="count">${data.artists.length} results</span></h2><div style="display:flex;flex-direction:column;gap:4px">`;
        data.artists.forEach(ar => {
            const avatarHtml = ar.image_url
                ? `<img src="${escapeHtml(ar.image_url)}" alt="" class="artist-avatar" loading="lazy" onerror="this.style.display='none'">`
                : '<div class="artist-avatar" style="display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="none" style="width:24px;height:24px;color:var(--text-tertiary)"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="2"/></svg></div>';
            html += `<div class="artist-item" data-type="artist" data-id="${escapeHtml(ar.id)}" data-title="${escapeHtml(ar.name)}" data-cover="${escapeHtml(ar.image_url)}" data-url="${escapeHtml(ar.url)}" data-genres="${escapeHtml(ar.genres)}">
                ${avatarHtml}
                <div>
                    <div class="artist-name">${escapeHtml(ar.name)}</div>
                    ${ar.genres ? `<div class="artist-meta">${escapeHtml(ar.genres)}</div>` : ''}
                </div>
            </div>`;
        });
        html += '</div></div>';
    }

    if (data.playlists && data.playlists.length > 0) {
        html += `<div class="result-section"><h2>Playlists <span class="count">${data.playlists.length} results</span></h2><div class="results-grid">`;
        data.playlists.forEach(pl => {
            const imgHtml = pl.image_url
                ? `<img src="${escapeHtml(pl.image_url)}" alt="" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
            html += `<div class="card" data-type="playlist" data-id="${escapeHtml(pl.id)}" data-title="${escapeHtml(pl.name)}" data-artist="${escapeHtml(pl.owner)}" data-cover="${escapeHtml(pl.image_url)}" data-url="${escapeHtml(pl.url)}" data-tracks="${pl.tracks_count}">
                ${imgHtml}
                <div class="card-title">${escapeHtml(pl.name)}</div>
                <div class="card-subtitle">By ${escapeHtml(pl.owner)}</div>
                <div class="card-meta">${pl.tracks_count} tracks</div>
            </div>`;
        });
        html += '</div></div>';
    }

    if (!data.tracks?.length && !data.albums?.length && !data.artists?.length && !data.playlists?.length) {
        html = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <p>No results found for "${escapeHtml(query)}"</p></div>`;
    }

    resultsEl.innerHTML = html;
}

function renderFiles(files) {
    const container = document.getElementById('files-list');
    if (!files || files.length === 0) {
        // Try local files
        if (state.downloadedFiles.length > 0) {
            renderLocalFiles();
            return;
        }
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <p>No downloaded files yet. Search for a track and download it!</p></div>`;
        return;
    }
    let html = '';
    files.forEach(f => {
        const extIcon = getExtensionIcon(f.extension);
        html += `<div class="file-card">
            <div class="file-icon">${extIcon}</div>
            <div class="file-details">
                <div class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</div>
                <div class="file-size">${f.size_mb} MB &middot; ${escapeHtml(f.extension)}</div>
            </div>
            <div class="file-actions">
                <button class="file-btn file-btn-stream" data-filename="${escapeHtml(f.filename)}" title="Play">
                    <svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>
                </button>
                <button class="file-btn file-btn-download" data-filename="${escapeHtml(f.filename)}" title="Download">
                    <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div></div>`;
    });
    container.innerHTML = html;
}

function getExtensionIcon(ext) {
    const e = (ext || '').toLowerCase();
    if (['.flac', '.mp3', '.m4a', '.wav', '.ogg'].includes(e)) {
        return '<svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2"/></svg>';
}

// ===== Download =====
function setupDownload() {
    document.getElementById('btn-download').addEventListener('click', triggerDownload);
}

async function triggerDownload() {
    const urlInput = document.getElementById('download-url');
    const qualityEl = document.getElementById('download-quality');
    const btn = document.getElementById('btn-download');
    const status = document.getElementById('download-status');
    const url = urlInput.value.trim();

    if (!url) { showToast('Please enter a Spotify URL', 'error'); return; }
    if (!url.includes('spotify.com')) { showToast('Please enter a valid Spotify URL', 'error'); return; }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div> Downloading...';
    status.className = 'status-msg hidden';

    devLog('Starting download', { url, quality: qualityEl.value });

    try {
        const res = await fetch('/download/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, quality: qualityEl.value }),
        });
        const data = await res.json();
        if (res.ok) {
            status.className = 'status-msg success';
            status.textContent = data.message || 'Download queued! Check Your Files.';
            urlInput.value = '';
            showToast('Download started!', 'success');
            addDownloadedFile(url);
        } else {
            status.className = 'status-msg error';
            status.textContent = data.detail || 'Download failed';
            showToast(data.detail || 'Download failed', 'error');
        }
    } catch (e) {
        status.className = 'status-msg error';
        status.textContent = 'Network error';
        devLog('Download error', { error: e.message });
    }
    status.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Download`;
}

// ===== Playlists =====
function setupPlaylists() {
    document.getElementById('btn-new-playlist').addEventListener('click', () => createNewPlaylist());
}

function createNewPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    const playlist = {
        id: Date.now().toString(),
        name: name.trim(),
        tracks: [],
        createdAt: Date.now(),
    };
    state.playlists.unshift(playlist);
    savePlaylists();
    renderPlaylists();
    showToast(`Playlist "${playlist.name}" created!`, 'success');
    devLog('Playlist created', { name: playlist.name });
}

function createNewPlaylistWithItem(item) {
    if (!item) return;
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    const playlist = {
        id: Date.now().toString(),
        name: name.trim(),
        tracks: [{
            name: item.name,
            artists: item.artists,
            cover: item.cover,
            url: item.url,
            duration: item.duration || '',
            album: item.album || '',
            addedAt: Date.now(),
        }],
        createdAt: Date.now(),
    };
    state.playlists.unshift(playlist);
    savePlaylists();
    renderPlaylists();
    showToast(`Added to "${playlist.name}"!`, 'success');
    devLog('Playlist created with item', { name: playlist.name });
}

function savePlaylists() {
    localStorage.setItem('glitchi-playlists', JSON.stringify(state.playlists));
}

function renderPlaylists() {
    const container = document.getElementById('playlists-list');
    if (state.playlists.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <p>No playlists yet. Create one to get started!</p></div>`;
        return;
    }
    container.innerHTML = state.playlists.map(p => `<div class="playlist-card" data-playlist-id="${p.id}">
        <div class="playlist-card-name">${escapeHtml(p.name)}</div>
        <div class="playlist-card-count">${p.tracks.length} track${p.tracks.length !== 1 ? 's' : ''}</div>
        <div class="playlist-card-actions">
            <button class="playlist-card-btn download" data-action="download-zip">📦 Download ZIP</button>
            <button class="playlist-card-btn delete" data-action="delete">🗑 Delete</button>
        </div>
    </div>`).join('');

    // Add click handlers
    container.querySelectorAll('.playlist-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            const playlistId = card.dataset.playlistId;
            const playlist = state.playlists.find(p => p.id === playlistId);
            if (!playlist) return;

            if (action === 'download-zip') {
                e.stopPropagation();
                downloadPlaylistZip(playlist);
            } else if (action === 'delete') {
                e.stopPropagation();
                if (confirm(`Delete playlist "${playlist.name}"?`)) {
                    state.playlists = state.playlists.filter(p => p.id !== playlistId);
                    savePlaylists();
                    renderPlaylists();
                    showToast('Playlist deleted', 'info');
                }
            } else {
                openPlaylistView(playlist);
            }
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
    if (playlist.tracks.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:16px">No tracks in this playlist</p>';
    } else {
        listEl.innerHTML = playlist.tracks.map((t, i) => {
            const img = t.cover ? `<img class="track-cover" src="${escapeHtml(t.cover)}" alt="" onerror="this.remove()">` : '';
            return `<div class="track-row" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.cover)}" data-url="${escapeHtml(t.url)}" data-trackid="${escapeHtml(t.trackId || '')}">
                <span class="track-num">${i + 1}</span>
                ${img}
                <div class="track-info">
                    <div class="track-name">${escapeHtml(t.name)}</div>
                    <div class="track-artist">${escapeHtml(t.artists)}</div>
                </div>
                <span class="track-duration">${t.duration || ''}</span>
                <button class="track-remove" title="Remove" data-index="${i}">
                    <svg viewBox="0 0 24 24" fill="none" style="width:14px;height:14px"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <button class="track-dl" title="Download this track">
                    <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>`;
        }).join('');

        // Handlers for remove and download buttons
        listEl.querySelectorAll('.track-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                playlist.tracks.splice(idx, 1);
                savePlaylists();
                openPlaylistView(playlist);
                renderPlaylists();
                showToast('Track removed', 'info');
            });
        });
        listEl.querySelectorAll('.track-dl').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const row = btn.closest('.track-row');
                if (row.dataset.url) downloadFromDetail(row.dataset.url);
            });
        });
        listEl.querySelectorAll('.track-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('.track-remove') || e.target.closest('.track-dl')) return;
                updatePlayerUI(row.dataset.name, row.dataset.artist, row.dataset.cover);
                if (row.dataset.url) {
                    downloadAndPlay(row.dataset.url, row.dataset.name, row.dataset.artist, row.dataset.cover, row.dataset.trackid || '');
                }
            });
        });
    }

    // Setup detail buttons for playlist
    document.getElementById('btn-detail-download').onclick = () => downloadPlaylistZip(playlist);
    document.getElementById('btn-detail-play').style.display = 'none';
    document.getElementById('btn-detail-add-playlist').style.display = 'none';
    document.getElementById('btn-detail-open-spotify').style.display = 'none';

    document.getElementById('detail-modal').style.display = 'flex';
}

async function downloadPlaylistZip(playlist) {
    if (playlist.tracks.length === 0) {
        showToast('Playlist is empty', 'error');
        return;
    }

    // First, check what's already downloaded and match tracks to files
    let filesRes;
    try {
        filesRes = await fetch('/files/');
    } catch (e) {
        showToast('Cannot reach server to check files', 'error');
        return;
    }

    const filesData = await filesRes.json();
    const serverFiles = filesData.files || [];

    // Try to match playlist tracks to downloaded files by name
    const matchedFiles = [];
    const unmatchedTracks = [];

    for (const track of playlist.tracks) {
        let found = false;
        const trackWords = track.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        for (const sf of serverFiles) {
            const sfName = sf.filename.toLowerCase();
            // Check if all significant words from track name appear in the filename
            if (trackWords.length > 0 && trackWords.every(w => sfName.includes(w))) {
                matchedFiles.push(sf.filename);
                found = true;
                break;
            }
        }
        if (!found) unmatchedTracks.push(track);
    }

    if (matchedFiles.length === 0) {
        showToast('No matching downloaded files found. Download tracks first!', 'error');
        devLog('Playlist ZIP: no matching files', { unmatched: unmatchedTracks.length });
        return;
    }

    if (unmatchedTracks.length > 0) {
        showToast(`Zipping ${matchedFiles.length} tracks (${unmatchedTracks.length} not yet downloaded)`, 'info');
    }

    devLog('Building playlist ZIP', { matched: matchedFiles.length, unmatched: unmatchedTracks.length });

    try {
        const res = await fetch('/playlists/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: matchedFiles }),
        });
        if (res.ok) {
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${playlist.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`;
            a.click();
            showToast('ZIP download started!', 'success');
            devLog('ZIP download sent', { name: playlist.name, files: matchedFiles.length });
        } else {
            const err = await res.json().catch(() => ({ detail: 'ZIP creation failed' }));
            showToast(err.detail || 'ZIP creation failed', 'error');
        }
    } catch (e) {
        showToast('ZIP download failed', 'error');
        devLog('ZIP error', { error: e.message });
    }
}

// ===== Playlist Picker (Add to Playlist from detail) =====
function openPlaylistPicker(item) {
    state._pendingPlaylistItem = item;
    const listEl = document.getElementById('playlist-picker-list');

    if (state.playlists.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-tertiary);padding:8px">No playlists yet</p>';
    } else {
        listEl.innerHTML = state.playlists.map(p =>
            `<div class="playlist-picker-item" data-playlist-id="${p.id}">${escapeHtml(p.name)} <span style="color:var(--text-tertiary);font-size:12px">(${p.tracks.length} tracks)</span></div>`
        ).join('');

        listEl.querySelectorAll('.playlist-picker-item').forEach(el => {
            el.addEventListener('click', () => {
                const playlist = state.playlists.find(p => p.id === el.dataset.playlistId);
                if (playlist && item) {
                    playlist.tracks.push({
                        name: item.name,
                        artists: item.artists,
                        cover: item.cover,
                        url: item.url,
                        trackId: item.id || '',
                        duration: item.duration || '',
                        album: item.album || '',
                        addedAt: Date.now(),
                    });
                    savePlaylists();
                    showToast(`Added to "${playlist.name}"`, 'success');
                    devLog('Track added to playlist', { playlist: playlist.name, track: item.name });
                }
                document.getElementById('playlist-picker-modal').style.display = 'none';
            });
        });
    }
    document.getElementById('playlist-picker-modal').style.display = 'flex';
}

// ===== Streaming Play (YouTube audio, no download needed) =====
let _streamAbortController = null;

async function streamAndPlay(trackName, artistName, coverUrl, trackId) {
    if (!trackName) {
        showToast('No track to play', 'error');
        return;
    }

    // Abort any previous stream
    if (_streamAbortController) {
        _streamAbortController.abort();
        devLog('Aborted previous stream');
    }
    _streamAbortController = new AbortController();
    const signal = _streamAbortController.signal;

    // 1. Try existing downloaded file first (fastest path)
    const existingFile = await findMatchingFile(trackName, artistName);
    if (existingFile) {
        devLog('Found existing file for play', { filename: existingFile, track: trackName });
        _streamAbortController = null;
        playFile(existingFile, 0, trackName, artistName);
        return;
    }

    // 2. Update player UI with streaming state
    updatePlayerUI(trackName, artistName, coverUrl);
    document.getElementById('player-track').textContent = trackName;
    document.getElementById('player-artist').textContent = artistName || 'Streaming...';
    document.getElementById('btn-play').disabled = true;

    // 3. Build stream query
    const streamQuery = `${trackName} ${artistName || ''}`.trim();
    const streamUrl = `/stream/audio?q=${encodeURIComponent(streamQuery)}`;

    devLog('Starting YouTube stream', { query: streamQuery, track: trackName });

    // 4. Stop any current audio
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio.remove();
        state.currentAudio = null;
    }

    // 5. Create audio element pointing to our stream endpoint
    const audio = new Audio(streamUrl);

    audio.addEventListener('loadedmetadata', () => {
        if (signal.aborted) return;
        state.currentFilename = null; // not a local file
        state.isPlaying = true;
        updatePlayButton();
        document.getElementById('btn-play').disabled = false;
        document.getElementById('btn-prev').disabled = false;
        document.getElementById('btn-next').disabled = false;
        updateTimeDisplay(audio);
        showToast(`Playing: ${trackName}`, 'info');
        devLog('Stream started playing', { track: trackName });
    });

    audio.addEventListener('timeupdate', () => {
        if (!signal.aborted) updateTimeDisplay(audio);
    });

    audio.addEventListener('ended', () => {
        if (signal.aborted) return;
        if (state.loop) {
            audio.currentTime = 0;
            audio.play().catch(() => {});
        } else {
            playNextInQueue();
        }
    });

    audio.addEventListener('error', () => {
        if (signal.aborted) return;
        devLog('Stream playback failed, falling back to download', { track: trackName });
        // Fallback: try to download and play from local files
        fallbackDownloadAndPlay(trackName, artistName, coverUrl, trackId);
    });

    audio.addEventListener('playing', () => {
        if (signal.aborted) return;
        updatePlayerUI(trackName, artistName, coverUrl);
    });

    state.currentAudio = audio;
    state.streamQuery = streamQuery; // track what's streaming
    audio.play().catch((err) => {
        if (signal.aborted) return;
        devLog('Stream play() failed', { error: err.message });
        showToast('Playback blocked. Tap play to try again.', 'error');
        document.getElementById('btn-play').disabled = false;
    });

    // Add to stream queue for shuffle/next (structured format)
    const queueEntry = `stream:${trackName}||${artistName || ''}||${coverUrl || ''}`;
    if (!state.queueOrder.includes(queueEntry)) {
        state.queueOrder.push(queueEntry);
    }
    state.queueIndex = state.queueOrder.indexOf(queueEntry);
}

async function fallbackDownloadAndPlay(trackName, artistName, coverUrl, trackId) {
    showToast(`Stream unavailable. Trying download...`, 'info');
    devLog('Fallback: starting download for playback', { track: trackName });

    // Use the download tab endpoint. We don't have a valid Spotify URL for
    // streaming fallback, so show a message instead of sending a bad URL.
    showToast('Stream not available. Try downloading from the Download tab.', 'warning');
    devLog('Fallback: no valid Spotify URL available for download', { track: trackName });
    resetPlayer();
    return;
}

// Backward compat: downloadAndPlay delegates to streamAndPlay
// Keep renamed to avoid breaking existing internal references
async function downloadAndPlay(url, trackName, artistName, coverUrl, trackId) {
    // For search results and detail views, use streaming
    await streamAndPlay(trackName, artistName, coverUrl, trackId);
}

async function findMatchingFile(trackName, artistName) {
    try {
        const res = await fetch('/files/');
        if (!res.ok) return null;
        const data = await res.json();
        const files = data.files || [];

        // Build search words from track name and artist
        const trackWords = trackName.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        const artistWords = (artistName || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);

        // Score each file: track word matches + artist word matches
        let bestMatch = null;
        let bestScore = 0;

        for (const f of files) {
            const fn = f.filename.toLowerCase();
            let score = 0;
            // Must match at least half of track words
            const trackMatches = trackWords.filter(w => fn.includes(w)).length;
            const trackRatio = trackWords.length > 0 ? trackMatches / trackWords.length : 0;
            if (trackRatio < 0.5) continue;
            score += trackMatches * 2;
            // Bonus for artist match
            const artistMatches = artistWords.filter(w => fn.includes(w)).length;
            score += artistMatches * 1.5;
            // Prefer smaller files (less likely to be partial .tmp renamed)
            if (score > bestScore) {
                bestScore = score;
                bestMatch = f.filename;
            }
        }
        return bestMatch;
    } catch (e) {
        return null;
    }
}

// ===== Utilities =====
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
