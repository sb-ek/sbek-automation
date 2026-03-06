"use client";

import { useState, useEffect } from "react";
import { PageHeader } from "@/components/page-header";
import { fetchApi } from "@/lib/api";

interface ProductSeoStatus {
  id: number;
  name: string;
  slug: string;
  image: string | null;
  price: string;
  seo: { title: string | null; description: string | null; hasMeta: boolean };
  faq: { hasJsonLd: boolean; hasHtml: boolean; count: number };
  schema: { hasJsonLd: boolean };
  internalLinks: boolean;
}

interface SeoStats {
  total: number;
  withSeoMeta: number;
  withFaq: number;
  withSchema: number;
  withInternalLinks: number;
}

interface SeoProductsResponse {
  products: ProductSeoStatus[];
  stats: SeoStats;
  page: number;
  perPage: number;
}

interface JobLog {
  id: number;
  queueName: string;
  jobId: string;
  status: string;
  payload: { productId?: number; productName?: string; type?: string } | null;
  result: unknown;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SchemaTemplate {
  name: string;
  content: Record<string, unknown>;
}

interface Prompt {
  name: string;
  content: string;
}

interface ContentType {
  type: string;
  label: string;
  description: string;
}

interface SeoConfigData {
  schemas: SchemaTemplate[];
  prompts: Prompt[];
  contentTypes: ContentType[];
}

export default function SeoPage() {
  const [productsData, setProductsData] = useState<SeoProductsResponse | null>(
    null
  );
  const [activity, setActivity] = useState<JobLog[]>([]);
  const [config, setConfig] = useState<SeoConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"products" | "activity" | "config">(
    "products"
  );
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchApi<SeoProductsResponse>("/dashboard/seo/products").catch(() => ({
        products: [],
        stats: {
          total: 0,
          withSeoMeta: 0,
          withFaq: 0,
          withSchema: 0,
          withInternalLinks: 0,
        },
        page: 1,
        perPage: 20,
      })),
      fetchApi<{ jobs: JobLog[] }>("/dashboard/seo/activity").catch(() => ({
        jobs: [],
      })),
      fetchApi<SeoConfigData>("/dashboard/seo").catch(() => ({
        schemas: [],
        prompts: [],
        contentTypes: [],
      })),
    ]).then(([prodData, actData, cfgData]) => {
      setProductsData(prodData);
      setActivity(actData.jobs);
      setConfig(cfgData);
      setLoading(false);
    });
  }, []);

  const stats = productsData?.stats;

  const formatName = (name: string) =>
    name
      .split(/[_-]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const typeLabels: Record<string, string> = {
    seo_meta: "SEO Meta",
    faq: "FAQ",
    aeo_kb: "AEO KB",
    comparison: "Comparison",
    schema_inject: "Schema",
    internal_links: "Internal Links",
  };

  return (
    <div className="animate-enter">
      <PageHeader title="SEO & AEO" />

      {loading ? (
        <div
          className="p-10 text-center text-sm"
          style={{ color: "var(--text-subtle)" }}
        >
          Loading SEO data...
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8 stagger">
            <StatCard
              label="Products"
              value={stats?.total ?? 0}
              total={stats?.total ?? 0}
            />
            <StatCard
              label="SEO Meta"
              value={stats?.withSeoMeta ?? 0}
              total={stats?.total ?? 0}
            />
            <StatCard
              label="FAQs"
              value={stats?.withFaq ?? 0}
              total={stats?.total ?? 0}
            />
            <StatCard
              label="Schema"
              value={stats?.withSchema ?? 0}
              total={stats?.total ?? 0}
            />
            <StatCard
              label="Int. Links"
              value={stats?.withInternalLinks ?? 0}
              total={stats?.total ?? 0}
            />
          </div>

          {/* Tab switcher */}
          <div
            className="flex gap-1 mb-6 p-1 rounded-lg"
            style={{ background: "var(--bg-elevated)", display: "inline-flex" }}
          >
            {(
              [
                { key: "products", label: "Products" },
                { key: "activity", label: "Activity" },
                { key: "config", label: "Config" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="px-4 py-1.5 text-xs font-medium rounded-md"
                style={{
                  background:
                    tab === t.key ? "var(--bg)" : "transparent",
                  color:
                    tab === t.key
                      ? "var(--text-secondary)"
                      : "var(--text-subtle)",
                  border:
                    tab === t.key
                      ? "1px solid var(--border)"
                      : "1px solid transparent",
                  cursor: "pointer",
                  boxShadow:
                    tab === t.key ? "0 1px 2px rgba(0,0,0,0.04)" : "none",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Products Tab */}
          {tab === "products" && (
            <section>
              <p
                className="text-xs mb-5 leading-relaxed"
                style={{ color: "var(--text-subtle)" }}
              >
                SEO content status for each product. Green = generated, gray =
                pending.
              </p>

              {productsData?.products.length === 0 ? (
                <div
                  className="card p-8 text-center text-sm"
                  style={{ color: "var(--text-subtle)" }}
                >
                  No products found. Connect WooCommerce in Settings to see
                  product SEO status.
                </div>
              ) : (
                <div className="space-y-2 stagger">
                  {productsData?.products.map((product) => (
                    <div
                      key={product.id}
                      className="card"
                      style={{ overflow: "hidden" }}
                    >
                      <button
                        onClick={() =>
                          setExpandedProduct(
                            expandedProduct === product.id
                              ? null
                              : product.id
                          )
                        }
                        className="w-full flex items-center gap-4 px-5 py-3.5"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        {/* Product image */}
                        {product.image && (
                          <img
                            src={product.image}
                            alt=""
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 6,
                              objectFit: "cover",
                              flexShrink: 0,
                            }}
                          />
                        )}
                        {!product.image && (
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 6,
                              background: "var(--bg-elevated)",
                              flexShrink: 0,
                            }}
                          />
                        )}

                        {/* Name + price */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            className="text-sm font-semibold truncate"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {product.name}
                          </div>
                          {product.price && (
                            <span
                              className="text-[10px]"
                              style={{ color: "var(--text-subtle)" }}
                            >
                              ₹{Number(product.price).toLocaleString("en-IN")}
                            </span>
                          )}
                        </div>

                        {/* Status pills */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <StatusPill
                            label="Meta"
                            active={product.seo.hasMeta}
                          />
                          <StatusPill
                            label="FAQ"
                            active={product.faq.hasJsonLd}
                          />
                          <StatusPill
                            label="Schema"
                            active={product.schema.hasJsonLd}
                          />
                          <StatusPill
                            label="Links"
                            active={product.internalLinks}
                          />
                        </div>

                        {/* Expand chevron */}
                        <span
                          className="text-xs flex-shrink-0"
                          style={{ color: "var(--text-subtle)" }}
                        >
                          {expandedProduct === product.id ? "▲" : "▼"}
                        </span>
                      </button>

                      {/* Expanded details */}
                      {expandedProduct === product.id && (
                        <div
                          className="px-5 pb-4"
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                            {/* SEO Meta */}
                            <div
                              className="p-3 rounded-lg"
                              style={{ background: "var(--bg-elevated)" }}
                            >
                              <h4
                                className="text-[10px] uppercase tracking-wider font-medium mb-2"
                                style={{ color: "var(--text-subtle)" }}
                              >
                                SEO Meta (Yoast)
                              </h4>
                              {product.seo.hasMeta ? (
                                <>
                                  <p
                                    className="text-xs font-medium mb-1"
                                    style={{
                                      color: "var(--text-secondary)",
                                    }}
                                  >
                                    {product.seo.title}
                                  </p>
                                  <p
                                    className="text-[11px] leading-relaxed"
                                    style={{ color: "var(--text-subtle)" }}
                                  >
                                    {product.seo.description}
                                  </p>
                                </>
                              ) : (
                                <p
                                  className="text-[11px]"
                                  style={{ color: "var(--text-subtle)" }}
                                >
                                  Not generated yet
                                </p>
                              )}
                            </div>

                            {/* FAQ */}
                            <div
                              className="p-3 rounded-lg"
                              style={{ background: "var(--bg-elevated)" }}
                            >
                              <h4
                                className="text-[10px] uppercase tracking-wider font-medium mb-2"
                                style={{ color: "var(--text-subtle)" }}
                              >
                                FAQ Schema
                              </h4>
                              {product.faq.hasJsonLd ? (
                                <p
                                  className="text-xs"
                                  style={{ color: "var(--text-secondary)" }}
                                >
                                  {product.faq.count} FAQ
                                  {product.faq.count !== 1 ? "s" : ""} generated
                                  {product.faq.hasHtml
                                    ? " + visible on page"
                                    : ""}
                                </p>
                              ) : (
                                <p
                                  className="text-[11px]"
                                  style={{ color: "var(--text-subtle)" }}
                                >
                                  Not generated yet
                                </p>
                              )}
                            </div>

                            {/* Schema */}
                            <div
                              className="p-3 rounded-lg"
                              style={{ background: "var(--bg-elevated)" }}
                            >
                              <h4
                                className="text-[10px] uppercase tracking-wider font-medium mb-2"
                                style={{ color: "var(--text-subtle)" }}
                              >
                                JSON-LD Schema
                              </h4>
                              <p
                                className="text-[11px]"
                                style={{
                                  color: product.schema.hasJsonLd
                                    ? "var(--text-secondary)"
                                    : "var(--text-subtle)",
                                }}
                              >
                                {product.schema.hasJsonLd
                                  ? "Product + Organization schema injected"
                                  : "Not generated yet"}
                              </p>
                            </div>

                            {/* Internal Links */}
                            <div
                              className="p-3 rounded-lg"
                              style={{ background: "var(--bg-elevated)" }}
                            >
                              <h4
                                className="text-[10px] uppercase tracking-wider font-medium mb-2"
                                style={{ color: "var(--text-subtle)" }}
                              >
                                Internal Links
                              </h4>
                              <p
                                className="text-[11px]"
                                style={{
                                  color: product.internalLinks
                                    ? "var(--text-secondary)"
                                    : "var(--text-subtle)",
                                }}
                              >
                                {product.internalLinks
                                  ? '"You May Also Like" section added'
                                  : "Not generated yet"}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Activity Tab */}
          {tab === "activity" && (
            <section>
              <p
                className="text-xs mb-5 leading-relaxed"
                style={{ color: "var(--text-subtle)" }}
              >
                Recent content pipeline jobs — AI-generated SEO content for your
                products.
              </p>

              {activity.length === 0 ? (
                <div
                  className="card p-8 text-center text-sm"
                  style={{ color: "var(--text-subtle)" }}
                >
                  No content generation activity yet. Jobs run automatically
                  when new products are added.
                </div>
              ) : (
                <div className="space-y-2 stagger">
                  {activity.map((job) => (
                    <div
                      key={job.id}
                      className="card px-5 py-3.5 flex items-center gap-3"
                    >
                      {/* Status dot */}
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          flexShrink: 0,
                          background:
                            job.status === "completed"
                              ? "#22C55E"
                              : job.status === "failed"
                              ? "#EF4444"
                              : job.status === "active"
                              ? "#3B82F6"
                              : "#9CA3AF",
                        }}
                      />

                      {/* Type badge */}
                      <span
                        className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{
                          background: "var(--bg-elevated)",
                          color: "var(--text-subtle)",
                        }}
                      >
                        {typeLabels[job.payload?.type ?? ""] ??
                          job.payload?.type ??
                          "Unknown"}
                      </span>

                      {/* Product name */}
                      <span
                        className="text-xs font-medium truncate"
                        style={{
                          color: "var(--text-secondary)",
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {job.payload?.productName ?? `Product #${job.payload?.productId ?? "?"}`}
                      </span>

                      {/* Status */}
                      <span
                        className="text-[10px] font-medium flex-shrink-0"
                        style={{
                          color:
                            job.status === "completed"
                              ? "#22C55E"
                              : job.status === "failed"
                              ? "#EF4444"
                              : "var(--text-subtle)",
                        }}
                      >
                        {job.status}
                      </span>

                      {/* Time */}
                      <span
                        className="text-[10px] flex-shrink-0"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        {job.createdAt
                          ? new Date(job.createdAt).toLocaleDateString(
                              "en-IN",
                              {
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Config Tab — original static config */}
          {tab === "config" && (
            <>
              {/* Content Pipeline Types */}
              <section className="mb-10">
                <h2
                  className="text-[11px] uppercase tracking-widest mb-4 font-medium"
                  style={{ color: "var(--text-subtle)" }}
                >
                  AI Content Pipeline
                </h2>
                <p
                  className="text-xs mb-5 leading-relaxed"
                  style={{ color: "var(--text-subtle)" }}
                >
                  Automated content generation triggered by new products or
                  scheduled cron jobs. Each type is pushed directly to your
                  WooCommerce store.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger">
                  {config?.contentTypes.map((ct) => (
                    <div key={ct.type} className="card p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <span
                          className="inline-flex items-center px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full"
                          style={{
                            background: "rgba(34, 197, 94, 0.12)",
                            color: "#22C55E",
                            border: "1px solid rgba(34, 197, 94, 0.25)",
                          }}
                        >
                          Active
                        </span>
                        <span
                          className="text-[10px] font-mono"
                          style={{ color: "var(--text-subtle)" }}
                        >
                          {ct.type}
                        </span>
                      </div>
                      <h3
                        className="text-sm font-semibold mb-1.5"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {ct.label}
                      </h3>
                      <p
                        className="text-xs leading-relaxed"
                        style={{ color: "var(--text-subtle)" }}
                      >
                        {ct.description}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              {/* Schema Templates */}
              <section className="mb-10">
                <h2
                  className="text-[11px] uppercase tracking-widest mb-4 font-medium"
                  style={{ color: "var(--text-subtle)" }}
                >
                  Schema.org Templates ({config?.schemas.length ?? 0})
                </h2>
                <div className="space-y-3">
                  {config?.schemas.map((schema) => (
                    <div
                      key={schema.name}
                      className="card"
                      style={{ overflow: "hidden" }}
                    >
                      <button
                        onClick={() =>
                          setExpandedSchema(
                            expandedSchema === schema.name
                              ? null
                              : schema.name
                          )
                        }
                        className="w-full flex items-center justify-between px-5 py-4"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="text-sm font-semibold"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {formatName(schema.name)}
                          </span>
                          <span
                            className="text-[10px] font-mono px-2 py-0.5 rounded"
                            style={{
                              background: "var(--bg-elevated)",
                              color: "var(--text-subtle)",
                            }}
                          >
                            @type:{" "}
                            {(schema.content as Record<string, string>)[
                              "@type"
                            ] ?? "Unknown"}
                          </span>
                        </div>
                        <span
                          className="text-xs"
                          style={{ color: "var(--text-subtle)" }}
                        >
                          {expandedSchema === schema.name ? "▲" : "▼"}
                        </span>
                      </button>
                      {expandedSchema === schema.name && (
                        <div
                          className="px-5 pb-4"
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <pre
                            className="text-[11px] leading-relaxed mt-3 p-4 rounded overflow-auto"
                            style={{
                              background: "var(--bg)",
                              color: "var(--text-subtle)",
                              maxHeight: 400,
                              fontFamily: "monospace",
                            }}
                          >
                            {JSON.stringify(schema.content, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* AI Prompts */}
              <section className="mb-10">
                <h2
                  className="text-[11px] uppercase tracking-widest mb-4 font-medium"
                  style={{ color: "var(--text-subtle)" }}
                >
                  AI Prompts ({config?.prompts.length ?? 0})
                </h2>
                <div className="space-y-3">
                  {config?.prompts.map((prompt) => (
                    <div
                      key={prompt.name}
                      className="card"
                      style={{ overflow: "hidden" }}
                    >
                      <button
                        onClick={() =>
                          setExpandedPrompt(
                            expandedPrompt === prompt.name
                              ? null
                              : prompt.name
                          )
                        }
                        className="w-full flex items-center justify-between px-5 py-4"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <span
                          className="text-sm font-semibold"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {formatName(prompt.name)}
                        </span>
                        <span
                          className="text-xs"
                          style={{ color: "var(--text-subtle)" }}
                        >
                          {expandedPrompt === prompt.name ? "▲" : "▼"}
                        </span>
                      </button>
                      {expandedPrompt === prompt.name && (
                        <div
                          className="px-5 pb-4"
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <pre
                            className="text-[11px] leading-relaxed mt-3 p-4 rounded overflow-auto whitespace-pre-wrap"
                            style={{
                              background: "var(--bg)",
                              color: "var(--text-subtle)",
                              maxHeight: 400,
                              fontFamily: "monospace",
                            }}
                          >
                            {prompt.content}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const isProducts = label === "Products";

  return (
    <div className="card p-4">
      <div
        className="text-[10px] uppercase tracking-wider font-medium mb-2"
        style={{ color: "var(--text-subtle)" }}
      >
        {label}
      </div>
      <div className="flex items-end gap-1.5">
        <span
          className="text-xl font-bold"
          style={{ color: "var(--text-secondary)" }}
        >
          {value}
        </span>
        {!isProducts && (
          <span
            className="text-[10px] mb-0.5"
            style={{ color: "var(--text-subtle)" }}
          >
            / {total}
          </span>
        )}
      </div>
      {!isProducts && (
        <div
          className="mt-2 rounded-full overflow-hidden"
          style={{ height: 3, background: "var(--bg-elevated)" }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: pct === 100 ? "#22C55E" : "#3B82F6",
              borderRadius: "inherit",
              transition: "width 0.5s ease",
            }}
          />
        </div>
      )}
    </div>
  );
}

function StatusPill({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{
        background: active ? "rgba(34, 197, 94, 0.12)" : "var(--bg-elevated)",
        color: active ? "#22C55E" : "var(--text-subtle)",
        border: active
          ? "1px solid rgba(34, 197, 94, 0.25)"
          : "1px solid var(--border)",
      }}
    >
      {label}
    </span>
  );
}
