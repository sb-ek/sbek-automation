"use client";

import { useState } from "react";
import { useCompetitors, useCompetitorResults } from "@/lib/hooks";
import { PageHeader } from "@/components/page-header";
import { postApi, fetchApi } from "@/lib/api";

export default function CompetitorsPage() {
  const { data: competitors, isLoading, mutate } = useCompetitors();
  const { data: results, mutate: mutateResults } = useCompetitorResults();

  const [crawling, setCrawling] = useState(false);
  const [crawlMsg, setCrawlMsg] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleCrawlAll() {
    setCrawling(true);
    setCrawlMsg("");
    try {
      const res = await postApi<{ enqueued: number; competitors: string[] }>(
        "/dashboard/competitors/crawl"
      );
      setCrawlMsg(`Crawling ${res.enqueued} competitors...`);
      setTimeout(() => {
        mutateResults();
        setCrawlMsg("");
      }, 10_000);
    } catch {
      setCrawlMsg("Failed to start crawl");
      setTimeout(() => setCrawlMsg(""), 3000);
    } finally {
      setCrawling(false);
    }
  }

  async function handleCrawlOne(name: string) {
    setCrawlMsg(`Crawling ${name}...`);
    try {
      await postApi("/dashboard/competitors/crawl", { name });
      setTimeout(() => {
        mutateResults();
        setCrawlMsg("");
      }, 10_000);
    } catch {
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

  function handleDownload(name?: string) {
    const url = name
      ? `/api/dashboard/competitors/results/download?name=${encodeURIComponent(name)}`
      : `/api/dashboard/competitors/results/download`;
    window.open(url, "_blank");
  }

  return (
    <div className="animate-enter">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <PageHeader title="Competitors" />
        <div className="flex items-center gap-3">
          {crawlMsg && (
            <span
              className="text-xs"
              style={{
                color: crawlMsg.includes("Failed")
                  ? "var(--error)"
                  : "var(--text-subtle)",
              }}
            >
              {crawlMsg}
            </span>
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
            disabled={crawling || !competitors?.length}
            className="px-4 py-2 text-xs font-medium uppercase tracking-wider"
            style={{
              background: crawling ? "var(--bg-elevated)" : "#1A1A1A",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-md, 6px)",
              cursor: crawling ? "not-allowed" : "pointer",
              opacity: crawling ? 0.6 : 1,
            }}
          >
            {crawling ? "Crawling..." : "Crawl All"}
          </button>
        </div>
      </div>

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

                return (
                  <tr
                    key={comp.name}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td
                      className="px-5 py-4 font-medium"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {comp.name}
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
                      {latest
                        ? new Date(latest.crawledAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "Never"}
                    </td>
                    <td
                      className="px-5 py-4 tabular-nums"
                      style={{ color: "var(--text-subtle)" }}
                    >
                      {productsFound}
                    </td>
                    <td className="px-5 py-4">
                      {crawlDifficulty === "blocked" ? (
                        <span
                          className="inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(204, 51, 51, 0.12)",
                            color: "#CC3333",
                            border: "1px solid rgba(204, 51, 51, 0.25)",
                          }}
                        >
                          Blocked
                        </span>
                      ) : crawlDifficulty === "hard" ? (
                        <span
                          className="inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(217, 119, 6, 0.12)",
                            color: "#D97706",
                            border: "1px solid rgba(217, 119, 6, 0.25)",
                          }}
                        >
                          Hard Crawl
                        </span>
                      ) : crawlDifficulty === "easy" ? (
                        <span
                          className="inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(34, 197, 94, 0.12)",
                            color: "#22C55E",
                            border: "1px solid rgba(34, 197, 94, 0.25)",
                          }}
                        >
                          Easy
                        </span>
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
                          className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider"
                          style={{
                            background: "var(--bg-elevated)",
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius-md, 6px)",
                            cursor: "pointer",
                          }}
                        >
                          Crawl
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
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(204, 51, 51, 0.12)",
                            color: "#CC3333",
                            border: "1px solid rgba(204, 51, 51, 0.25)",
                          }}
                        >
                          Blocked
                        </span>
                      )}
                      {difficulty === "hard" && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(217, 119, 6, 0.12)",
                            color: "#D97706",
                            border: "1px solid rgba(217, 119, 6, 0.25)",
                          }}
                        >
                          Hard Crawl
                        </span>
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
