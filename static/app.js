/* ============================================================================
   Glitchi-Stream — frontend
   Vanilla JS, no build step. Sections:
     1. helpers / state        6. library & playlists
     2. boot & navigation      7. player
     3. changelog              8. downloads (single + playlist jobs)
     4. search                 9. keep-alive & polling
     5. detail view           10. utilities
   ========================================================================== */

'use strict';

/* ── 1. helpers / state ─────────────────────────────────────────────────── */

const LS = {
    theme: 'glitchi-theme',
    downloader: 'glitchi-downloader',
    playlists: 'glitchi-playlists',
    files: 'glitchi-downloaded-files',
    history: 'glitchi-listening-history',
    activeDownload: 'glitchi-active-download',
    job: 'glitchi-active-job',
    seenVersion: 'glitchi-seen-version',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}
function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
}

const state = {
    activeTab: 'home',
    theme: localStorage.getItem(LS.theme) || 'dark',
    defaultDownloader: localStorage.getItem(LS.downloader) || 'ytdlp',
    playlists: readJSON(LS.playlists, []),
    files: readJSON(LS.files, []),
    history: readJSON(LS.history, { streams: [], downloads: [], searches: [] }),
    detailItem: null,
    audio: null,
    playerTrack: null,
    librarySegment: 'files',
    playlist: null,          // { kind, name, cover, tracks: [] }
    playlistKey: null,       // Spotify id used for the /p/<id> deep link
    selected: new Set(),     // indexes into state.playlist.tracks
    job: null,               // { id, name, total, startedAt, status, autoZip }
    jobSnapshot: null,
    devNotes: null,
    filter: 'all',
    searchCache: {},
    pollContexts: {},        // taskId -> { btn, rowEl }
    worker: null,
    wakeLock: null,
};

const PROGRESS_PCT = { pending: 5, downloading: 35, processing: 80, complete: 100, failed: 100 };

/* ── 2. boot & navigation ───────────────────────────────────────────────── */

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

    const mobile = /android|iphone|ipad|ipod|webos|blackberry|iemobile|opera mini/i.test(ua)
        || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        || window.innerWidth <= 768;
    html.setAttribute('data-mobile', mobile ? 'true' : 'false');
    html.setAttribute('data-touch', ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 'true' : 'false');
}

document.addEventListener('DOMContentLoaded', () => {
    detectDevice();
    applyTheme(state.theme);
    buildThemeOptions();
    setupNavigation();
    setupSearch();
    setupLibrary();
    setupFiles();
    setupDownload();
    setupModals();
    setupSettings();
    setupPlaylists();
    setupPlayer();
    startPollWorker();

    $('#settings-downloader').value = state.defaultDownloader;
    $('#settings-theme').value = state.theme;

    const initialPlaylistId = currentPlaylistIdFromUrl();
    state.playlistKey = initialPlaylistId;
    openTab(initialPlaylistId ? 'download' : state.activeTab);
    renderPlaylists();
    loadFiles();
    fetchDownloaders();
    loadHome();
    if (initialPlaylistId) restorePlaylistPage(initialPlaylistId);
    else resumeJob();
    resumeSingleDownload();

    window.addEventListener('resize', detectDevice);
    window.addEventListener('online', () => showToast('Back online', 'info'));
    window.addEventListener('popstate', () => {
        const id = currentPlaylistIdFromUrl();
        if (!id) return;
        state.playlistKey = id;
        openTab('download');
        restorePlaylistPage(id);
    });
});

function setupNavigation() {
    $$('.nav-item[data-tab], .mobile-tab[data-tab]').forEach((el) => {
        el.addEventListener('click', () => openTab(el.dataset.tab));
    });
    $$('[data-tab-jump]').forEach((el) => {
        el.addEventListener('click', () => openTab(el.dataset.tabJump));
    });
}

function openTab(name) {
    if (name !== 'download') clearPlaylistUrl();
    state.activeTab = name;
    $$('.nav-item[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
    $$('.mobile-tab[data-tab]').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
    $$('.tab-content').forEach((el) => el.classList.toggle('active', el.id === `tab-${name}`));
    $('.main-content').scrollTop = 0;

    if (name === 'search') setTimeout(() => $('#search-input')?.focus(), 60);
    if (name === 'library') loadFiles();
    if (name === 'home') updateHomeCounts();
}

/* Deep links: /p/<spotify-id> reopens that playlist's job after a refresh. */

function currentPlaylistIdFromUrl() {
    const match = location.pathname.match(/^\/p\/([A-Za-z0-9]+)\/?$/);
    return match ? match[1] : null;
}

function setPlaylistUrl(playlistId) {
    if (!playlistId) return;
    const path = `/p/${encodeURIComponent(playlistId)}`;
    if (location.pathname !== path) history.replaceState({ playlistId }, '', path);
}

function clearPlaylistUrl() {
    if (location.pathname.startsWith('/p/')) history.replaceState({}, '', '/');
}

/* ── 3. theme + changelog ───────────────────────────────────────────────── */

const THEMES = [
    ['dark', 'Dark'], ['galactical', 'Galactical'], ['sunset', 'Sunset'], ['ocean', 'Ocean'],
    ['forest', 'Forest'], ['neon', 'Neon'], ['monochrome', 'Monochrome'], ['candy', 'Candy'],
    ['midnight', 'Midnight'], ['ember', 'Ember'], ['arctic', 'Arctic'], ['cyberpunk', 'Cyberpunk'],
    ['retro', 'Retro'], ['lavender', 'Lavender'], ['moss', 'Moss'], ['crimson', 'Crimson'],
    ['slate', 'Slate'], ['gold', 'Gold'],
];

function buildThemeOptions() {
    const select = $('#settings-theme');
    if (!select || select.options.length) return;
    select.innerHTML = THEMES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
}

function applyTheme(name) {
    state.theme = name;
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem(LS.theme, name);
    $$('.theme-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.theme === name));
    const select = $('#settings-theme');
    if (select) select.value = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#0a0a0c');
}

function setupThemeSwitcher() {
    $$('.theme-btn').forEach((btn) => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));
}
document.addEventListener('DOMContentLoaded', setupThemeSwitcher);

async function fetchDevNotes() {
    try {
        const res = await fetch('/static/dev-notes.json', { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

async function loadHome() {
    const notes = state.devNotes || await fetchDevNotes();
    if (notes) {
        state.devNotes = notes;
        $('#home-version').textContent = notes.version ? `v${notes.version.replace(/^v/, '')}` : '';
        $('#home-date').textContent = notes.releaseDate || '';
        const latest = (notes.changelog || []).slice(0, 3);
        $('#home-changelog-list').innerHTML = latest.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    }
    updateHomeCounts();
    maybeShowChangelog();
}

function updateHomeCounts() {
    const fileEl = $('#home-file-count');
    const plEl = $('#home-playlist-count');
    if (fileEl) fileEl.textContent = String(state.files.length);
    if (plEl) plEl.textContent = String(state.playlists.length);
}

async function maybeShowChangelog() {
    const notes = state.devNotes || await fetchDevNotes();
    if (!notes) return;
    state.devNotes = notes;
    let seen = null;
    try { seen = localStorage.getItem(LS.seenVersion); } catch (_) {}
    if (seen !== String(notes.version)) openChangelog(notes);
}

function openChangelog(notes) {
    if (!notes) notes = state.devNotes;
    if (!notes) return;
    state.devNotes = notes;
    $('#changelog-version').textContent = notes.version ? `v${notes.version.replace(/^v/, '')}` : 'Release notes';
    $('#changelog-date').textContent = notes.releaseDate || '';
    $('#changelog-title').textContent = notes.updateTitle || '';
    $('#changelog-list').innerHTML = (notes.changelog || [])
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('');
    $('#changelog-modal').style.display = 'flex';
    document.body.dataset.overlay = 'open';
}

function closeChangelog() {
    $('#changelog-modal').style.display = 'none';
    document.body.dataset.overlay = '';
    if (state.devNotes?.version) {
        try { localStorage.setItem(LS.seenVersion, String(state.devNotes.version)); } catch (_) {}
    }
}

function setupChangelog() {
    $$('[data-changelog]').forEach((btn) => btn.addEventListener('click', () => openChangelog(state.devNotes)));
    $('#changelog-close')?.addEventListener('click', closeChangelog);
    $('#changelog-ok')?.addEventListener('click', closeChangelog);
    $('#changelog-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeChangelog();
    });
}
document.addEventListener('DOMContentLoaded', setupChangelog);

/* ── 4. search ──────────────────────────────────────────────────────────── */

function setupSearch() {
    const input = $('#search-input');
    const clear = $('#search-clear');
    let timer;

    input.addEventListener('input', () => {
        clear.classList.toggle('hidden', input.value.length === 0);
        clearTimeout(timer);
        timer = setTimeout(doSearch, 260);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { clearTimeout(timer); doSearch(); }
    });
    clear.addEventListener('click', () => {
        input.value = '';
        clear.classList.add('hidden');
        doSearch();
        input.focus();
    });

    $$('.filter-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            $$('.filter-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            state.filter = chip.dataset.filter;
            if ($('#search-input').value.trim()) doSearch();
        });
    });

    $('#search-results').addEventListener('click', onResultClick);
}

function activeTypes() {
    return state.filter === 'all' ? 'track,album,artist,playlist' : state.filter;
}

async function doSearch() {
    const query = $('#search-input').value.trim();
    const results = $('#search-results');
    if (!query) {
        results.innerHTML = emptyState('search', 'Search for music to get started');
        return;
    }

    const key = `${query}|${activeTypes()}`;
    const cached = state.searchCache[key];
    if (cached && Date.now() - cached.at < 60000) {
        renderResults(cached.data, query);
        return;
    }

    results.innerHTML = '<div class="spinner"></div>';
    try {
        const res = await fetch(`/search/?q=${encodeURIComponent(query)}&type=${encodeURIComponent(activeTypes())}&limit=20`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Search failed' }));
            throw new Error(err.detail || 'Search failed');
        }
        const data = await res.json();
        state.searchCache[key] = { data, at: Date.now() };
        const keys = Object.keys(state.searchCache);
        if (keys.length > 40) delete state.searchCache[keys[0]];
        renderResults(data, query);
    } catch (err) {
        results.innerHTML = `<div class="empty-state"><p class="error-text">${escapeHtml(err.message)}</p></div>`;
    }
}

function onResultClick(e) {
    const card = e.target.closest('.card, .artist-item');
    if (!card) return;

    if (e.target.closest('.card-dl')) {
        e.stopPropagation();
        const btn = e.target.closest('.card-dl');
        startSingleDownload(card.dataset.url, card.dataset.artist || '', card.dataset.title || '', { btn });
        return;
    }

    openDetailView({
        type: card.dataset.type,
        id: card.dataset.id,
        name: card.dataset.title || '',
        artists: card.dataset.artist || '',
        cover: card.dataset.cover || '',
        url: card.dataset.url || '',
        album: card.dataset.album || '',
        duration: card.dataset.duration || '',
        releaseDate: card.dataset.release || '',
        genres: card.dataset.genres || '',
        tracksCount: card.dataset.tracks || '',
    });
}

function coverMarkup(url) {
    if (!url) return '<div class="card-cover-card"><div class="card-cover-fallback"><svg viewBox="0 0 24 24" fill="none"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/></svg></div></div>';
    return `<div class="card-cover-card">
        <img src="${escapeHtml(url)}" class="card-cover" loading="lazy" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="card-cover-fallback" style="display:none"><svg viewBox="0 0 24 24" fill="none"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/></svg></div>
    </div>`;
}

function renderResults(data, query) {
    const el = $('#search-results');
    let html = '';

    const dlBtn = `<button class="card-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></button>`;

    if (data.tracks?.length) {
        html += `<section class="result-section"><h2>Tracks<span class="count">${data.tracks.length}</span></h2><div class="results-grid">`;
        data.tracks.forEach((t) => {
            html += `<article class="card" data-type="track" data-id="${escapeHtml(t.id)}" data-title="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.album_image_url)}" data-url="${escapeHtml(t.url)}" data-duration="${t.duration_ms}" data-album="${escapeHtml(t.album)}">
                ${coverMarkup(t.album_image_url)}
                <div class="card-body">
                    <div class="card-title">${escapeHtml(t.name)}</div>
                    <div class="card-subtitle">${escapeHtml(t.artists)}</div>
                    <div class="card-meta">${escapeHtml(t.album || '')}${t.duration_ms ? ` · ${formatDuration(t.duration_ms)}` : ''}</div>
                </div>
                <div class="card-actions">${dlBtn}</div>
            </article>`;
        });
        html += '</div></section>';
    }

    if (data.albums?.length) {
        html += `<section class="result-section"><h2>Albums<span class="count">${data.albums.length}</span></h2><div class="results-grid">`;
        data.albums.forEach((a) => {
            html += `<article class="card" data-type="album" data-id="${escapeHtml(a.id)}" data-title="${escapeHtml(a.name)}" data-artist="${escapeHtml(a.artists)}" data-cover="${escapeHtml(a.image_url)}" data-url="${escapeHtml(a.url)}" data-release="${escapeHtml(a.release_date)}" data-tracks="${a.total_tracks}">
                ${coverMarkup(a.image_url)}
                <div class="card-body">
                    <div class="card-title">${escapeHtml(a.name)}</div>
                    <div class="card-subtitle">${escapeHtml(a.artists)}</div>
                    <div class="card-meta">${escapeHtml(a.release_date || 'Album')}</div>
                </div>
            </article>`;
        });
        html += '</div></section>';
    }

    if (data.artists?.length) {
        html += `<section class="result-section"><h2>Artists<span class="count">${data.artists.length}</span></h2><div class="artist-list">`;
        data.artists.forEach((ar) => {
            const avatar = ar.image_url
                ? `<img src="${escapeHtml(ar.image_url)}" class="artist-avatar" loading="lazy" alt="" onerror="this.style.display='none'">`
                : `<div class="artist-avatar fallback"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div>`;
            html += `<div class="artist-item" data-type="artist" data-id="${escapeHtml(ar.id)}" data-title="${escapeHtml(ar.name)}" data-cover="${escapeHtml(ar.image_url)}" data-url="${escapeHtml(ar.url)}" data-genres="${escapeHtml(ar.genres)}">
                ${avatar}
                <div class="artist-text">
                    <div class="artist-name">${escapeHtml(ar.name)}</div>
                    ${ar.genres ? `<div class="artist-meta">${escapeHtml(ar.genres)}</div>` : '<div class="artist-meta">Artist</div>'}
                </div>
                <svg class="chev" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>`;
        });
        html += '</div></section>';
    }

    if (data.playlists?.length) {
        html += `<section class="result-section"><h2>Playlists<span class="count">${data.playlists.length}</span></h2><div class="results-grid">`;
        data.playlists.forEach((p) => {
            html += `<article class="card" data-type="playlist" data-id="${escapeHtml(p.id)}" data-title="${escapeHtml(p.name)}" data-artist="${escapeHtml(p.owner)}" data-cover="${escapeHtml(p.image_url)}" data-url="${escapeHtml(p.url)}" data-tracks="${p.tracks_count}">
                ${coverMarkup(p.image_url)}
                <div class="card-body">
                    <div class="card-title">${escapeHtml(p.name)}</div>
                    <div class="card-subtitle">${escapeHtml(p.owner || 'Playlist')}</div>
                    <div class="card-meta">${p.tracks_count} tracks</div>
                </div>
            </article>`;
        });
        html += '</div></section>';
    }

    if (!html) html = emptyState('search', `No results for “${query}”`);
    el.innerHTML = html;
}

/* ── 5. detail view ─────────────────────────────────────────────────────── */

function openDetailView(item) {
    state.detailItem = item;
    $('#detail-download-progress').classList.add('hidden');
    $('#detail-type').textContent = (item.type || '').toUpperCase();
    $('#detail-title').textContent = item.name || '';
    $('#detail-subtitle').textContent = item.artists || '';
    $('#detail-meta').textContent = [
        item.album ? `Album: ${item.album}` : '',
        item.releaseDate ? `Released: ${item.releaseDate}` : '',
        item.duration ? formatDuration(parseInt(item.duration, 10)) : '',
        item.genres || '',
        item.tracksCount ? `${item.tracksCount} tracks` : '',
    ].filter(Boolean).join(' · ');

    const cover = $('#detail-cover');
    if (item.cover) { cover.src = item.cover; cover.style.display = ''; }
    else cover.style.display = 'none';

    const tracksSection = $('#detail-tracks');
    if (item.type === 'artist') {
        tracksSection.style.display = 'none';
    } else {
        tracksSection.style.display = '';
        if (item.type === 'album' && item.id) fetchAlbumTracks(item.id, item.cover);
        else $('#detail-tracks-list').innerHTML = '';
    }

    const dl = $('#btn-detail-download');
    const add = $('#btn-detail-add-playlist');
    const open = $('#btn-detail-open-spotify');
    dl.style.display = ''; add.style.display = ''; open.style.display = '';
    if (item.type === 'playlist') dl.style.display = 'none';

    dl.onclick = () => {
        if (!item.url) return showToast('No Spotify URL available', 'error');
        closeDetailView();
        openTab('download');
        $('#download-url').value = item.url;
        handleImport();
    };
    add.onclick = () => openPlaylistPicker(item);
    open.onclick = () => { if (item.url) window.open(item.url, '_blank', 'noopener'); };

    $('#detail-modal').classList.remove('hidden');
}

function closeDetailView() {
    $('#detail-modal').classList.add('hidden');
}

async function fetchAlbumTracks(albumId, coverUrl) {
    const list = $('#detail-tracks-list');
    list.innerHTML = '<div class="spinner"></div>';
    try {
        const res = await fetch(`/playlists/album-tracks/${encodeURIComponent(albumId)}`);
        if (!res.ok) throw new Error('Failed to load album tracks');
        const data = await res.json();
        const tracks = data.tracks || [];
        if (!tracks.length) {
            list.innerHTML = '<p class="muted-text">No tracks found</p>';
            return;
        }
        list.innerHTML = tracks.map((t, i) => {
            const img = t.album_image_url || coverUrl;
            return `<div class="track-row" data-url="${escapeHtml(t.url)}" data-name="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}">
                <span class="track-num">${i + 1}</span>
                ${img ? `<img class="track-cover" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
                <div class="track-info"><div class="track-name">${escapeHtml(t.name)}</div><div class="track-artist">${escapeHtml(t.artists)}</div></div>
                <span class="track-duration">${formatDuration(t.duration_ms)}</span>
                <button class="icon-btn track-dl" title="Download"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
            </div>`;
        }).join('');

        $$('.track-row', list).forEach((row) => {
            row.addEventListener('click', (e) => {
                const btn = e.target.closest('.track-dl');
                if (btn) {
                    e.stopPropagation();
                    startSingleDownload(row.dataset.url, row.dataset.artist, row.dataset.name, { btn });
                    return;
                }
                if (row.dataset.url) startSingleDownload(row.dataset.url, row.dataset.artist, row.dataset.name);
            });
        });
    } catch (err) {
        list.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
}

/* ── 6. library & playlists ─────────────────────────────────────────────── */

function setupFiles() {
    $('#refresh-files').addEventListener('click', () => {
        loadFiles(true);
        showToast('Library refreshed', 'info');
    });
    $('#files-list').addEventListener('click', (e) => {
        const play = e.target.closest('.file-btn-play');
        const dl = e.target.closest('.file-btn-download');
        if (play) playFile(play.dataset.filename);
        if (dl) triggerFileDownload(dl.dataset.filename);
    });
}

async function loadFiles(force) {
    let server = null;
    try {
        const res = await fetch('/files/', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            server = data.files || [];
        }
    } catch (_) { /* offline: fall back to cached list */ }

    if (server) {
        const stamps = new Map(state.files.map((f) => [f.filename, f.downloadedAt]));
        const sizes = new Map(state.files.map((f) => [f.filename, f.sizeMb]));
        state.files = server.map((f) => ({
            filename: f.filename,
            displayName: f.filename.split('/').pop(),
            sizeMb: f.size_mb,
            downloadedAt: stamps.get(f.filename) || null,
        }));
        writeJSON(LS.files, state.files);
    } else if (force) {
        showToast('Could not reach the server', 'error');
    }
    renderFiles();
    updateHomeCounts();
}

function renderFiles() {
    const box = $('#files-list');
    const count = $('#files-count');
    if (count) count.textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'}`;

    if (!state.files.length) {
        box.innerHTML = emptyState('files', 'No downloaded files yet. Paste a playlist link to get started.');
        return;
    }

    box.innerHTML = state.files.map((f) => {
        const name = f.displayName || f.filename.split('/').pop();
        const meta = [
            f.sizeMb ? `${Number(f.sizeMb).toFixed(1)} MB` : '',
            f.downloadedAt ? new Date(f.downloadedAt).toLocaleDateString() : '',
        ].filter(Boolean).join(' · ');
        return `<div class="file-card">
            <div class="file-icon">
                <svg viewBox="0 0 24 24" fill="none"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/></svg>
            </div>
            <div class="file-details">
                <div class="file-name" title="${escapeHtml(f.filename)}">${escapeHtml(name)}</div>
                <div class="file-size">${escapeHtml(meta || 'Ready')}</div>
            </div>
            <div class="file-actions">
                <button class="icon-btn file-btn-play" data-filename="${escapeHtml(f.filename)}" title="Play">
                    <svg viewBox="0 0 24 24" fill="none"><polygon points="7,4 20,12 7,20" fill="currentColor"/></svg>
                </button>
                <button class="icon-btn file-btn-download" data-filename="${escapeHtml(f.filename)}" title="Save to device">
                    <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
            </div>
        </div>`;
    }).join('');
}

function trackDownloadedFile(filename) {
    if (!filename) return;
    const displayName = filename.split('/').pop();
    if (!state.files.find((f) => f.filename === filename)) {
        state.files.unshift({ filename, displayName, downloadedAt: Date.now() });
        writeJSON(LS.files, state.files);
    }
    const base = displayName.replace(/\.[^.]+$/, '');
    const parts = base.split(' - ');
    if (parts.length >= 2) trackHistory('downloads', parts[0].trim(), parts.slice(1).join(' - ').trim());
}

function setupLibrary() {
    $$('#library-segment .segment-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.librarySegment = btn.dataset.segment;
            $$('#library-segment .segment-btn').forEach((b) => b.classList.toggle('active', b.dataset.segment === state.librarySegment));
            $$('.segment-panel').forEach((p) => p.classList.toggle('active', p.id === `segment-${state.librarySegment}`));
        });
    });
}

function setupPlaylists() {
    $('#btn-new-playlist').addEventListener('click', () => {
        const name = prompt('Playlist name:');
        if (!name || !name.trim()) return;
        state.playlists.unshift({ id: Date.now().toString(), name: name.trim(), tracks: [], createdAt: Date.now() });
        savePlaylists();
        renderPlaylists();
        showToast(`Playlist “${name.trim()}” created`, 'success');
    });
    $('#playlists-list').addEventListener('click', (e) => {
        const card = e.target.closest('.playlist-card');
        if (!card) return;
        const playlist = state.playlists.find((p) => p.id === card.dataset.playlistId);
        if (!playlist) return;
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'zip') { e.stopPropagation(); downloadPlaylistZip(playlist); return; }
        if (action === 'delete') {
            e.stopPropagation();
            if (!confirm(`Delete playlist “${playlist.name}”?`)) return;
            state.playlists = state.playlists.filter((p) => p.id !== playlist.id);
            savePlaylists(); renderPlaylists(); updateHomeCounts();
            showToast('Playlist deleted', 'info');
            return;
        }
        openLocalPlaylist(playlist);
    });
}

function savePlaylists() { writeJSON(LS.playlists, state.playlists); }

function renderPlaylists() {
    const box = $('#playlists-list');
    updateHomeCounts();
    if (!state.playlists.length) {
        box.innerHTML = emptyState('playlist', 'No playlists yet. Create one to get started.');
        return;
    }
    box.innerHTML = state.playlists.map((p) => `<div class="playlist-card" data-playlist-id="${p.id}">
        <div class="playlist-card-text">
            <div class="playlist-card-name">${escapeHtml(p.name)}</div>
            <div class="playlist-card-count">${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'}</div>
        </div>
        <div class="playlist-card-actions">
            <button class="icon-btn" data-action="zip" title="Download ZIP">
                <svg viewBox="0 0 24 24" fill="none"><path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2z" stroke="currentColor" stroke-width="1.6"/><path d="M12 4v6m0 0l-2-2m2 2l2-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn danger" data-action="delete" title="Delete">
                <svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
        </div>
    </div>`).join('');
}

function openLocalPlaylist(playlist) {
    $('#detail-type').textContent = 'PLAYLIST';
    $('#detail-title').textContent = playlist.name;
    $('#detail-subtitle').textContent = `${playlist.tracks.length} tracks`;
    $('#detail-meta').textContent = playlist.createdAt ? `Created ${new Date(playlist.createdAt).toLocaleDateString()}` : '';
    $('#detail-cover').style.display = 'none';
    $('#detail-tracks').style.display = '';

    const list = $('#detail-tracks-list');
    if (!playlist.tracks.length) {
        list.innerHTML = '<p class="muted-text">No tracks in this playlist</p>';
    } else {
        list.innerHTML = playlist.tracks.map((t, i) => `<div class="track-row" data-index="${i}">
            <span class="track-num">${i + 1}</span>
            ${t.cover ? `<img class="track-cover" src="${escapeHtml(t.cover)}" alt="" onerror="this.remove()">` : ''}
            <div class="track-info"><div class="track-name">${escapeHtml(t.name)}</div><div class="track-artist">${escapeHtml(t.artists)}</div></div>
            <button class="icon-btn track-remove" title="Remove"><svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        </div>`).join('');

        $$('.track-remove', list).forEach((btn) => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            playlist.tracks.splice(Number(btn.closest('.track-row').dataset.index), 1);
            savePlaylists(); openLocalPlaylist(playlist); renderPlaylists();
        }));
    }

    const dl = $('#btn-detail-download');
    dl.style.display = '';
    dl.onclick = () => downloadPlaylistZip(playlist);
    $('#btn-detail-add-playlist').style.display = 'none';
    $('#btn-detail-open-spotify').style.display = 'none';
    $('#detail-modal').classList.remove('hidden');
}

async function downloadPlaylistZip(playlist) {
    if (!playlist.tracks.length) return showToast('Playlist is empty', 'error');

    const matched = [];
    for (const track of playlist.tracks) {
        const words = `${track.name || ''} ${track.artists || ''}`.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
        const hit = state.files.find((f) => {
            const name = (f.displayName || f.filename).toLowerCase();
            return words.length > 0 && words.every((w) => name.includes(w));
        });
        if (hit) matched.push(hit.filename);
    }

    if (!matched.length) return showToast('None of these tracks are downloaded yet', 'error');

    try {
        const res = await fetch('/playlists/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: matched }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'ZIP creation failed' }));
            throw new Error(err.detail || 'ZIP creation failed');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${playlist.name.replace(/[^a-z0-9]+/gi, '_') || 'playlist'}.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        showToast(`ZIP ready — ${matched.length} tracks`, 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

/* ── 7. player ──────────────────────────────────────────────────────────── */

function setupPlayer() {
    $('#mini-player-tap').addEventListener('click', (e) => {
        if (e.target.closest('#ctrl-play')) return;
        openNowPlaying();
    });
    $('#np-close').addEventListener('click', closeNowPlaying);
    $('#now-playing-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeNowPlaying();
    });
    $('#ctrl-play').addEventListener('click', togglePlay);
    $('#ctrl-play-lg').addEventListener('click', togglePlay);
    $('#ctrl-download-current').addEventListener('click', () => {
        if (state.playerTrack?.filename) triggerFileDownload(state.playerTrack.filename);
    });
    $('#np-progress-track').addEventListener('click', (e) => {
        if (!state.audio?.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        state.audio.currentTime = ((e.clientX - rect.left) / rect.width) * state.audio.duration;
    });
    $('#player-volume-slider').addEventListener('input', (e) => {
        if (state.audio) state.audio.volume = e.target.value / 100;
    });
    $('#ctrl-volume').addEventListener('click', () => {
        if (!state.audio) return;
        state.audio.muted = !state.audio.muted;
        $('#ctrl-volume').classList.toggle('active', state.audio.muted);
    });
}

function openNowPlaying() {
    if (!state.audio) return;
    $('#now-playing-overlay').classList.remove('hidden');
}
function closeNowPlaying() {
    $('#now-playing-overlay').classList.add('hidden');
}
function togglePlay() {
    if (!state.audio) return;
    if (state.audio.paused) state.audio.play().catch(() => showToast('Tap to play', 'info'));
    else state.audio.pause();
}

function setPlayIcons(playing) {
    const markup = playing
        ? '<svg viewBox="0 0 24 24" fill="none"><rect x="6.5" y="4" width="4" height="16" rx="1.2" fill="currentColor"/><rect x="13.5" y="4" width="4" height="16" rx="1.2" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none"><polygon points="7,4 20,12 7,20" fill="currentColor"/></svg>';
    ['#ctrl-play', '#ctrl-play-lg'].forEach((sel) => {
        const el = $(sel);
        if (el) el.innerHTML = markup;
    });
}

function playFile(filename) {
    const rawName = filename.split('/').pop() || filename;
    const displayName = rawName.replace(/\.[^.]+$/, '').replace(/_\d{6,}$/, '');
    const parts = displayName.split(' - ');
    const artist = parts.length >= 2 ? parts[0].trim() : '';
    const title = parts.length >= 2 ? parts.slice(1).join(' - ').trim() : displayName;

    trackHistory('streams', artist, title);

    if (state.audio) {
        state.audio.pause();
        state.audio.src = '';
        state.audio = null;
    }

    const src = `/files/stream?filename=${encodeURIComponent(filename)}`;
    const audio = new Audio(src);
    audio.volume = Number($('#player-volume-slider').value) / 100;
    state.audio = audio;
    state.playerTrack = { name: title, artists: artist, filename };

    $('#mini-player').classList.remove('hidden');
    $('#mini-player-track').textContent = title;
    $('#mini-player-artist').textContent = artist;
    $('#mini-player-progress-fill').style.width = '0%';
    $('#mini-player-cover-img').style.display = 'none';

    $('#np-track-name').textContent = title;
    $('#np-artist-name').textContent = artist;
    $('#np-progress-fill').style.width = '0%';
    $('#np-time-current').textContent = '0:00';
    $('#np-time-total').textContent = '0:00';
    $('#np-cover').style.display = 'none';
    $('#np-cover-placeholder').style.display = 'flex';

    audio.addEventListener('loadedmetadata', () => {
        $('#np-time-total').textContent = formatTime(audio.duration || 0);
    });
    audio.addEventListener('play', () => setPlayIcons(true));
    audio.addEventListener('pause', () => setPlayIcons(false));
    audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        $('#mini-player-progress-fill').style.width = `${pct}%`;
        $('#np-progress-fill').style.width = `${pct}%`;
        $('#np-time-current').textContent = formatTime(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
        setPlayIcons(false);
        $('#mini-player-progress-fill').style.width = '0%';
        $('#np-progress-fill').style.width = '0%';
        $('#np-time-current').textContent = '0:00';
    });
    audio.addEventListener('error', () => showToast('Could not play that file', 'error'));

    audio.play().then(() => {
        showToast(`Playing ${title}`, 'info');
    }).catch(() => setPlayIcons(false));
}

/* ── 8. downloads ───────────────────────────────────────────────────────── */

function setupDownload() {
    $('#btn-download').addEventListener('click', handleImport);
    $('#download-url').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleImport();
    });
    $('#pl-select-all').addEventListener('change', (e) => {
        const boxes = $$('#pl-tracks .pt-check input');
        state.selected.clear();
        boxes.forEach((box) => {
            box.checked = e.target.checked;
            if (e.target.checked) state.selected.add(Number(box.dataset.idx));
        });
        updateSelectionUI();
    });
    $('#pl-tracks').addEventListener('click', onPlaylistTrackClick);
    $('#pl-download-selected').addEventListener('click', () => {
        const tracks = [...state.selected].map((i) => state.playlist?.tracks[i]).filter(Boolean);
        startJob(tracks, 'Spotify selection', false);
    });
    $('#pl-download-all').addEventListener('click', () => {
        const tracks = state.playlist?.tracks || [];
        startJob(tracks, 'Spotify playlist', true);
    });
    $('#pl-zip').addEventListener('click', () => {
        if (state.job) downloadJobZip(state.job.id, state.job.name);
    });
    $('#job-zip').addEventListener('click', () => {
        if (state.job?.id) downloadJobZip(state.job.id, state.job.name);
    });
    $('#job-copy').addEventListener('click', async () => {
        if (!state.playlistKey) return showToast('No shareable link for this job', 'error');
        const url = `${location.origin}/p/${state.playlistKey}`;
        try {
            await navigator.clipboard.writeText(url);
            showToast('Link copied — reopen it any time', 'success');
        } catch (_) {
            prompt('Copy this link', url);
        }
    });
    $('#job-dismiss').addEventListener('click', () => {
        $('#job-panel').classList.add('hidden');
    });
}

function classifyUrl(url) {
    if (/open\.spotify\.com\/(?:intl-[^/]+\/)?track\//.test(url)) return 'track';
    if (/open\.spotify\.com\/(?:intl-[^/]+\/)?album\//.test(url)) return 'album';
    if (/open\.spotify\.com\/(?:intl-[^/]+\/)?playlist\//.test(url)) return 'playlist';
    return null;
}

function spotifyId(url) {
    const m = url.match(/\/(?:track|album|playlist)\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
}

async function handleImport() {
    const url = $('#download-url').value.trim();
    const status = $('#download-status');
    status.classList.add('hidden');

    if (!url) return showToast('Paste a Spotify link first', 'error');
    const kind = classifyUrl(url);
    if (!kind) return showToast('That does not look like a Spotify link', 'error');

    if (kind === 'track') {
        startSingleDownload(url, '', '');
        return;
    }

    const label = $('#btn-download-label');
    label.textContent = 'Loading…';
    $('#btn-download').disabled = true;
    $('#download-url').blur();

    try {
        if (kind === 'album') {
            const id = spotifyId(url);
            if (!id) throw new Error('Could not read that album link');
            const res = await fetch(`/playlists/album-tracks/${encodeURIComponent(id)}`);
            if (!res.ok) throw new Error('Album lookup failed');
            const data = await res.json();
            const tracks = (data.tracks || []).map((t) => ({
                name: t.name,
                artists: t.artists,
                cover: t.album_image_url,
                duration: t.duration_ms,
                url: t.url,
            }));
            if (!tracks.length) throw new Error('No tracks found in that album');
            renderPlaylistPanel({ kind: 'Album', name: 'Spotify album', cover: tracks[0].cover, tracks, key: id });
        } else {
            const id = spotifyId(url);
            const res = await fetch('/download/playlist-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, quality: 'HIGH' }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: 'Could not load that playlist' }));
                throw new Error(err.detail || 'Could not load that playlist');
            }
            const data = await res.json();
            const tracks = (data.tracks || []).map((t) => ({
                name: t.name,
                artists: t.artists,
                cover: t.album_image_url,
                duration: t.duration_ms,
                url: t.url,
            }));
            if (!tracks.length) throw new Error('That playlist has no tracks');
            renderPlaylistPanel({ kind: 'Playlist', name: 'Spotify playlist', cover: tracks[0].cover, tracks, key: id });
        }
    } catch (err) {
        showToast(err.message || 'Could not load that link', 'error');
        $('#download-status').textContent = err.message || 'Could not load that link';
        $('#download-status').classList.remove('hidden');
    } finally {
        label.textContent = 'Load';
        $('#btn-download').disabled = false;
    }
}

function renderPlaylistPanel({ kind, name, cover, tracks, key }) {
    state.playlist = { kind, name, cover, tracks };
    state.playlistKey = key || null;
    state.selected.clear();

    $('#pl-kind').textContent = kind;
    $('#pl-name').textContent = `${tracks.length} tracks`;
    $('#pl-sub').textContent = `${name} · ${tracks.length} track${tracks.length === 1 ? '' : 's'}`;

    const img = $('#pl-cover');
    const fallback = $('#pl-cover-fallback');
    if (cover) {
        img.src = cover;
        img.style.display = '';
        fallback.style.display = 'none';
    } else {
        img.style.display = 'none';
        fallback.style.display = 'flex';
    }

    $('#pl-tracks').innerHTML = tracks.map((t, i) => `<div class="pt-row" data-idx="${i}" data-url="${escapeHtml(t.url)}">
        <label class="pt-check">
            <input type="checkbox" data-idx="${i}">
            <span class="pt-box"></span>
        </label>
        <span class="pt-index">${i + 1}</span>
        ${t.cover ? `<img class="pt-cover" src="${escapeHtml(t.cover)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<div class="pt-cover fallback"></div>'}
        <div class="pt-info">
            <div class="pt-name">${escapeHtml(t.name || 'Unknown track')}</div>
            <div class="pt-artist">${escapeHtml(t.artists || '')}</div>
        </div>
        <span class="pt-duration">${formatDuration(t.duration)}</span>
        <span class="pt-status" data-status-for="${i}"></span>
        <button class="icon-btn pt-dl" data-idx="${i}" title="Download this track">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
    </div>`).join('');

    updateSelectionUI();
    $('#playlist-panel').classList.remove('hidden');
    $('#playlist-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onPlaylistTrackClick(e) {
    const row = e.target.closest('.pt-row');
    if (!row) return;
    const idx = Number(row.dataset.idx);
    const track = state.playlist?.tracks[idx];
    if (!track) return;

    if (e.target.closest('.pt-dl')) {
        e.stopPropagation();
        startSingleDownload(track.url, track.artists, track.name, { rowEl: row });
        return;
    }
    if (e.target.closest('.pt-check')) {
        // native checkbox handles itself; sync state after the change event
        setTimeout(() => {
            const box = row.querySelector('input[type="checkbox"]');
            if (box.checked) state.selected.add(idx); else state.selected.delete(idx);
            updateSelectionUI();
        }, 0);
    }
}

function updateSelectionUI() {
    const total = state.playlist?.tracks.length || 0;
    const selected = state.selected.size;
    const all = $('#pl-select-all');
    const count = $('#pl-selected-count');

    if (all) {
        all.checked = total > 0 && selected === total;
        all.indeterminate = selected > 0 && selected < total;
    }
    if (count) count.textContent = `${selected} of ${total} selected`;
    $('#pl-download-selected').disabled = selected === 0;
    $('#pl-download-all').disabled = total === 0;
}

/* ── single track download ── */

async function startSingleDownload(url, artist, title, opts = {}) {
    if (!url) return showToast('No Spotify URL for that track', 'error');
    const btn = opts.btn;
    const row = opts.rowEl;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }

    showProgressCard(title || 'Downloading track…');
    setProgress('pending', 'Queued…');
    keepAwake();

    try {
        const res = await fetch('/download/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
                url,
                quality: 'HIGH',
                downloader: state.defaultDownloader,
                artist: artist || '',
                title: title || '',
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Could not start download' }));
            throw new Error(err.detail || 'Could not start download');
        }
        const data = await res.json();
        state.pollContexts[data.task_id] = { btn, rowEl: row, title: title || '' };
        writeJSON(LS.activeDownload, { taskId: data.task_id, title: title || '', startedAt: Date.now() });
        setRowStatus(row, 'pending');
        state.worker?.postMessage({ action: 'start', taskId: data.task_id });
    } catch (err) {
        showToast(err.message, 'error');
        hideProgressCard();
        if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
        setRowStatus(row, null);
        syncWakeLock();
    }
}

function showProgressCard(title) {
    $('#progress-title').textContent = title;
    $('#progress-pct').textContent = '0%';
    $('#progress-fill-dl').style.width = '0%';
    $('#progress-fill-dl').className = 'progress-fill';
    $('#download-progress').classList.remove('hidden');
}

function hideProgressCard() {
    $('#download-progress').classList.add('hidden');
}

function setProgress(stage, detail) {
    const pct = PROGRESS_PCT[stage] ?? 0;
    $('#progress-pct').textContent = `${pct}%`;
    $('#progress-fill-dl').style.width = `${pct}%`;
    $('#progress-fill-dl').className = `progress-fill ${stage}`;
    $('#progress-title').textContent = detail || stage;
    const order = ['pending', 'downloading', 'processing', 'complete'];
    const idx = order.indexOf(stage);
    $$('#download-progress .progress-step').forEach((step) => {
        const stepIdx = order.indexOf(step.dataset.step);
        step.classList.toggle('done', stepIdx < idx);
        step.classList.toggle('active', stepIdx === idx);
        step.classList.toggle('failed', stage === 'failed');
    });
}

function onSingleProgress(task) {
    setProgress(task.status, task.stage || task.status);
    const ctx = state.pollContexts[task.task_id];

    if (task.status === 'complete') {
        delete state.pollContexts[task.task_id];
        try { localStorage.removeItem(LS.activeDownload); } catch (_) {}
        if (ctx?.btn) { ctx.btn.disabled = false; ctx.btn.classList.remove('busy'); }
        setRowStatus(ctx?.rowEl, 'complete');

        if (task.filename) {
            const name = task.filename.split('/').pop();
            trackDownloadedFile(task.filename);
            showToast(`Saved ${name}`, 'success');
            triggerFileDownload(task.filename);
            loadFiles();
        }
        setTimeout(hideProgressCard, 2600);
        syncWakeLock();
    } else if (task.status === 'failed') {
        delete state.pollContexts[task.task_id];
        try { localStorage.removeItem(LS.activeDownload); } catch (_) {}
        if (ctx?.btn) { ctx.btn.disabled = false; ctx.btn.classList.remove('busy'); }
        setRowStatus(ctx?.rowEl, 'failed');
        showToast(task.error || 'Download failed', 'error');
        setTimeout(hideProgressCard, 3200);
        syncWakeLock();
    } else {
        setRowStatus(ctx?.rowEl, task.status);
    }
}

function setRowStatus(row, status) {
    if (!row) return;
    const el = row.querySelector('.pt-status');
    if (!el) return;
    const labels = { pending: 'Queued', downloading: 'Downloading', processing: 'Tagging', complete: 'Ready', failed: 'Failed' };
    el.textContent = labels[status] || '';
    el.className = `pt-status ${status || ''}`;
    row.classList.toggle('done', status === 'complete');
}

async function resumeSingleDownload() {
    const saved = readJSON(LS.activeDownload, null);
    if (!saved?.taskId) return;
    if (Date.now() - (saved.startedAt || 0) > 45 * 60 * 1000) {
        try { localStorage.removeItem(LS.activeDownload); } catch (_) {}
        return;
    }
    try {
        const res = await fetch(`/download/progress/${saved.taskId}`);
        if (!res.ok) throw new Error('gone');
        const task = await res.json();
        showProgressCard(saved.title || 'Downloading track…');
        state.pollContexts[saved.taskId] = { btn: null, rowEl: null, title: saved.title || '' };
        state.worker?.postMessage({ action: 'start', taskId: saved.taskId });
        onSingleProgress({ task_id: saved.taskId, ...task });
    } catch (_) {
        try { localStorage.removeItem(LS.activeDownload); } catch (_) {}
    }
}

/* ── playlist jobs (server-side, survive backgrounding) ── */

async function startJob(tracks, name, autoZip) {
    const usable = (tracks || []).filter((t) => t?.url);
    if (!usable.length) return showToast('Nothing to download', 'error');

    $('#pl-download-selected').disabled = true;
    $('#pl-download-all').disabled = true;
    showToast(`Starting ${usable.length} track${usable.length === 1 ? '' : 's'}…`, 'info');
    keepAwake();

    try {
        const res = await fetch('/playlists/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
                name,
                playlist_id: state.playlistKey || '',
                quality: 'HIGH',
                downloader: state.defaultDownloader,
                tracks: usable.map((t) => ({ url: t.url, artist: t.artists || '', title: t.name || '' })),
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Could not start the job' }));
            throw new Error(err.detail || 'Could not start the job');
        }
        const job = await res.json();
        state.job = { id: job.job_id, name, total: job.total, startedAt: Date.now(), status: 'running', autoZip: !!autoZip };
        state.jobSnapshot = job;
        state._zipFired = false;
        writeJSON(LS.job, { id: state.job.id, name, total: state.job.total, startedAt: state.job.startedAt, autoZip: !!autoZip });
        setPlaylistUrl(state.playlistKey);
        applyJobSnapshot(job);
        state.worker?.postMessage({ action: 'startJob', jobId: job.job_id });
    } catch (err) {
        showToast(err.message, 'error');
        syncWakeLock();
    } finally {
        updateSelectionUI();
    }
}

function applyJobSnapshot(job) {
    if (!job) return;
    if (!state.job || state.job.id !== job.job_id) {
        const saved = readJSON(LS.job, null);
        state.job = {
            id: job.job_id,
            name: saved?.name || job.name || 'Playlist',
            total: job.total,
            startedAt: saved?.startedAt || Date.now(),
            autoZip: !!saved?.autoZip,
            status: job.status,
        };
    }
    state.job.status = job.status;
    state.jobSnapshot = job;

    $('#job-panel').classList.remove('hidden');
    $('#job-name').textContent = state.job.name || 'Playlist';
    const done = job.completed + job.failed;
    const pct = job.total ? Math.round((done / job.total) * 100) : 0;
    $('#job-fill').style.width = `${pct}%`;
    $('#job-count').textContent = `${done} / ${job.total}`;

    const stageText = job.status === 'complete'
        ? (job.failed ? `Finished with ${job.failed} failed` : 'All tracks ready')
        : `Downloading ${done} of ${job.total}…`;
    $('#job-stage').textContent = stageText;

    const zipBtn = $('#job-zip');
    zipBtn.disabled = job.completed === 0;
    zipBtn.textContent = job.completed ? `Download ZIP (${job.completed})` : 'Download ZIP';
    $('#pl-zip').disabled = job.completed === 0;

    $('#job-note').textContent = job.status === 'complete'
        ? (job.failed ? 'Some tracks failed — the ZIP contains the ones that worked.' : 'Your ZIP is ready to save.')
        : 'Downloads run on the server — switch apps and they keep going.';

    // per-track status chips, matched by Spotify URL
    const rows = $$('#pl-tracks .pt-row');
    (job.items || []).forEach((item) => {
        const row = rows.find((r) => r.dataset.url === item.url) || null;
        setRowStatus(row, item.status);
    });

    if (job.status === 'complete') {
        state.worker?.postMessage({ action: 'stopJob', jobId: job.job_id });
        if (job.completed > 0) {
            showToast(`${job.completed} track${job.completed === 1 ? '' : 's'} ready${job.failed ? `, ${job.failed} failed` : ''}`, 'success');
            if (state.job.autoZip && !state._zipFired) {
                state._zipFired = true;
                setTimeout(() => downloadJobZip(job.job_id, state.job.name), 900);
            }
        } else {
            showToast('Every track in that job failed', 'error');
        }
        try { localStorage.removeItem(LS.job); } catch (_) {}
        state.job = { ...state.job, status: 'complete' };
        loadFiles();
    }
    syncWakeLock();
}

async function restorePlaylistPage(playlistId) {
    try {
        const res = await fetch(`/playlists/jobs/by-playlist/${encodeURIComponent(playlistId)}`);
        if (!res.ok) throw new Error('gone');
        const job = await res.json();
        state.playlistKey = playlistId;
        state.job = {
            id: job.job_id,
            name: job.name || 'Playlist',
            total: job.total,
            startedAt: Date.now(),
            autoZip: false,
            status: job.status,
        };
        state._zipFired = true; // never auto-save a ZIP just from opening the link
        writeJSON(LS.job, { id: job.job_id, name: state.job.name, total: job.total, startedAt: state.job.startedAt, autoZip: false });
        applyJobSnapshot(job);
        if (job.status !== 'complete') {
            state.worker?.postMessage({ action: 'startJob', jobId: job.job_id });
            keepAwake();
        }
    } catch (_) {
        state.playlistKey = null;
        history.replaceState({}, '', '/');
        showToast('No active download for that link — jobs last 2 hours', 'error');
    }
}

async function resumeJob() {
    const saved = readJSON(LS.job, null);
    if (!saved?.id) return;
    try {
        const res = await fetch(`/playlists/jobs/${saved.id}`);
        if (!res.ok) throw new Error('gone');
        const job = await res.json();
        state.job = {
            id: job.job_id,
            name: saved.name || 'Playlist',
            total: job.total,
            startedAt: saved.startedAt || Date.now(),
            autoZip: !!saved.autoZip,
            status: job.status,
        };
        state._zipFired = true; // never auto-download a ZIP on reload
        applyJobSnapshot(job);
        if (job.status !== 'complete') {
            state.worker?.postMessage({ action: 'startJob', jobId: job.job_id });
            keepAwake();
        }
    } catch (_) {
        try { localStorage.removeItem(LS.job); } catch (_) {}
    }
}

function downloadJobZip(jobId, name) {
    const safe = (name || 'playlist').replace(/[^a-z0-9._ -]/gi, '').trim() || 'playlist';
    const a = document.createElement('a');
    a.href = `/playlists/jobs/${encodeURIComponent(jobId)}/zip`;
    a.download = `${safe}.zip`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Preparing ZIP…', 'info');
}

/* ── 9. keep-alive & polling ────────────────────────────────────────────── */

function startPollWorker() {
    try {
        state.worker = new Worker('/static/download-poll-worker.js');
        state.worker.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'job' && msg.job_id) applyJobSnapshot(msg);
            else if (msg.task_id || msg.taskId) onSingleProgress({ ...msg, task_id: msg.task_id || msg.taskId });
        };
    } catch (_) {
        state.worker = null;
    }
}

async function keepAwake() {
    if (!('wakeLock' in navigator) || state.wakeLock) return;
    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_) {
        state.wakeLock = null;
    }
}

function releaseAwake() {
    if (state.wakeLock) {
        try { state.wakeLock.release(); } catch (_) {}
        state.wakeLock = null;
    }
}

function activeWork() {
    return Object.keys(state.pollContexts).length > 0 || state.job?.status === 'running';
}

function syncWakeLock() {
    if (activeWork()) keepAwake();
    else releaseAwake();
}

document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (activeWork()) await keepAwake();
    state.worker?.postMessage({ action: 'pollNow' });

    // Immediate refresh instead of waiting for the next worker tick.
    if (state.job?.id && state.job.status === 'running') {
        try {
            const res = await fetch(`/playlists/jobs/${state.job.id}`);
            if (res.ok) applyJobSnapshot(await res.json());
        } catch (_) {}
    }
});

/* ── 10. modals, settings, utilities ────────────────────────────────────── */

function setupModals() {
    $('#modal-close').addEventListener('click', closeDetailView);
    $('#detail-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeDetailView();
    });
    $('#now-playing-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeNowPlaying();
    });

    $$('[data-settings]').forEach((btn) => btn.addEventListener('click', () => {
        $('#settings-modal').style.display = 'flex';
        $('#settings-theme').value = state.theme;
        $('#settings-downloader').value = state.defaultDownloader;
        fetchDownloaders();
    }));
    $('#settings-close').addEventListener('click', () => { $('#settings-modal').style.display = 'none'; });
    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });

    $('#playlist-picker-close').addEventListener('click', () => { $('#playlist-picker-modal').style.display = 'none'; });
    $('#playlist-picker-modal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
    });
    $('#btn-new-playlist-picker').addEventListener('click', () => {
        $('#playlist-picker-modal').style.display = 'none';
        createPlaylistWithItem(state.pendingItem);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if ($('#changelog-modal').style.display === 'flex') closeChangelog();
        else if ($('#settings-modal').style.display === 'flex') $('#settings-modal').style.display = 'none';
        else if ($('#playlist-picker-modal').style.display === 'flex') $('#playlist-picker-modal').style.display = 'none';
        else if (!$('#detail-modal').classList.contains('hidden')) closeDetailView();
        else if (!$('#now-playing-overlay').classList.contains('hidden')) closeNowPlaying();
    });
}

function setupSettings() {
    $('#settings-theme').addEventListener('change', (e) => applyTheme(e.target.value));
    $('#settings-downloader').addEventListener('change', (e) => {
        state.defaultDownloader = e.target.value;
        localStorage.setItem(LS.downloader, e.target.value);
        showToast(`Engine: ${e.target.value}`, 'info');
    });
    $('#btn-show-changelog').addEventListener('click', async () => {
        $('#settings-modal').style.display = 'none';
        openChangelog(state.devNotes || await fetchDevNotes());
    });
    $('#btn-export-data').addEventListener('click', () => {
        const payload = { playlists: state.playlists, files: state.files, theme: state.theme };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'glitchi-stream-data.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
        showToast('Data exported', 'success');
    });
    $('#btn-clear-storage').addEventListener('click', () => {
        if (!confirm('Clear playlists, themes and cached library data from this browser?')) return;
        localStorage.clear();
        state.playlists = [];
        state.files = [];
        state.detailItem = null;
        state.job = null;
        $('#settings-modal').style.display = 'none';
        location.reload();
    });
}

function openPlaylistPicker(item) {
    state.pendingItem = item;
    const list = $('#playlist-picker-list');
    if (!state.playlists.length) {
        list.innerHTML = '<p class="muted-text">No playlists yet</p>';
    } else {
        list.innerHTML = state.playlists.map((p) => `<button class="picker-item" data-playlist-id="${p.id}">
            <span>${escapeHtml(p.name)}</span>
            <span class="picker-count">${p.tracks.length}</span>
        </button>`).join('');
        $$('.picker-item', list).forEach((el) => el.addEventListener('click', () => {
            const playlist = state.playlists.find((p) => p.id === el.dataset.playlistId);
            if (playlist && item) {
                playlist.tracks.push({
                    name: item.name, artists: item.artists, cover: item.cover,
                    url: item.url, duration: item.duration || '', album: item.album || '', addedAt: Date.now(),
                });
                savePlaylists(); renderPlaylists();
                showToast(`Added to “${playlist.name}”`, 'success');
            }
            $('#playlist-picker-modal').style.display = 'none';
        }));
    }
    $('#playlist-picker-modal').style.display = 'flex';
}

function createPlaylistWithItem(item) {
    if (!item) return;
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    state.playlists.unshift({
        id: Date.now().toString(),
        name: name.trim(),
        tracks: [{ name: item.name, artists: item.artists, cover: item.cover, url: item.url, addedAt: Date.now() }],
        createdAt: Date.now(),
    });
    savePlaylists(); renderPlaylists();
    showToast(`Added to “${name.trim()}”`, 'success');
}

function fetchDownloaders() {
    fetch('/download/available')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            if (!data) return;
            const select = $('#settings-downloader');
            const available = data.available || [];
            if (available.length && !available.includes(state.defaultDownloader)) {
                state.defaultDownloader = available[0];
                localStorage.setItem(LS.downloader, available[0]);
            }
            select.value = state.defaultDownloader;
        })
        .catch(() => {});
}

function trackHistory(bucket, artist, title) {
    const list = state.history[bucket] || [];
    list.unshift({ artist, title, at: Date.now() });
    state.history[bucket] = list.slice(0, 50);
    writeJSON(LS.history, state.history);
}

function triggerFileDownload(filename) {
    const name = filename.split('/').pop() || 'track';
    const a = document.createElement('a');
    a.href = `/files/download/${encodeURIComponent(filename)}`;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function emptyState(kind, text) {
    const icons = {
        search: '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M20 20l-3.8-3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        files: '<path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.4"/><circle cx="17" cy="16" r="3" stroke="currentColor" stroke-width="1.4"/>',
        playlist: '<path d="M9 4h11M9 12h11M9 20h11M5 4v.01M5 12v.01M5 20v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    };
    return `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" class="empty-icon">${icons[kind] || icons.search}</svg><p>${escapeHtml(text)}</p></div>`;
}

function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('in'));
    setTimeout(() => {
        toast.classList.remove('in');
        setTimeout(() => toast.remove(), 240);
    }, 3400);
}

function formatDuration(ms) {
    if (!ms) return '';
    const total = Math.round(Number(ms) / 1000);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatTime(seconds) {
    if (!seconds || Number.isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
