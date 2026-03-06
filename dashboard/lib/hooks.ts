import useSWR from 'swr';
import { fetchApi } from './api';

function fetcher<T>(path: string): Promise<T> {
  return fetchApi<T>(path);
}

function unwrapFetcher<T>(key: string) {
  return async (path: string): Promise<T> => {
    const raw = await fetchApi<Record<string, unknown>>(path);
    return (raw[key] ?? raw) as T;
  };
}

function usePolling<T>(path: string, intervalMs: number, fetchFn: (p: string) => Promise<T> = fetcher) {
  const { data, error, isLoading, mutate } = useSWR<T>(path, fetchFn, {
    refreshInterval: intervalMs,
    revalidateOnFocus: false,
  });
  return { data, error, isLoading, mutate };
}

// ── Stats ──
export interface StatsData {
  totalProcessed: number;
  totalCompleted: number;
  totalFailed: number;
  totalActive: number;
  totalWaiting: number;
  totalDelayed: number;
  successRate: number;
  activeQueues: number;
  totalQueues: number;
}

export function useStats() {
  return usePolling<StatsData>('/dashboard/stats', 5_000);
}

// ── Queues ──
export interface QueueItem {
  name: string;
  active: number;
  completed: number;
  delayed: number;
  failed: number;
  paused: number;
  waiting: number;
}

export function useQueues() {
  return usePolling<QueueItem[]>('/dashboard/queues', 5_000, unwrapFetcher('queues'));
}

// ── Queue Detail ──
export interface QueueJob {
  id: string | number;
  name: string;
  data: unknown;
  timestamp: number;
  processedOn?: number | null;
  finishedOn?: number | null;
  attempts: number;
  failedReason?: string | null;
  returnvalue?: unknown;
}

export interface QueueDetailData {
  name: string;
  counts: Record<string, number>;
  recentJobs: {
    completed: QueueJob[];
    failed: QueueJob[];
    active: QueueJob[];
    waiting: QueueJob[];
    delayed: QueueJob[];
  };
}

export function useQueueDetail(name: string) {
  return usePolling<QueueDetailData>(`/dashboard/queues/${name}`, 5_000);
}

// ── System Health ──
export interface ServiceHealth {
  status: string;
  latency?: number;
  info?: string;
}

export function useSystemHealth() {
  return usePolling<Record<string, ServiceHealth>>('/dashboard/system/health', 10_000, unwrapFetcher('services'));
}

// ── Cron Runs ──
export interface CronRun {
  jobName: string;
  startedAt: string;
  completedAt?: string | null;
  itemsProcessed?: number;
  error?: string | null;
}

export function useCronRuns() {
  return usePolling<CronRun[]>('/dashboard/system/cron', 30_000, unwrapFetcher('runs'));
}

// ── Logs ──
export interface LogEntry {
  id: string | number;
  queueName: string;
  jobId: string | number;
  status: string;
  error?: string | null;
  createdAt: string;
}

export function useLogs(queue?: string) {
  const path = queue
    ? `/dashboard/system/logs?queue=${encodeURIComponent(queue)}`
    : '/dashboard/system/logs';
  return usePolling<LogEntry[]>(path, 10_000, unwrapFetcher('logs'));
}

// ── Webhooks ──
export interface WebhookEvent {
  id: string | number;
  source: string;
  event: string;
  processed: boolean;
  processedAt?: string | null;
  createdAt: string;
}

export function useWebhooks() {
  return usePolling<WebhookEvent[]>('/dashboard/webhooks/recent', 10_000, unwrapFetcher('events'));
}

// ── Competitors ──
export interface CompetitorItem {
  name: string;
  url: string;
}

export interface CompetitorResult {
  id: number;
  competitorName: string;
  url: string;
  crawledAt: string;
  data: Record<string, unknown>;
}

export function useCompetitors() {
  return usePolling<CompetitorItem[]>('/dashboard/competitors', 0, unwrapFetcher('competitors'));
}

export function useCompetitorResults() {
  return usePolling<CompetitorResult[]>('/dashboard/competitors/results', 0, unwrapFetcher('results'));
}

// ── Settings ──
export interface SettingInfo {
  key: string;
  configured: boolean;
  source: 'database' | 'env' | 'none';
  maskedValue: string;
}

export interface SettingsResponse {
  settings: SettingInfo[];
  configurableKeys: string[];
}

export function useSettings() {
  return usePolling<SettingsResponse>('/dashboard/settings', 0); // no auto-refresh
}
