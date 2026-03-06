"use client";

import { useState, useEffect } from "react";
import { useStats, useQueues, useWebhooks } from "@/lib/hooks";
import type { StatsData, QueueItem } from "@/lib/hooks";
import { StatCard } from "@/components/stat-card";
import { QueueCard } from "@/components/queue-card";
import { ActivityFeed } from "@/components/activity-feed";
import { formatNumber } from "@/lib/utils";

/* ── Skeleton primitives ─────────────────────────────────────────────── */

function Skeleton({ className }: { className?: string }) {
  return <div className={`skeleton ${className ?? ""}`} />;
}

function StatSkeleton() {
  return (
    <div
      className="px-6 py-8 min-h-[170px] flex flex-col justify-between"
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <Skeleton className="h-3 w-24 mb-3 rounded-full" />
      <div>
        <Skeleton className="h-12 w-32 mb-3 rounded" />
        <Skeleton className="h-3 w-20 rounded-full" />
      </div>
    </div>
  );
}

function QueueCardSkeleton() {
  return (
    <div
      className="p-5"
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-4 w-32 rounded-full" />
        <Skeleton className="h-2 w-2 rounded-full" />
      </div>
      <Skeleton className="h-1 w-full mb-4 rounded-full" />
      <Skeleton className="h-3 w-36 rounded-full" />
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="p-5 space-y-4 stagger">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <Skeleton className="h-3 w-14 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ── Empty states ────────────────────────────────────────────────────── */

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="py-16 text-center"
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <p className="text-sm" style={{ color: "var(--text-subtle)" }}>
        {message}
      </p>
    </div>
  );
}

/* ── Section heading ─────────────────────────────────────────────────── */

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 mb-5">
      <h2
        className="text-sm font-medium tracking-wide whitespace-nowrap"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </h2>
      <div
        className="flex-1 h-px"
        style={{
          background: "linear-gradient(to right, var(--border), transparent)",
        }}
      />
    </div>
  );
}

/* ── Live header with pulsing dot + ticking "last updated" ───────────── */

function LiveHeader({
  dataTimestamp,
}: {
  dataTimestamp: number | null;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo =
    dataTimestamp != null
      ? Math.max(0, Math.floor((now - dataTimestamp) / 1000))
      : null;

  return (
    <div
      className="pb-6 mb-8"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between">
        {/* Left: title + live dot */}
        <div className="flex items-center gap-3">
          <h1
            className="text-xl font-semibold tracking-tight"
            style={{ color: "var(--text-secondary)" }}
          >
            Dashboard
          </h1>
          <span
            className="inline-block w-2 h-2 rounded-full live-dot"
            style={{
              background: "var(--text-secondary)",
              boxShadow: "0 0 8px rgba(0, 0, 0, 0.1)",
            }}
            title="Live"
          />
        </div>

        {/* Right: last-updated ticker */}
        {secondsAgo != null && (
          <span
            className="text-xs"
            style={{ color: "var(--text-subtle)" }}
          >
            Updated {secondsAgo === 0 ? "just now" : `${secondsAgo}s ago`}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Dashboard page ──────────────────────────────────────────────────── */

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useStats();
  const { data: queues, isLoading: queuesLoading } = useQueues();
  const { data: webhooks, isLoading: webhooksLoading } = useWebhooks();

  const hasStats = !statsLoading && stats != null;
  const hasQueues = !queuesLoading && queues != null;
  const hasWebhooks = !webhooksLoading && webhooks != null;

  // Track the last time data was refreshed
  const [dataTimestamp, setDataTimestamp] = useState<number | null>(null);
  useEffect(() => {
    if (hasStats) setDataTimestamp(Date.now());
  }, [stats, hasStats]);

  return (
    <div className="animate-enter">
      {/* ── Header with live dot + last-updated ticker ─────────────── */}
      <LiveHeader dataTimestamp={dataTimestamp} />

      {/* ── Stat cards (4-up row) ──────────────────────────────────── */}
      <div className="mb-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 stagger">
          {statsLoading || !hasStats ? (
            <>
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
              <StatSkeleton />
            </>
          ) : (
            (() => {
              // Compute real trend percentages
              const weeklyPct = stats.completedPrev7d > 0
                ? Math.round(((stats.completedLast7d - stats.completedPrev7d) / stats.completedPrev7d) * 100)
                : stats.completedLast7d > 0 ? 100 : 0;
              const weeklyTrend: "up" | "down" | "flat" = weeklyPct > 0 ? "up" : weeklyPct < 0 ? "down" : "flat";
              const weeklyLabel = weeklyPct > 0
                ? `+${weeklyPct}% vs last week`
                : weeklyPct < 0
                ? `${weeklyPct}% vs last week`
                : "no change vs last week";

              const failedDelta = stats.failedLast24h - stats.failedPrev24h;
              const failedTrend: "up" | "down" | "flat" = stats.failedLast24h === 0 ? "flat" : failedDelta > 0 ? "down" : failedDelta < 0 ? "up" : "flat";
              const failedLabel = failedDelta > 0
                ? `+${failedDelta} vs prev 24h`
                : failedDelta < 0
                ? `${failedDelta} vs prev 24h`
                : "same as prev 24h";

              // Success rate delta: current period vs previous period
              const currTotal = stats.completedLast24h + stats.failedLast24h;
              const prevTotal = stats.completedPrev24h + stats.failedPrev24h;
              const currRate = currTotal > 0 ? (stats.completedLast24h / currTotal) * 100 : 100;
              const prevRate = prevTotal > 0 ? (stats.completedPrev24h / prevTotal) * 100 : 100;
              const rateDelta = Math.round((currRate - prevRate) * 10) / 10;
              const rateTrend: "up" | "down" | "flat" = rateDelta > 0 ? "up" : rateDelta < 0 ? "down" : "flat";
              const rateLabel = rateDelta > 0
                ? `+${rateDelta}% vs yesterday`
                : rateDelta < 0
                ? `${rateDelta}% vs yesterday`
                : "same as yesterday";

              return (
                <>
                  <StatCard
                    label="Orders Processed"
                    value={formatNumber(stats.totalProcessed)}
                    trend={weeklyTrend}
                    trendLabel={weeklyLabel}
                  />
                  <StatCard
                    label="Failed (24h)"
                    value={formatNumber(stats.failedLast24h)}
                    trend={failedTrend}
                    trendLabel={failedLabel}
                    subtitle={
                      stats.failedLast24h > 0 ? "requires attention" : undefined
                    }
                  />
                  <StatCard
                    label="Success Rate"
                    value={`${stats.successRate.toFixed(1)}%`}
                    trend={rateTrend}
                    trendLabel={rateLabel}
                  />
                  <StatCard
                    label="Notifications Sent"
                    value={formatNumber(stats.notificationsSent)}
                    trend="flat"
                    trendLabel="last 7 days"
                  />
                </>
              );
            })()
          )}
        </div>
      </div>

      {/* ── Queue Status section ───────────────────────────────────── */}
      <div className="mb-10">
        <SectionHeader label="Queue Status" />

        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: "20px",
          }}
        >
          {queuesLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger">
              {Array.from({ length: 6 }).map((_, i) => (
                <QueueCardSkeleton key={i} />
              ))}
            </div>
          ) : hasQueues && queues.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger">
              {queues.map((q: QueueItem) => (
                <QueueCard key={q.name} {...q} />
              ))}
            </div>
          ) : (
            <EmptyState message="No queues registered yet" />
          )}
        </div>
      </div>

      {/* ── Recent Activity section ────────────────────────────────── */}
      <div className="mb-10">
        <SectionHeader label="Recent Activity" />

        <div
          className="relative overflow-hidden"
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-surface)",
            borderRadius: "var(--radius-md)",
            minHeight: 400,
          }}
        >
          {webhooksLoading ? (
            <ActivitySkeleton />
          ) : hasWebhooks && webhooks.length > 0 ? (
            <>
              <ActivityFeed items={webhooks} />
              {/* Fade-out gradient at the bottom of the activity feed */}
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0"
                style={{
                  height: 80,
                  background:
                    "linear-gradient(to bottom, transparent, var(--bg-surface))",
                }}
              />
            </>
          ) : (
            <div className="py-16 text-center">
              <p className="text-sm" style={{ color: "var(--text-subtle)" }}>
                No activity yet
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
