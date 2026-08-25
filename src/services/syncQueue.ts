/**
 * Offline Sync Queue & Mutation Manager
 * Handles offline changes, queuing failed cloud requests, and auto-flushing upon network recovery.
 */

import { callGasApi } from './gasApi';

export interface PendingSyncItem {
  id: string;
  action: string;
  payload: any;
  timestamp: number;
  description: string;
  retryCount: number;
  lastError?: string;
}

const SYNC_QUEUE_KEY = 'banban_pending_sync_queue';
const listeners = new Set<(queue: PendingSyncItem[]) => void>();

export function getPendingQueue(): PendingSyncItem[] {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error('Failed to read sync queue from localStorage', e);
  }
  return [];
}

function savePendingQueue(queue: PendingSyncItem[]) {
  try {
    localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
    notifyListeners(queue);
  } catch (e) {
    console.error('Failed to save sync queue to localStorage', e);
  }
}

function notifyListeners(queue: PendingSyncItem[]) {
  listeners.forEach(fn => {
    try {
      fn(queue);
    } catch (e) {
      console.error('Listener callback error', e);
    }
  });
}

export function subscribeSyncStatus(callback: (queue: PendingSyncItem[]) => void): () => void {
  listeners.add(callback);
  callback(getPendingQueue());
  return () => {
    listeners.delete(callback);
  };
}

export function enqueueSyncItem(action: string, payload: any, description: string): PendingSyncItem {
  const queue = getPendingQueue();
  const newItem: PendingSyncItem = {
    id: 'sync_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    action,
    payload,
    timestamp: Date.now(),
    description,
    retryCount: 0
  };
  queue.push(newItem);
  savePendingQueue(queue);
  return newItem;
}

export function removeSyncItem(id: string): void {
  const queue = getPendingQueue().filter(item => item.id !== id);
  savePendingQueue(queue);
}

export function clearSyncQueue(): void {
  savePendingQueue([]);
}

let isProcessingQueue = false;

/**
 * Replays all pending mutation requests in the queue sequentially.
 */
export async function processSyncQueue(
  onProgress?: (currentItem: PendingSyncItem, remaining: number) => void
): Promise<{ processed: number; failed: number; errors: string[] }> {
  if (isProcessingQueue) {
    return { processed: 0, failed: 0, errors: ['已經有同步佇列正在執行中'] };
  }

  isProcessingQueue = true;
  let queue = getPendingQueue();
  if (queue.length === 0) {
    isProcessingQueue = false;
    return { processed: 0, failed: 0, errors: [] };
  }

  let processedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];
  const remainingQueue: PendingSyncItem[] = [];

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (onProgress) {
      onProgress(item, queue.length - i);
    }

    try {
      const res = await callGasApi(item.action, item.payload);
      if (res && res.success) {
        processedCount++;
      } else if (res && res.isLocalFallback) {
        // If still offline / local fallback mode without network/API config
        remainingQueue.push({
          ...item,
          retryCount: item.retryCount + 1,
          lastError: '尚未連線至 Google Apps Script Web App 或離線中'
        });
        failedCount++;
      } else {
        // Server returned specific error
        const errMsg = res?.message || res?.error || '伺服器拒絕或處理失敗';
        errors.push(`${item.description}：${errMsg}`);
        // If retry count < 3, keep it; else allow discarding
        if (item.retryCount < 3) {
          remainingQueue.push({
            ...item,
            retryCount: item.retryCount + 1,
            lastError: errMsg
          });
        }
        failedCount++;
      }
    } catch (err: any) {
      errors.push(`${item.description}：${err.message || '網路連線異常'}`);
      remainingQueue.push({
        ...item,
        retryCount: item.retryCount + 1,
        lastError: err.message || '網路連線異常'
      });
      failedCount++;
    }
  }

  savePendingQueue(remainingQueue);
  isProcessingQueue = false;
  return { processed: processedCount, failed: failedCount, errors };
}
