// ===== Download progress polling worker =====
// Runs off the main thread so progress keeps flowing while the page is busy,
// and so the UI can refresh instantly when the tab becomes visible again.
// All download work happens on the server — this only mirrors progress.

const TASK_INTERVAL_MS = 1000;
const JOB_INTERVAL_MS = 1500;

const _tasks = {}; // taskId -> intervalId
const _jobs = {};  // jobId  -> intervalId

self.onerror = function (e) {
    self.postMessage({ type: 'error', error: `Worker crash: ${(e && e.message) || e}` });
};

self.onmessage = function (e) {
    const { action, taskId, jobId } = e.data || {};

    if (action === 'start' && taskId) {
        if (_tasks[taskId]) clearInterval(_tasks[taskId]);
        _tasks[taskId] = setInterval(() => _pollTask(taskId), TASK_INTERVAL_MS);
        _pollTask(taskId);
    } else if (action === 'stop' && taskId) {
        _stopTask(taskId);
    } else if (action === 'startJob' && jobId) {
        if (_jobs[jobId]) clearInterval(_jobs[jobId]);
        _jobs[jobId] = setInterval(() => _pollJob(jobId), JOB_INTERVAL_MS);
        _pollJob(jobId);
    } else if (action === 'stopJob' && jobId) {
        _stopJob(jobId);
    } else if (action === 'pollNow') {
        Object.keys(_tasks).forEach(_pollTask);
        Object.keys(_jobs).forEach(_pollJob);
    } else if (action === 'stopAll') {
        Object.keys(_tasks).forEach(_stopTask);
        Object.keys(_jobs).forEach(_stopJob);
    }
};

async function _pollTask(taskId) {
    try {
        const res = await fetch(`/download/progress/${taskId}`, { cache: 'no-store' });
        if (!res.ok) {
            if (res.status === 404) _stopTask(taskId);
            return;
        }
        const task = await res.json();
        self.postMessage({ task_id: taskId, ...task });
        if (task.status === 'complete' || task.status === 'failed') _stopTask(taskId);
    } catch (_) {
        // Offline or server restart — keep the interval, it will retry.
    }
}

async function _pollJob(jobId) {
    try {
        const res = await fetch(`/playlists/jobs/${jobId}`, { cache: 'no-store' });
        if (!res.ok) {
            if (res.status === 404) _stopJob(jobId);
            return;
        }
        const job = await res.json();
        self.postMessage({ type: 'job', ...job });
        if (job.status === 'complete') _stopJob(jobId);
    } catch (_) {
        // Keep retrying on the next tick.
    }
}

function _stopTask(taskId) {
    if (_tasks[taskId]) {
        clearInterval(_tasks[taskId]);
        delete _tasks[taskId];
    }
}

function _stopJob(jobId) {
    if (_jobs[jobId]) {
        clearInterval(_jobs[jobId]);
        delete _jobs[jobId];
    }
}
