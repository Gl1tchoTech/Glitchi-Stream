// ===== Download Progress Polling Worker =====
// Runs in a separate thread — not throttled when the browser tab is hidden.
// Polls /download/progress/{taskId} every 1s and posts results to main thread.

const POLL_INTERVAL_MS = 1000;
const _activeTasks = {}; // { taskId: intervalId }

// Notify main thread if the worker crashes so it can recover.
self.onerror = function (e) {
    self.postMessage({ taskId: null, status: 'error', error: `Worker crash: ${e.message || e}` });
};

self.onmessage = function (e) {
    const { action, taskId, taskIds } = e.data;

    if (action === 'start') {
        // Start polling one or more task IDs
        const ids = taskIds || (taskId ? [taskId] : []);
        for (const id of ids) {
            if (_activeTasks[id]) clearInterval(_activeTasks[id]);
            _activeTasks[id] = setInterval(() => _poll(id), POLL_INTERVAL_MS);
            _poll(id); // immediate first poll
        }
    } else if (action === 'stop') {
        // Stop polling specific task(s) or all
        const ids = taskIds || (taskId ? [taskId] : Object.keys(_activeTasks));
        for (const id of ids) {
            if (_activeTasks[id]) {
                clearInterval(_activeTasks[id]);
                delete _activeTasks[id];
            }
        }
    }
};

async function _poll(taskId) {
    try {
        const res = await fetch(`/download/progress/${taskId}`);
        if (!res.ok) {
            // Stop polling if the endpoint is gone (404) or server error
            if (res.status === 404) _autoStop(taskId);
            return;
        }
        const task = await res.json();
        self.postMessage({ taskId, ...task });

        // Auto-stop when terminal state reached
        if (task.status === 'complete' || task.status === 'failed') {
            _autoStop(taskId);
        }
    } catch (_err) {
        // Network hiccup — keep polling
    }
}

function _autoStop(taskId) {
    if (_activeTasks[taskId]) {
        clearInterval(_activeTasks[taskId]);
        delete _activeTasks[taskId];
    }
}
