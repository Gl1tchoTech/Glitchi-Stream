// ===== State =====
const state = {
    activeTab: 'search',
    theme: localStorage.getItem('glitchi-theme') || 'dark',
    searchTimeout: null,
    currentAudio: null,
    currentFilename: null,
};

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(state.theme);
    setupNavigation();
    setupSearch();
    setupFiles();
    setupDownload();
    setupThemeSwitcher();
    setupFilterChips();
    setupPlayerControls();
    setupFileCardDelegation();
    setupResultCardDelegation();
    openTab(state.activeTab);
    loadFiles(); // Preload files for sidebar badge or instant view
});

// ===== Theme =====
function applyTheme(name) {
    document.documentElement.setAttribute('data-theme', name);
    state.theme = name;
    localStorage.setItem('glitchi-theme', name);
    document.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === name);
    });
}

function setupThemeSwitcher() {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
}

// ===== Navigation =====
function setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => openTab(item.dataset.tab));
    });
}

function openTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.nav-item').forEach(i =>
        i.classList.toggle('active', i.dataset.tab === name)
    );
    document.querySelectorAll('.tab-content').forEach(t =>
        t.classList.toggle('active', t.id === `tab-${name}`)
    );
    if (name === 'search') document.getElementById('search-input')?.focus();
    if (name === 'files') loadFiles();
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
    }, 3000);
}

// ===== Filter Chips (:has() polyfill) =====
function setupFilterChips() {
    document.querySelectorAll('.filter-chip input').forEach(input => {
        input.addEventListener('change', () => {
            input.closest('.filter-chip').classList.toggle('checked', input.checked);
        });
        // Set initial state
        input.closest('.filter-chip').classList.toggle('checked', input.checked);
    });
}

// ===== Search =====
function setupSearch() {
    const input = document.getElementById('search-input');
    const filters = document.querySelectorAll('.filter-chip input');
    let debounceTimer;

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, 400);
    });

    filters.forEach(f => f.addEventListener('change', () => {
        if (input.value.trim().length > 0) doSearch();
    }));

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            doSearch();
        }
    });
}

function getActiveTypes() {
    const checked = document.querySelectorAll('.filter-chip input:checked');
    if (checked.length === 0) return 'track,album,artist';
    return Array.from(checked).map(c => c.value).join(',');
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
        resultsEl.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <p>Search for music to get started</p>
            </div>`;
        return;
    }

    resultsEl.innerHTML = '<div class="spinner"></div>';

    const types = getActiveTypes();
    const url = `/search/?q=${encodeURIComponent(query)}&type=${encodeURIComponent(types)}&limit=20`;

    try {
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: 'Search failed' }));
            throw new Error(err.detail || 'Search failed');
        }
        const data = await res.json();
        renderSearchResults(data, query);
    } catch (e) {
        resultsEl.innerHTML = `<div class="empty-state"><p style="color:#ef4444">${escapeHtml(e.message)}</p></div>`;
    }
}

// ===== Event delegation for result cards =====
function setupResultCardDelegation() {
    document.getElementById('search-results').addEventListener('click', (e) => {
        const card = e.target.closest('.card, .artist-item');
        if (!card) return;

        // If play button was clicked
        if (e.target.closest('.card-play')) {
            const track = card.dataset.track;
            const artist = card.dataset.artist;
            const cover = card.dataset.cover;
            const url = card.dataset.url;
            if (track) {
                updatePlayerUI(track, artist, cover);
                if (url) showToast(`Selected: ${track}`, 'info');
                // For tracks, we can't play directly via Spotify URL without embed
                // Just update the player bar visually
            }
            return;
        }

        // Card click → open Spotify
        const url = card.dataset.url;
        if (url) window.open(url, '_blank');
    });
}

function renderSearchResults(data, query) {
    const resultsEl = document.getElementById('search-results');
    let html = '';

    if (data.tracks && data.tracks.length > 0) {
        html += `<div class="result-section"><h2>Tracks <span class="count">${data.tracks.length} results</span></h2><div class="results-grid">`;
        data.tracks.forEach(t => {
            const imgHtml = t.album_image_url
                ? `<img src="${escapeHtml(t.album_image_url)}" alt="" class="card-cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-cover-placeholder" style="display:none"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>`
                : '<div class="card-cover-placeholder"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 6v12l10-6z" fill="currentColor"/></svg></div>';
            html += `
                <div class="card" data-url="${escapeHtml(t.url)}" data-track="${escapeHtml(t.name)}" data-artist="${escapeHtml(t.artists)}" data-cover="${escapeHtml(t.album_image_url)}" title="${escapeHtml(t.name)}">
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
            html += `
                <div class="card" data-url="${escapeHtml(a.url)}" title="${escapeHtml(a.name)}">
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
            html += `
                <div class="artist-item" data-url="${escapeHtml(ar.url)}" style="cursor:pointer">
                    ${avatarHtml}
                    <div>
                        <div class="artist-name">${escapeHtml(ar.name)}</div>
                        ${ar.genres ? `<div class="artist-meta">${escapeHtml(ar.genres)}</div>` : ''}
                    </div>
                </div>`;
        });
        html += '</div></div>';
    }

    if (!data.tracks?.length && !data.albums?.length && !data.artists?.length) {
        html = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <p>No results found for "${escapeHtml(query)}"</p>
        </div>`;
    }

    resultsEl.innerHTML = html;
}

// ===== Files =====
async function loadFiles() {
    const container = document.getElementById('files-list');
    container.innerHTML = '<div class="spinner"></div>';

    try {
        const res = await fetch('/files/');
        if (!res.ok) throw new Error('Failed to load files');
        const data = await res.json();
        renderFiles(data.files);
    } catch (e) {
        container.innerHTML = `<div class="empty-state"><p style="color:#ef4444">${escapeHtml(e.message)}</p></div>`;
    }
}

function setupFiles() {
    document.getElementById('refresh-files').addEventListener('click', loadFiles);
}

function setupFileCardDelegation() {
    document.getElementById('files-list').addEventListener('click', (e) => {
        const streamBtn = e.target.closest('.file-btn-stream');
        const downloadBtn = e.target.closest('.file-btn-download');

        if (streamBtn) {
            const filename = streamBtn.dataset.filename;
            playFile(filename);
        }
        if (downloadBtn) {
            const filename = downloadBtn.dataset.filename;
            downloadFile(filename);
        }
    });
}

function playFile(filename) {
    // Stop any current playback
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio.remove();
        state.currentAudio = null;
    }

    const audio = new Audio(`/files/stream?filename=${encodeURIComponent(filename)}`);
    audio.addEventListener('loadedmetadata', () => {
        updatePlayerUI(
            filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
            'Local File',
            null
        );
        state.currentFilename = filename;
        document.querySelector('.ctrl-play').innerHTML =
            '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h4v12H6V6zm8 0h4v12h-4V6z"/></svg>';
        document.querySelector('.ctrl-play').disabled = false;
        document.querySelectorAll('.ctrl-btn').forEach(b => b.disabled = false);
    });
    audio.addEventListener('timeupdate', () => {
        const pct = (audio.currentTime / audio.duration) * 100 || 0;
        document.querySelector('.progress-fill').style.width = `${pct}%`;
        document.querySelectorAll('.time')[0].textContent = formatTime(audio.currentTime);
        document.querySelectorAll('.time')[1].textContent = formatTime(audio.duration || 0);
    });
    audio.addEventListener('ended', () => resetPlayer());
    audio.addEventListener('error', () => {
        showToast('Failed to play file', 'error');
        resetPlayer();
    });

    audio.play().catch(() => showToast('Playback blocked by browser', 'error'));
    state.currentAudio = audio;
    showToast(`Playing: ${filename}`, 'info');
}

function downloadFile(filename) {
    window.open(`/files/download/${encodeURIComponent(filename)}`, '_blank');
    showToast('Download started', 'success');
}

function resetPlayer() {
    if (state.currentAudio) {
        state.currentAudio.pause();
        state.currentAudio = null;
    }
    state.currentFilename = null;
    document.querySelector('.player-cover').innerHTML = '';
    document.querySelector('.player-track').textContent = 'No track selected';
    document.querySelector('.player-artist').textContent = '\u00A0';
    document.querySelector('.progress-fill').style.width = '0%';
    document.querySelectorAll('.time')[0].textContent = '0:00';
    document.querySelectorAll('.time')[1].textContent = '0:00';
    document.querySelector('.ctrl-play').innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    document.querySelectorAll('.ctrl-btn').forEach(b => b.disabled = true);
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function setupPlayerControls() {
    document.querySelector('.ctrl-play').addEventListener('click', () => {
        if (!state.currentAudio) return;
        if (state.currentAudio.paused) {
            state.currentAudio.play();
            document.querySelector('.ctrl-play').innerHTML =
                '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h4v12H6V6zm8 0h4v12h-4V6z"/></svg>';
        } else {
            state.currentAudio.pause();
            document.querySelector('.ctrl-play').innerHTML =
                '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        }
    });

    document.querySelector('.progress-track').addEventListener('click', (e) => {
        if (!state.currentAudio) return;
        const rect = e.target.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        state.currentAudio.currentTime = pct * state.currentAudio.duration;
    });
}

function updatePlayerUI(track, artist, coverUrl) {
    const cover = document.querySelector('.player-cover');
    if (coverUrl) {
        cover.innerHTML = `<img src="${escapeHtml(coverUrl)}" alt="" onerror="this.remove()">`;
    } else {
        cover.innerHTML = '';
    }
    document.querySelector('.player-track').textContent = track;
    document.querySelector('.player-artist').textContent = artist;
}

function renderFiles(files) {
    const container = document.getElementById('files-list');
    if (!files || files.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" class="empty-icon"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 9h6M9 13h6M9 17h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <p>No downloaded files yet. Search for a track and download it!</p>
        </div>`;
        return;
    }

    let html = '';
    files.forEach(f => {
        const extIcon = getExtensionIcon(f.extension);
        html += `
            <div class="file-card">
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
                </div>
            </div>`;
    });
    container.innerHTML = html;
}

function getExtensionIcon(ext) {
    const e = ext.toLowerCase();
    if (e === '.flac' || e === '.mp3' || e === '.m4a' || e === '.wav' || e === '.ogg') {
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
    if (!url) {
        showToast('Please enter a Spotify URL', 'error');
        return;
    }
    if (!url.includes('spotify.com')) {
        showToast('Please enter a valid Spotify URL', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0"></div> Downloading...';
    status.className = 'status-msg hidden';

    try {
        const res = await fetch('/download/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url,
                quality: qualityEl.value,
            }),
        });

        const data = await res.json();
        if (res.ok) {
            status.className = 'status-msg success';
            status.textContent = data.message || 'Download queued! Check Your Files.';
            urlInput.value = '';
            showToast('Download started!', 'success');
        } else {
            status.className = 'status-msg error';
            status.textContent = data.detail || 'Download failed';
            showToast(data.detail || 'Download failed', 'error');
        }
    } catch (e) {
        status.className = 'status-msg error';
        status.textContent = 'Network error';
    }

    status.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l4 4 4-4M12 8v8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Download`;
}

// ===== Utilities =====
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
