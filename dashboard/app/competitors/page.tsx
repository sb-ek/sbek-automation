"use client";

import { useState, useEffect, useCallback } from "react";
import { useCompetitors, useCompetitorResults } from "@/lib/hooks";
import { PageHeader } from "@/components/page-header";
import { postApi, fetchApi } from "@/lib/api";

// ── Crawling animation keyframes (injected once) ────────────────────
const ANIMATION_STYLES = `
@keyframes crawl-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes crawl-spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes crawl-progress {
  0% { width: 0%; }
  50% { width: 70%; }
  90% { width: 90%; }
  100% { width: 95%; }
}
@keyframes crawl-scan {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
@keyframes crawl-dot {
  0%, 20% { opacity: 0; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}
`;

export default function CompetitorsPage() {
  const { data: competitors, isLoading, mutate } = useCompetitors();
  const { data: results, mutate: mutateResults } = useCompetitorResults();

  const [crawlingAll, setCrawlingAll] = useState(false);
  const [crawlingNames, setCrawlingNames] = useState<Set<string>>(new Set());
  const [crawlMsg, setCrawlMsg] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Poll for results while any crawl is in progress
  useEffect(() => {
    if (crawlingNames.size === 0) return;
    const interval = setInterval(() => {
      mutateResults();
    }, 8000);
    return () => clearInterval(interval);
  }, [crawlingNames.size, mutateResults]);

  const stopCrawling = useCallback((name: string) => {
    setCrawlingNames((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  async function handleCrawlAll() {
    if (crawlingAll || crawlingNames.size > 0) return;
    setCrawlingAll(true);
    setCrawlMsg("");
    try {
      const res = await postApi<{ enqueued: number; competitors: string[] }>(
        "/dashboard/competitors/crawl"
      );
      // Mark all as crawling
      setCrawlingNames(new Set(res.competitors));
      setCrawlMsg(`Crawling ${res.enqueued} competitors — this may take 1-2 minutes per site`);
      // Auto-stop after 3 minutes per competitor
      const timeout = Math.max(res.enqueued * 180_000, 180_000);
      setTimeout(() => {
        setCrawlingNames(new Set());
        setCrawlMsg("");
        setCrawlingAll(false);
        mutateResults();
      }, timeout);
    } catch {
      setCrawlMsg("Failed to start crawl");
      setTimeout(() => setCrawlMsg(""), 3000);
      setCrawlingAll(false);
    }
  }

  async function handleCrawlOne(name: string) {
    // Prevent duplicate crawls
    if (crawlingNames.has(name)) return;
    setCrawlingNames((prev) => new Set(prev).add(name));
    setCrawlMsg(`Crawling ${name} — scanning pages...`);
    try {
      await postApi("/dashboard/competitors/crawl", { name });
      // Auto-stop after 3 minutes
      setTimeout(() => {
        stopCrawling(name);
        mutateResults();
        setCrawlMsg("");
      }, 180_000);
    } catch {
      stopCrawling(name);
      setCrawlMsg(`Failed to crawl ${name}`);
      setTimeout(() => setCrawlMsg(""), 3000);
    }
  }

  async function handleAdd() {
    if (!addName.trim() || !addUrl.trim()) return;
    setAdding(true);
    try {
      await postApi("/dashboard/competitors", {
        name: addName.trim(),
        url: addUrl.trim(),
      });
      setAddName("");
      setAddUrl("");
      mutate();
    } catch {
      setCrawlMsg("Failed to add competitor");
      setTimeout(() => setCrawlMsg(""), 3000);
    } finally {
      setAdding(false);
    }
  }

  async function handleDownload(name?: string) {
    const url = name
      ? `/api/dashboard/competitors/results/download?name=${encodeURIComponent(name)}`
      : `/api/dashboard/competitors/results/download`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        setCrawlMsg(err.error || "Download failed");
        setTimeout(() => setCrawlMsg(""), 4000);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name
        ? `SBEK-Competitor-Report-${name.replace(/\s+/g, "-")}.pdf`
        : "SBEK-Competitor-Analysis-Report.pdf";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setCrawlMsg("Download failed — check if competitor has been crawled");
      setTimeout(() => setCrawlMsg(""), 4000);
    }
  }

  const isCrawling = (name: string) => crawlingNames.has(name);
  const anyCrawling = crawlingNames.size > 0;

  return (
    <div className="animate-enter">
      {/* Inject animation styles */}
      <style dangerouslySetInnerHTML={{ __html: ANIMATION_STYLES }} />

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <PageHeader title="Competitors" />
        <div className="flex items-center gap-3">
          {crawlMsg && (
            <CrawlStatusBanner message={crawlMsg} isError={crawlMsg.includes("Failed")} />
          )}
          <button
            onClick={() => handleDownload()}
            className="px-4 py-2 text-xs font-medium uppercase tracking-wider"
            style={{
              background: "var(--bg-elevated)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md, 6px)",
              cursor: "pointer",
            }}
          >
            Download All
          </button>
          <button
            onClick={handleCrawlAll}
            disabled={crawlingAll || !competitors?.length}
            className="px-4 py-2 text-xs font-medium uppercase tracking-wider"
            style={{
              background: crawlingAll ? "var(--bg-elevated)" : "#1A1A1A",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-md, 6px)",
              cursor: crawlingAll ? "not-allowed" : "pointer",
              opacity: crawlingAll ? 0.6 : 1,
            }}
          >
            {crawlingAll ? (
              <span className="flex items-center gap-2">
                <CrawlSpinner size={12} />
                Crawling All...
              </span>
            ) : (
              "Crawl All"
            )}
          </button>
        </div>
      </div>

      {/* Global crawl progress bar */}
      {anyCrawling && (
        <div
          className="mb-4 overflow-hidden"
          style={{
            background: "var(--bg-elevated)",
            borderRadius: "var(--radius-md)",
            height: 44,
            border: "1px solid var(--border)",
            position: "relative",
          }}
        >
          {/* Animated scan line */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "30%",
                height: "100%",
                background: "linear-gradient(90deg, transparent, rgba(197, 165, 114, 0.06), transparent)",
                animation: "crawl-scan 2s ease-in-out infinite",
              }}
            />
          </div>
          <div className="flex items-center h-full px-4 gap-3" style={{ position: "relative", zIndex: 1 }}>
            <CrawlSpinner size={16} />
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-widest font-medium" style={{ color: "var(--accent, #C5A572)" }}>
                  Crawling {crawlingNames.size} competitor{crawlingNames.size > 1 ? "s" : ""}
                </span>
                <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
                  {[...crawlingNames].join(", ")}
                </span>
              </div>
              <div
                style={{
                  height: 3,
                  background: "var(--border)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    background: "linear-gradient(90deg, var(--accent, #C5A572), #D4AF37)",
                    borderRadius: 2,
                    animation: "crawl-progress 60s ease-out forwards",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add competitor form */}
      <div
        className="mb-8 p-5 flex items-end gap-3"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <div className="flex-1">
          <label
            className="block text-[11px] uppercase tracking-widest mb-1.5"
            style={{ color: "var(--text-subtle)" }}
          >
            Competitor Name
          </label>
          <input
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="e.g. Tanishq"
            className="w-full px-3 py-2 text-sm"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-secondary)",
              outline: "none",
            }}
          />
        </div>
        <div className="flex-1">
          <label
            className="block text-[11px] uppercase tracking-widest mb-1.5"
            style={{ color: "var(--text-subtle)" }}
          >
            Website URL
          </label>
          <input
            type="url"
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            placeholder="https://www.tanishq.co.in"
            className="w-full px-3 py-2 text-sm"
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-secondary)",
              outline: "none",
            }}
          />
        </div>
        <button
          onClick={handleAdd}
          disabled={adding || !addName.trim() || !addUrl.trim()}
          className="px-4 py-2 text-xs font-medium uppercase tracking-wider"
          style={{
            background: adding ? "var(--bg-elevated)" : "#22C55E",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius-md, 6px)",
            cursor: adding ? "not-allowed" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {adding ? "Adding..." : "Add"}
        </button>
      </div>

      {/* Competitors table */}
      {isLoading ? (
        <div
          className="p-10 text-center text-sm"
          style={{ color: "var(--text-subtle)" }}
        >
          Loading competitors...
        </div>
      ) : !competitors?.length ? (
        <div
          className="p-10 text-center text-sm"
          style={{ color: "var(--text-subtle)" }}
        >
          No competitors configured. Add one above or in the Google Sheet
          Competitors tab.
        </div>
      ) : (
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                }}
              >
                {["Name", "URL", "Last Crawled", "Products", "Status", "Actions"].map(
                  (h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-3 text-[10px] uppercase tracking-widest font-medium"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {competitors.map((comp) => {
                const latest = results?.find(
                  (r) => r.competitorName === comp.name
                );
                const crawlData = latest?.data as Record<string, unknown> | undefined;
                const productsFound = (crawlData?.products as unknown[])?.length ?? "-";
                const crawlDifficulty = (crawlData?.crawlDifficulty as string) || null;
                const crawlingThis = isCrawling(comp.name);

                return (
                  <tr
                    key={comp.name}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: crawlingThis ? "rgba(197, 165, 114, 0.03)" : "transparent",
                      transition: "background 0.3s ease",
                    }}
                  >
                    <td
                      className="px-5 py-4 font-medium"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <div className="flex items-center gap-2">
                        {crawlingThis && <CrawlSpinner size={14} />}
                        {comp.name}
                      </div>
                    </td>
                    <td className="px-5 py-4" style={{ color: "var(--text-subtle)" }}>
                      <a
                        href={comp.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        {comp.url.replace(/https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                      </a>
                    </td>
                    <td className="px-5 py-4" style={{ color: "var(--text-subtle)" }}>
                      {crawlingThis ? (
                        <span
                          style={{
                            color: "var(--accent, #C5A572)",
                            animation: "crawl-pulse 1.5s ease-in-out infinite",
                            display: "inline-block",
                          }}
                        >
                          Scanning pages<CrawlDots />
                        </span>
                      ) : latest ? (
                        new Date(latest.crawledAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      ) : (
                        "Never"
                      )}
                    </td>
                    <td
                      className="px-5 py-4 tabular-nums"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      {crawlingThis ? (
                        <span style={{ color: "var(--accent, #C5A572)", animation: "crawl-pulse 1.5s ease-in-out infinite", display: "inline-block" }}>
                          ...
                        </span>
                      ) : productsFound}
                    </td>
                    <td className="px-5 py-4">
                      {crawlingThis ? (
                        <CrawlBadge />
                      ) : crawlDifficulty === "blocked" ? (
                        <StatusBadge label="Blocked" color="#CC3333" />
                      ) : crawlDifficulty === "hard" ? (
                        <StatusBadge label="Hard Crawl" color="#D97706" />
                      ) : crawlDifficulty === "easy" ? (
                        <StatusBadge label="Easy" color="#22C55E" />
                      ) : (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--text-subtle)" }}
                        >
                          —
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleCrawlOne(comp.name)}
                          disabled={crawlingThis}
                          className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider"
                          style={{
                            background: crawlingThis
                              ? "rgba(197, 165, 114, 0.1)"
                              : "var(--bg-elevated)",
                            color: crawlingThis
                              ? "var(--accent, #C5A572)"
                              : "var(--text-secondary)",
                            border: crawlingThis
                              ? "1px solid rgba(197, 165, 114, 0.3)"
                              : "1px solid var(--border)",
                            borderRadius: "var(--radius-md, 6px)",
                            cursor: crawlingThis ? "not-allowed" : "pointer",
                            opacity: crawlingThis ? 0.7 : 1,
                          }}
                        >
                          {crawlingThis ? (
                            <span className="flex items-center gap-1.5">
                              <CrawlSpinner size={10} />
                              Crawling
                            </span>
                          ) : (
                            "Crawl"
                          )}
                        </button>
                        <button
                          onClick={() => handleDownload(comp.name)}
                          className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider"
                          style={{
                            background: "var(--bg-elevated)",
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-md, 6px)",
                            cursor: "pointer",
                          }}
                        >
                          Download
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Results */}
      {results && results.length > 0 && (
        <div className="mt-10">
          <h2
            className="text-[11px] uppercase tracking-widest mb-4 font-medium"
            style={{ color: "var(--text-subtle)" }}
          >
            Recent Crawl Results
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 stagger">
            {results.slice(0, 6).map((r) => {
              const data = r.data as Record<string, unknown>;
              const products = (data?.products as unknown[]) ?? [];
              const meta = data?.meta as Record<string, unknown> | undefined;
              const techSeo = data?.techSeo as Record<string, unknown> | undefined;
              const difficulty = data?.crawlDifficulty as string | undefined;

              return (
                <div
                  key={r.id}
                  className="card p-6"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-sm font-medium"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {r.competitorName}
                      </span>
                      {difficulty === "blocked" && (
                        <StatusBadge label="Blocked" color="#CC3333" small />
                      )}
                      {difficulty === "hard" && (
                        <StatusBadge label="Hard Crawl" color="#D97706" small />
                      )}
                      {difficulty === "easy" && (
                        <StatusBadge label="Easy" color="#22C55E" small />
                      )}
                    </div>
                    <span
                      className="text-[10px]"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      {new Date(r.crawledAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div>
                      <p
                        className="text-[10px] uppercase tracking-widest mb-1"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        Products
                      </p>
                      <p
                        className="text-lg font-semibold tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {products.length}
                      </p>
                    </div>
                    <div>
                      <p
                        className="text-[10px] uppercase tracking-widest mb-1"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        Pages
                      </p>
                      <p
                        className="text-lg font-semibold tabular-nums"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {(data?.pageCount as number) ?? "-"}
                      </p>
                    </div>
                    <div>
                      <p
                        className="text-[10px] uppercase tracking-widest mb-1"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        Schema
                      </p>
                      <p
                        className="text-lg font-semibold"
                        style={{
                          color: techSeo?.hasSchema
                            ? "#22C55E"
                            : "var(--error)",
                        }}
                      >
                        {techSeo?.hasSchema ? "Yes" : "No"}
                      </p>
                    </div>
                  </div>

                  {typeof meta?.description === "string" && meta.description && (
                    <p
                      className="text-xs leading-relaxed line-clamp-2"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      {meta.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

/** Gold spinning loader */
function CrawlSpinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: "crawl-spin 1s linear infinite", flexShrink: 0 }}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="rgba(197, 165, 114, 0.2)"
        strokeWidth="3"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="#C5A572"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Animated dots "..." */
function CrawlDots() {
  return (
    <span style={{ display: "inline-flex", gap: 1, marginLeft: 1 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            animation: `crawl-dot 1.4s ${i * 0.2}s ease-in-out infinite`,
            display: "inline-block",
          }}
        >
          .
        </span>
      ))}
    </span>
  );
}

/** Animated "CRAWLING" badge shown during active crawl */
function CrawlBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-full"
      style={{
        background: "linear-gradient(135deg, rgba(197, 165, 114, 0.15), rgba(212, 175, 55, 0.15))",
        color: "#C5A572",
        border: "1px solid rgba(197, 165, 114, 0.35)",
        animation: "crawl-pulse 2s ease-in-out infinite",
      }}
    >
      <CrawlSpinner size={10} />
      Crawling
    </span>
  );
}

/** Static status badge */
function StatusBadge({ label, color, small }: { label: string; color: string; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center ${small ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-0.5 text-[9px]"} font-bold uppercase tracking-wider rounded-full`}
      style={{
        background: `${color}1F`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      {label}
    </span>
  );
}

/** Crawl status message banner */
function CrawlStatusBanner({ message, isError }: { message: string; isError: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
      style={{
        background: isError
          ? "rgba(204, 51, 51, 0.08)"
          : "rgba(197, 165, 114, 0.08)",
        color: isError ? "var(--error)" : "var(--accent, #C5A572)",
        border: isError
          ? "1px solid rgba(204, 51, 51, 0.2)"
          : "1px solid rgba(197, 165, 114, 0.2)",
      }}
    >
      {!isError && <CrawlSpinner size={11} />}
      {message}
    </span>
  );
}
