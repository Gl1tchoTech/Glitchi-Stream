// ===== State =====
const state = {
    activeTab: 'search',
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
    currentAudio: null,       // HTMLAudioElement for player bar
    playerTrack: null,        // {name, artist, cover, url} currently playing/streaming
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
    document.getElementById('settings-downloader').value = state.defaultDownloader;
    setupNavigation();
    setupSearch();
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
    setupPlayerBar();
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

        // If card-stream (stream) button was clicked on a track card
        if (e.target.closest('.card-stream')) {
            const name = card.dataset.title || card.querySelector('.card-title')?.textContent || '';
            const artists = card.dataset.artist || card.querySelector('.card-subtitle')?.textContent || '';
            const cover = card.dataset.cover || card.querySelector('.card-cover')?.src || '';
            const query = `${artists} ${name}`.trim();
            if (query) streamTrack(query, name, artists, cover);
            return;
        }

        // If card-dl (download) button was clicked on a track card
        if (e.target.closest('.card-dl')) {
            const url = card.dataset.url;
            const artist = card.dataset.artist || '';
            const title = card.dataset.title || '';
            if (url) {
                // Show inline progress bar on this screen (no redirect)
                card.querySelector('.card-dl').disabled = true;
                card.querySelector('.card-dl').style.opacity = '0.4';
                startDownloadWithProgress(url, 'inline', card, { artist, title });
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

    // Reset any active download progress bar from previous detail view
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
    const btnStream = document.getElementById('btn-detail-stream');
    const btnAddPlaylist = document.getElementById('btn-detail-add-playlist');
    const btnOpenSpotify = document.getElementById('btn-detail-open-spotify');

    // Restore button visibility (may have been hidden by playlist view)
    btnDownload.style.display = '';
    btnStream.style.display = '';
    btnAddPlaylist.style.display = '';
    btnOpenSpotify.style.display = '';

    // Playlists can't be downloaded/streamed directly
    if (item.type === 'playlist') {
        btnDownload.style.display = 'none';
        btnStream.style.display = 'none';
        btnAddPlaylist.style.display = 'none';
    }

    // Artists can't be streamed directly
    if (item.type === 'artist') {
        btnStream.style.display = 'none';
    }

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
                        if (url) downloadFromDetail(url, row.dataset.artist, row.dataset.name);
                        return;
                    }
                    // Clicking the row itself also downloads
                    if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name);
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

async function downloadFromDetail(url, artist, title) {
    devLog('Starting task-based download from detail', { url, artist, title });
    startDownloadWithProgress(url, 'detail', null, { artist: artist || '', title: title || '' });
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
        document.getElementById('settings-downloader').value = state.defaultDownloader;
        fetchAvailableDownloaders();
    });
    document.getElementById('settings-close').addEventListener('click', () => {
        document.getElementById('settings-modal').style.display = 'none';
    });
    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.style.display = 'none';
            // Refresh downloader options when settings open
            fetchAvailableDownloaders();
        }
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
    document.getElementById('settings-downloader').addEventListener('change', (e) => {
        state.defaultDownloader = e.target.value;
        localStorage.setItem('glitchi-downloader', e.target.value);
        devLog('Downloader changed', { downloader: e.target.value });
        showToast(`Download engine: ${e.target.value}`, 'info');
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

// "Your Files" renders exclusively from localStorage — per-browser, not global.
function loadFiles() {
    renderLocalFiles();
}

function saveDownloadedFiles() {
    localStorage.setItem('glitchi-downloaded-files', JSON.stringify(state.downloadedFiles));
}

/** Add a file to this browser's downloaded-files list and persist. */
function trackDownloadedFile(filename) {
    const displayName = filename.split('/').pop() || filename;
    // Avoid duplicates
    if (!state.downloadedFiles.find(f => f.filename === filename)) {
        state.downloadedFiles.unshift({
            filename: filename,
            displayName: displayName,
            downloadedAt: Date.now(),
        });
        saveDownloadedFiles();
        devLog('Tracked downloaded file', { filename });
    }
}

function renderLocalFiles() {
    const container = document.getElementById('files-list');
    if (state.downloadedFiles.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <p>No downloaded files yet. Search for a track and download it!</p></div>`;
        return;
    }
    container.innerHTML = state.downloadedFiles.map(f => {
        const date = new Date(f.downloadedAt).toLocaleDateString();
        const displayName = f.displayName || f.filename.split('/').pop() || 'download';
        return `<div class="file-card">
            <div class="file-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg></div>
            <div class="file-details">
                <div class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(displayName)}</div>
                <div class="file-size">Downloaded ${date}</div>
            </div>
            <div class="file-actions">
                <button class="file-btn file-btn-stream" data-filename="${escapeHtml(f.filename)}" title="Play">
                    <svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>
                </button>
                <button class="file-btn file-btn-download" data-filename="${escapeHtml(f.filename)}" title="Download">
                    <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div></div>`;
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

function playFile(filename) {
    // Parse a search query from the filename: strip extension and any random hex suffix
    const rawName = filename.split('/').pop() || filename;
    let query = rawName.replace(/\.[^.]+$/, '');  // remove file extension
    query = query.replace(/_\d{6,}$/, '');         // strip _196980 style hex suffix from old files

    // Use yt-dlp streaming for all playback (unified streaming architecture)
    devLog('Playing via yt-dlp stream', { filename, query });
    streamTrack(query, query, 'Local file', null);
}

function downloadFile(filename) {
    window.open(`/files/download/${encodeURIComponent(filename)}`, '_blank');
    showToast('Download started', 'success');
    devLog('Downloading file', { filename });
}

// ===== Player bar is hidden — download-only mode =====

// ===== Streaming (yt-dlp powered, zero-disk) =====

async function streamTrack(query, name, artists, cover) {
    devLog('Streaming track', { query, name, artists });

    // Stop any existing playback
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio.remove();
        state.currentAudio = null;
    }

    // Show player bar
    const playerBar = document.getElementById('player-bar');
    playerBar.style.display = '';

    // Update player info
    document.getElementById('player-track-name').textContent = name || query;
    document.getElementById('player-artist-name').textContent = artists || '';
    document.getElementById('player-time-current').textContent = '0:00';
    document.getElementById('player-time-total').textContent = '...';
    document.getElementById('player-progress-fill').style.width = '0%';

    const coverImg = document.getElementById('player-cover-img');
    if (cover) {
        coverImg.src = cover;
        coverImg.style.display = '';
    } else {
        coverImg.style.display = 'none';
    }

    // Show loading state on play button
    const playBtn = document.getElementById('ctrl-play');
    playBtn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div>';

    // Stream audio from yt-dlp endpoint (zero disk I/O)
    const audio = new Audio(`/stream/audio?q=${encodeURIComponent(query)}`);
    state.currentAudio = audio;
    state.playerTrack = { name, artists, cover, query };

    audio.addEventListener('loadedmetadata', () => {
        document.getElementById('player-time-total').textContent = formatTime(audio.duration || 0);
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
    });

    audio.addEventListener('play', () => {
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>';
    });

    audio.addEventListener('pause', () => {
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
    });

    audio.addEventListener('timeupdate', () => {
        if (audio.duration) {
            const pct = (audio.currentTime / audio.duration) * 100;
            document.getElementById('player-progress-fill').style.width = `${pct}%`;
            document.getElementById('player-time-current').textContent = formatTime(audio.currentTime);
        }
    });

    audio.addEventListener('ended', () => {
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
        document.getElementById('player-progress-fill').style.width = '0%';
        document.getElementById('player-time-current').textContent = '0:00';
    });

    audio.addEventListener('error', () => {
        showToast('Failed to stream track. Try downloading instead.', 'error');
        devLog('Stream error', { query });
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
    });

    try {
        await audio.play();
        showToast(`Streaming: ${name || query}`, 'info');
    } catch (e) {
        showToast('Playback blocked. Click play to start.', 'info');
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
        devLog('Autoplay blocked', { error: e.message });
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== Player Bar Setup =====
function setupPlayerBar() {
    // Play/Pause
    document.getElementById('ctrl-play').addEventListener('click', () => {
        if (!state.currentAudio) return;
        if (state.currentAudio.paused) {
            state.currentAudio.play().catch(() => {});
        } else {
            state.currentAudio.pause();
        }
    });

    // Progress bar click to seek
    document.getElementById('player-progress-track').addEventListener('click', (e) => {
        if (!state.currentAudio || !state.currentAudio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        state.currentAudio.currentTime = pct * state.currentAudio.duration;
    });

    // Volume
    const volumeSlider = document.getElementById('player-volume-slider');
    volumeSlider.addEventListener('input', () => {
        if (state.currentAudio) {
            state.currentAudio.volume = volumeSlider.value / 100;
        }
    });
    document.getElementById('ctrl-volume').addEventListener('click', () => {
        if (state.currentAudio) {
            const muted = !state.currentAudio.muted;
            state.currentAudio.muted = muted;
            document.getElementById('ctrl-volume').classList.toggle('active', muted);
        }
    });

    // Close player
    document.getElementById('ctrl-close-player').addEventListener('click', () => {
        if (state.currentAudio) {
            state.currentAudio.pause();
            state.currentAudio.remove();
            state.currentAudio = null;
        }
        state.playerTrack = null;
        document.getElementById('player-bar').style.display = 'none';
    });
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


// ===== Download =====
function setupDownload() {
    document.getElementById('btn-download').addEventListener('click', triggerDownload);
}

async function triggerDownload() {
    const urlInput = document.getElementById('download-url');
    const qualityEl = document.getElementById('download-quality');
    const url = urlInput.value.trim();

    if (!url) { showToast('Please enter a Spotify URL', 'error'); return; }
    if (!url.includes('spotify.com')) { showToast('Please enter a valid Spotify URL', 'error'); return; }

    devLog('Starting task-based download from tab', { url, quality: qualityEl.value, downloader: state.defaultDownloader });
    startDownloadWithProgress(url, 'tab');
}

// ===== Download Progress Bar System =====
const PROGRESS_PCT_MAP = {
    pending: 5,
    downloading: 30,
    processing: 75,
    complete: 100,
    failed: 100,
};

let _activePollTimers = {}; // taskId → interval timer

async function startDownloadWithProgress(url, source, cardEl, extraFields = {}) {
    // Determine which progress bar to use
    let progressEl, stageEl, pctEl, fillEl, btn, isInline = false;

    if (source === 'detail') {
        progressEl = document.getElementById('detail-download-progress');
        stageEl = document.getElementById('detail-progress-stage');
        pctEl = document.getElementById('detail-progress-pct');
        fillEl = document.getElementById('detail-progress-fill-dl');
        btn = document.getElementById('btn-detail-download');
    } else if (source === 'inline' && cardEl) {
        // Create an inline progress bar inside the card
        isInline = true;
        const existing = cardEl.querySelector('.card-progress');
        if (existing) existing.remove();
        progressEl = document.createElement('div');
        progressEl.className = 'card-progress';
        progressEl.innerHTML = `
            <div class="card-progress-track">
                <div class="card-progress-fill"></div>
            </div>
            <div class="card-progress-text">Queued...</div>
        `;
        cardEl.appendChild(progressEl);
        stageEl = progressEl.querySelector('.card-progress-text');
        fillEl = progressEl.querySelector('.card-progress-fill');
        pctEl = null;
        btn = cardEl.querySelector('.card-dl');
    } else {
        // Tab download
        progressEl = document.getElementById('download-progress');
        stageEl = document.getElementById('progress-stage');
        pctEl = document.getElementById('progress-pct');
        fillEl = document.getElementById('progress-fill-dl');
        btn = document.getElementById('btn-download');
        document.getElementById('download-status').classList.add('hidden');
        progressEl.classList.remove('hidden');
    }

    // Disable download button (if not inline — inline already disabled by caller)
    if (btn && !isInline) {
        btn.disabled = true;
        btn.style.opacity = '0.6';
    }

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
            progressEl.classList.add('hidden');
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
            return;
        }
        const data = await res.json();
        const taskId = data.task_id;
        devLog('Download task created', { taskId, source });

        // Store in localStorage for refresh resilience
        localStorage.setItem('glitchi-active-download', JSON.stringify({
            taskId,
            url,
            source,
            startedAt: Date.now(),
        }));

        // Start polling
        pollDownloadProgress(taskId, progressEl, stageEl, pctEl, fillEl, source, btn, isInline, cardEl);
    } catch (e) {
        if (!isInline) showToast('Download failed to start', 'error');
        devLog('Download task start error', { error: e.message });
        if (isInline && progressEl) progressEl.remove();
        else progressEl.classList.add('hidden');
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
}

function pollDownloadProgress(taskId, progressEl, stageEl, pctEl, fillEl, source, btn, isInline, cardEl) {
    // Clear any previous timer for this task
    if (_activePollTimers[taskId]) {
        clearInterval(_activePollTimers[taskId]);
    }

    const poll = async () => {
        try {
            const res = await fetch(`/download/progress/${taskId}`);
            if (!res.ok) {
                // Task not found, stop polling
                clearInterval(_activePollTimers[taskId]);
                delete _activePollTimers[taskId];
                return;
            }
            const task = await res.json();

            if (isInline) {
                // Simple inline progress update
                const pct = PROGRESS_PCT_MAP[task.status] || 0;
                fillEl.style.width = `${pct}%`;
                stageEl.textContent = task.stage || task.status;
                if (task.status === 'complete') fillEl.style.background = '#22c55e';
                if (task.status === 'failed') fillEl.style.background = '#ef4444';
            } else {
                updateProgressBar(task, progressEl, fillEl, pctEl, stageEl);
            }

            if (task.status === 'complete') {
                // Stop polling
                clearInterval(_activePollTimers[taskId]);
                delete _activePollTimers[taskId];
                localStorage.removeItem('glitchi-active-download');

                // Enable button
                if (btn) { btn.disabled = false; btn.style.opacity = ''; }

                // For inline: show checkmark and remove after delay
                if (isInline && progressEl) {
                    stageEl.textContent = '✅ Ready!';
                    fillEl.style.width = '100%';
                    fillEl.style.background = '#22c55e';
                    setTimeout(() => progressEl.remove(), 3000);
                }

                // Trigger file download
                if (task.filename) {
                    const displayName = task.filename.split('/').pop() || 'download.mp3';
                    devLog('Download complete, sending payload', { filename: task.filename });
                    showToast(`Downloaded: ${displayName}`, 'success');
                    // Fetch the file as blob and trigger browser download (reliable, not blocked by popup blockers)
                    setTimeout(async () => {
                        try {
                            const fileRes = await fetch(`/files/download/${encodeURIComponent(task.filename)}`);
                            if (!fileRes.ok) {
                                showToast('Failed to fetch downloaded file', 'error');
                                return;
                            }
                            const blob = await fileRes.blob();
                            const blobUrl = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = blobUrl;
                            a.download = task.filename.split('/').pop() || 'download.mp3';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(blobUrl);
                            devLog('Download payload sent to browser', { filename: displayName });
                        } catch (e) {
                            showToast('Download payload failed', 'error');
                            devLog('Download payload error', { error: e.message });
                        }
                    }, 300);

                    // Add file to this browser's localStorage list, then refresh the tab
                    trackDownloadedFile(task.filename);

                    // Don't auto-play, just clean up UI
                    if (!isInline) {
                        setTimeout(() => {
                            progressEl.classList.add('hidden');
                            if (source === 'tab') {
                                document.getElementById('download-url').value = '';
                            }
                            renderLocalFiles();
                        }, 2000);
                    }
                }
            } else if (task.status === 'failed') {
                // Stop polling
                clearInterval(_activePollTimers[taskId]);
                delete _activePollTimers[taskId];
                localStorage.removeItem('glitchi-active-download');

                if (btn) { btn.disabled = false; btn.style.opacity = ''; }
                if (!isInline) showToast(task.error || 'Download failed', 'error');
                devLog('Download failed', { taskId, error: task.error });

                // Keep progress visible showing failure for a few seconds
                if (isInline && progressEl) {
                    stageEl.textContent = '❌ Failed';
                    fillEl.style.background = '#ef4444';
                    setTimeout(() => progressEl.remove(), 4000);
                } else {
                    setTimeout(() => progressEl.classList.add('hidden'), 4000);
                }
            }
        } catch (e) {
            devLog('Progress poll error', { taskId, error: e.message });
        }
    };

    // Poll immediately, then every second
    poll();
    _activePollTimers[taskId] = setInterval(poll, 1000);
}

function updateProgressBar(task, progressEl, fillEl, pctEl, stageEl) {
    const pct = PROGRESS_PCT_MAP[task.status] || 0;
    fillEl.style.width = `${pct}%`;
    pctEl.textContent = `${pct}%`;
    stageEl.textContent = task.stage || task.status;

    // Update fill class based on status
    fillEl.className = 'progress-fill-dl';
    if (task.status === 'complete') {
        fillEl.classList.add('complete');
    } else if (task.status === 'failed') {
        fillEl.classList.add('failed');
    } else if (task.status === 'downloading') {
        fillEl.classList.add('indeterminate');
    }

    // Update step indicators
    const steps = progressEl.querySelectorAll('.progress-step');
    const statusOrder = ['pending', 'downloading', 'processing', 'complete'];
    const currentIdx = statusOrder.indexOf(task.status);

    // Handle failed state explicitly (all steps show failure)
    if (task.status === 'failed') {
        steps.forEach(s => { s.className = 'progress-step failed'; });
        return;
    }

    steps.forEach((step, i) => {
        step.className = 'progress-step';
        if (i < currentIdx) {
            step.classList.add('done');
        } else if (i === currentIdx) {
            step.classList.add('active');
        }
    });
}

// Resume active downloads on page load (survives refresh)
function resumeActiveDownloads() {
    const active = localStorage.getItem('glitchi-active-download');
    if (!active) return;

    try {
        const info = JSON.parse(active);
        const age = Date.now() - info.startedAt;
        // Only resume if less than 10 minutes old
        if (age > 600000) {
            localStorage.removeItem('glitchi-active-download');
            return;
        }

        const isDetail = info.source === 'detail';
        const isInline = info.source === 'inline';

        // Inline downloads can't resume — card element is gone after page refresh
        if (isInline) {
            localStorage.removeItem('glitchi-active-download');
            return;
        }

        const progressEl = document.getElementById(isDetail ? 'detail-download-progress' : 'download-progress');
        const stageEl = document.getElementById(isDetail ? 'detail-progress-stage' : 'progress-stage');
        const pctEl = document.getElementById(isDetail ? 'detail-progress-pct' : 'progress-pct');
        const fillEl = document.getElementById(isDetail ? 'detail-progress-fill-dl' : 'progress-fill-dl');
        const btn = document.getElementById(isDetail ? 'btn-detail-download' : 'btn-download');

        if (progressEl) {
            progressEl.classList.remove('hidden');
            devLog('Resumed download progress', { taskId: info.taskId, source: info.source });
            pollDownloadProgress(info.taskId, progressEl, stageEl, pctEl, fillEl, info.source, btn);
        }
    } catch (e) {
        localStorage.removeItem('glitchi-active-download');
    }
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
                if (row.dataset.url) downloadFromDetail(row.dataset.url, row.dataset.artist, row.dataset.name);
            });
        });
        listEl.querySelectorAll('.track-row').forEach(row => {
            const plArtist = row.dataset.artist;
            const plName = row.dataset.name;
            row.addEventListener('click', (e) => {
                if (e.target.closest('.track-remove') || e.target.closest('.track-dl')) return;
                if (row.dataset.url) downloadFromDetail(row.dataset.url, plArtist, plName);
            });
        });
    }

    // Setup detail buttons for playlist
    document.getElementById('btn-detail-download').onclick = () => downloadPlaylistZip(playlist);
    document.getElementById('btn-detail-add-playlist').style.display = 'none';
    document.getElementById('btn-detail-open-spotify').style.display = 'none';

    document.getElementById('detail-modal').style.display = 'flex';
}

async function downloadPlaylistZip(playlist) {
    if (playlist.tracks.length === 0) {
        showToast('Playlist is empty', 'error');
        return;
    }

    // Use this browser's downloaded-files list (localStorage), not the global server list
    const localFiles = state.downloadedFiles;

    if (localFiles.length === 0) {
        showToast('No downloaded files yet — download some tracks first!', 'error');
        return;
    }

    // Try to match playlist tracks to downloaded files by name
    const matchedFiles = [];
    const unmatchedTracks = [];

    for (const track of playlist.tracks) {
        let found = false;
        const trackWords = track.name.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        for (const lf of localFiles) {
            const sfName = (lf.displayName || lf.filename || '').toLowerCase();
            if (trackWords.length > 0 && trackWords.every(w => sfName.includes(w))) {
                matchedFiles.push(lf.filename);
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

// ===== Utilities =====
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ===== Fetch Available Downloaders =====
async function fetchAvailableDownloaders() {
    try {
        const res = await fetch('/download/available');
        if (!res.ok) return;
        const data = await res.json();
        const sel = document.getElementById('settings-downloader');
        if (!sel) return;

        // Save current selection
        const current = state.defaultDownloader;

        // Rebuild options based on actually available downloaders
        sel.innerHTML = '';
        const allOptions = [
            { value: 'spotiflac', label: 'SpotiFLAC (Lossless, Qobuz/Tidal)' },
            { value: 'ytdlp', label: 'yt-dlp (YouTube Audio)' },
            { value: 'spotdl', label: 'SpotDL (Spotify → YouTube)' },
        ];

        for (const opt of allOptions) {
            const available = data.available.includes(opt.value);
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label + (available ? '' : ' [NOT INSTALLED]');
            option.disabled = !available;
            sel.appendChild(option);
        }

        // Restore or fallback
        if (data.available.includes(current)) {
            sel.value = current;
        } else if (data.available.length > 0) {
            sel.value = data.available[0];
            state.defaultDownloader = data.available[0];
            localStorage.setItem('glitchi-downloader', data.available[0]);
        }

        devLog('Available downloaders', { current: sel.value, available: data.available });
    } catch (e) {
        devLog('Failed to fetch downloaders', { error: e.message });
    }
}
