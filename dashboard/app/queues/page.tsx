"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueues, useStats } from "@/lib/hooks";
import type { QueueItem } from "@/lib/hooks";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { formatNumber } from "@/lib/utils";
import { postApi } from "@/lib/api";

/* ── Skeleton loader ────────────────────────────────────────────── */
function Skeleton({ className }: { className?: string }) {
  return <div className={`skeleton ${className || ""}`} />;
}

/* ── Derive queue health status ─────────────────────────────────── */
function deriveStatus(q: QueueItem): "ok" | "error" | "warn" | "unknown" {
  if (q.failed > 0) return "error";
  if (q.active > 0) return "ok";
  const total = q.waiting + q.active + q.completed + q.failed + q.delayed;
  if (total === 0) return "unknown";
  return "ok";
}

/* ── StatusBadge ────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: "ok" | "error" | "warn" | "unknown" }) {
  const labels: Record<string, string> = {
    ok: "Healthy",
    error: "Failing",
    warn: "Degraded",
    unknown: "Idle",
  };
  return (
    <span className="badge text-[10px] font-mono uppercase tracking-wider">
      <StatusDot status={status} />
      {labels[status]}
    </span>
  );
}

/* ── Segmented progress bar ─────────────────────────────────────── */
function ProgressBar({
  segments,
  total,
}: {
  segments: { label: string; value: number; shade: string }[];
  total: number;
}) {
  if (total === 0) {
    return (
      <div
        className="h-1.5 w-full"
        style={{ background: "var(--bg-elevated)", borderRadius: 999 }}
      />
    );
  }
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden"
      style={{ background: "var(--bg-elevated)", borderRadius: 999 }}
    >
      {segments.map((seg) =>
        seg.value > 0 ? (
          <div
            key={seg.label}
            className="h-full transition-all duration-500"
            style={{
              width: `${(seg.value / total) * 100}%`,
              background: seg.shade,
              borderRadius: 999,
            }}
            title={`${seg.label}: ${seg.value}`}
          />
        ) : null
      )}
    </div>
  );
}

/* ── Legend item ─────────────────────────────────────────────────── */
function LegendItem({ shade, label }: { shade: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs" style={{ color: "var(--text-subtle)" }}>
      <span
        className="inline-block w-3 h-1.5"
        style={{ background: shade, borderRadius: 999 }}
      />
      {label}
    </span>
  );
}

/* ── Page ────────────────────────────────────────────────────────── */
export default function QueuesPage() {
  const { data: queues, isLoading, mutate } = useQueues();
  const { data: stats, mutate: mutateStats } = useStats();
  const [clearing, setClearing] = useState(false);
  const [clearMsg, setClearMsg] = useState("");

  const totalJobs =
    queues?.reduce(
      (sum, q) => sum + q.waiting + q.active + q.completed + q.failed + q.delayed,
      0
    ) ?? 0;
  const totalFailed = queues?.reduce((sum, q) => sum + q.failed, 0) ?? 0;
  const totalActive = queues?.reduce((sum, q) => sum + q.active, 0) ?? 0;
  const totalWaiting = queues?.reduce((sum, q) => sum + q.waiting, 0) ?? 0;

  async function handleClearAll() {
    if (!confirm("Clear ALL queue data, job logs, webhook events, and cron history? Settings will be preserved.")) return;
    setClearing(true);
    setClearMsg("");
    try {
      await postApi("/dashboard/data/reset");
      setClearMsg("All data cleared successfully");
      mutate();
      mutateStats();
    } catch (err) {
      setClearMsg("Failed to clear data");
    } finally {
      setClearing(false);
      setTimeout(() => setClearMsg(""), 3000);
    }
  }

  return (
    <div className="animate-enter">
      {/* ── Page header with Clear All button ──────────────────── */}
      <div className="flex items-center justify-between mb-2">
        <PageHeader title="Queues" />
        <div className="flex items-center gap-3">
          {clearMsg && (
            <span className="text-xs" style={{ color: clearMsg.includes("success") ? "var(--success, #22C55E)" : "var(--error)" }}>
              {clearMsg}
            </span>
          )}
          <button
            onClick={handleClearAll}
            disabled={clearing}
            className="px-4 py-2 text-xs font-medium uppercase tracking-wider"
            style={{
              background: clearing ? "var(--bg-elevated)" : "#C0392B",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-md, 6px)",
              cursor: clearing ? "not-allowed" : "pointer",
              opacity: clearing ? 0.6 : 1,
            }}
          >
            {clearing ? "Clearing..." : "Clear All Data"}
          </button>
        </div>
      </div>

      {/* ── Summary strip ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
        {[
          { label: "Total Jobs", value: formatNumber(totalJobs) },
          { label: "Active", value: formatNumber(totalActive) },
          { label: "Waiting", value: formatNumber(totalWaiting) },
          { label: "Failed", value: formatNumber(totalFailed), highlight: totalFailed > 0 },
        ].map((item) => (
          <div
            key={item.label}
            className="px-6 py-5"
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <p
              className="text-[11px] uppercase tracking-widest mb-1.5"
              style={{ color: "var(--text-subtle)", fontFamily: "inherit" }}
            >
              {item.label}
            </p>
            <p
              className="text-2xl font-semibold tabular-nums"
              style={{ color: item.highlight ? "var(--error)" : "var(--text-secondary)" }}
            >
              {item.value}
            </p>
          </div>
        ))}
      </div>

      {/* ── Queue cards grid ───────────────────────────────────── */}
      {isLoading || !queues ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="p-7"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <Skeleton className="h-4 w-36 mb-5" />
              <Skeleton className="h-1.5 w-full mb-5" />
              <div className="flex gap-8">
                <Skeleton className="h-14 w-20" />
                <Skeleton className="h-14 w-20" />
                <Skeleton className="h-14 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger">
          {queues.map((q) => {
            const total = q.waiting + q.active + q.completed + q.failed + q.delayed;
            const status = deriveStatus(q);
            const segments = [
              { label: "Active", value: q.active, shade: "#1A1A1A" },
              { label: "Failed", value: q.failed, shade: "#C0392B" },
              { label: "Waiting", value: q.waiting, shade: "#999999" },
              { label: "Delayed", value: q.delayed, shade: "#B0B0B0" },
              { label: "Completed", value: q.completed, shade: "#22C55E" },
            ];

            return (
              <Link
                key={q.name}
                href={`/queues/${encodeURIComponent(q.name)}`}
                className="card block p-7 group"
              >
                {/* Header row */}
                <div className="flex items-center justify-between mb-5">
                  <span
                    className="text-sm font-medium tracking-wide group-hover:underline underline-offset-4"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {q.name}
                  </span>
                  <StatusBadge status={status} />
                </div>

                {/* Progress bar */}
                <ProgressBar segments={segments} total={total} />

                {/* Stats grid - full word labels, sans-serif */}
                <div className="grid grid-cols-5 gap-3 mt-5">
                  {[
                    { label: "Waiting", value: q.waiting },
                    { label: "Active", value: q.active },
                    { label: "Completed", value: q.completed },
                    { label: "Failed", value: q.failed, danger: q.failed > 0 },
                    { label: "Delayed", value: q.delayed },
                  ].map((col) => (
                    <div key={col.label}>
                      <p
                        className="text-[10px] uppercase tracking-widest mb-1"
                        style={{ color: "var(--text-subtle)", fontFamily: "inherit" }}
                      >
                        {col.label}
                      </p>
                      <p
                        className="text-lg font-semibold tabular-nums"
                        style={{ color: col.danger ? "var(--error)" : "var(--text-secondary)" }}
                      >
                        {col.value}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Total footer */}
                <div
                  className="mt-4 pt-4 flex items-center justify-between"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <span
                    className="text-[10px] uppercase tracking-widest"
                    style={{ color: "var(--text-subtle)", fontFamily: "inherit" }}
                  >
                    Total
                  </span>
                  <span
                    className="text-sm font-semibold tabular-nums"
                    style={{ color: "var(--text-subtle)" }}
                  >
                    {formatNumber(total)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* ── Legend ──────────────────────────────────────────────── */}
      <div className="mt-8 flex flex-wrap items-center gap-6">
        <LegendItem shade="#1A1A1A" label="Active" />
        <LegendItem shade="#C0392B" label="Failed" />
        <LegendItem shade="#999999" label="Waiting" />
        <LegendItem shade="#B0B0B0" label="Delayed" />
        <LegendItem shade="#22C55E" label="Completed" />
      </div>
    </div>
  );
}
