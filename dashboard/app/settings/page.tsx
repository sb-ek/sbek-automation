"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSettings } from "@/lib/hooks";
import { fetchApi, putApi, postApi } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

/* ── Types ──────────────────────────────────────────────────────────── */

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "select";
  hint?: string;
  howToGet?: string;
  options?: string[];
  required?: boolean;
}

interface SectionDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  fields: FieldDef[];
  testable?: boolean;
  smtpFallbackFields?: FieldDef[];
}

interface ValidationResult {
  valid: boolean;
  message: string;
}

/* ── URL → ID Extractors ────────────────────────────────────────────── */

/** Extract the Sheet ID from a Google Sheets URL, or return the raw string if it's already just an ID */
function extractSheetId(input: string): string {
  const trimmed = input.trim();
  // Match: https://docs.google.com/spreadsheets/d/{ID}/...
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Already just an ID (no slashes)
  return trimmed;
}

/** Extract the folder ID from a Google Drive folder URL, or return the raw string */
function extractDriveFolderId(input: string): string {
  const trimmed = input.trim();
  // Match: https://drive.google.com/drive/folders/{ID}...
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return trimmed;
}

/* ── Section definitions — keys match CONFIGURABLE_KEYS (UPPERCASE) ── */

const SECTIONS: SectionDef[] = [
  {
    id: "woocommerce",
    title: "WooCommerce Store",
    icon: "\u2302",
    description:
      "Connect your WooCommerce store to sync products, orders, and customer data in real time.",
    testable: true,
    fields: [
      {
        key: "WOO_URL",
        label: "Store URL",
        type: "text",
        hint: "Full URL of your WooCommerce store",
        howToGet: "Your store's main URL, e.g. https://store.sbek.com",
        required: true,
      },
      {
        key: "WOO_CONSUMER_KEY",
        label: "Consumer Key",
        type: "password",
        hint: "Starts with ck_",
        howToGet: "WooCommerce → Settings → Advanced → REST API → Add Key → Read/Write",
        required: true,
      },
      {
        key: "WOO_CONSUMER_SECRET",
        label: "Consumer Secret",
        type: "password",
        hint: "Starts with cs_",
        howToGet: "Generated alongside the Consumer Key above",
        required: true,
      },
      {
        key: "WOO_WEBHOOK_SECRET",
        label: "Webhook Secret",
        type: "password",
        hint: "Secret for verifying webhook payloads",
        howToGet: "WooCommerce → Settings → Advanced → Webhooks → Add → copy the Secret",
        required: true,
      },
    ],
  },
  // Google section is handled separately as a custom component
  {
    id: "whatsapp-interakt",
    title: "WhatsApp (Interakt)",
    icon: "\u2709",
    description:
      "WhatsApp Business API via Interakt for order confirmations, shipping updates, competitor alerts, and review requests.",
    testable: true,
    fields: [
      {
        key: "INTERAKT_API_KEY",
        label: "API Key",
        type: "password",
        hint: "Your Interakt API key for sending WhatsApp messages",
        howToGet: "Go to app.interakt.ai → Settings → Developer Settings → API Keys → copy your API key",
        required: true,
      },
    ],
  },
  {
    id: "email-smtp",
    title: "Email (Gmail API)",
    icon: "\u2707",
    description:
      "Outbound email for order confirmations, shipping updates, and marketing. Uses Gmail API over HTTPS — works on all hosting platforms including Railway.",
    testable: true,
    fields: [
      {
        key: "EMAIL_FROM",
        label: "From Display Name",
        type: "text",
        hint: "How emails appear to recipients",
        howToGet: 'Format: Brand Name <email@domain.com>  e.g. SBEK <orders@sbek.com>',
        required: true,
      },
      {
        key: "GOOGLE_OAUTH_CLIENT_ID",
        label: "Gmail API — OAuth Client ID",
        type: "text",
        hint: "From Google Cloud Console → Credentials → OAuth 2.0 Client IDs",
        howToGet: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → copy Client ID",
        required: true,
      },
      {
        key: "GOOGLE_OAUTH_CLIENT_SECRET",
        label: "Gmail API — OAuth Client Secret",
        type: "password",
        hint: "From Google Cloud Console → Credentials → OAuth 2.0 Client IDs",
        howToGet: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID → copy Client Secret",
        required: true,
      },
      {
        key: "GOOGLE_OAUTH_REFRESH_TOKEN",
        label: "Gmail API — Refresh Token",
        type: "password",
        hint: "Generated via the setup-gmail-oauth script",
        howToGet: "Run: GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy npx tsx scripts/setup-gmail-oauth.ts",
        required: true,
      },
    ],
    // SMTP fallback fields are defined separately below
    smtpFallbackFields: [
      {
        key: "SMTP_HOST",
        label: "SMTP Host",
        type: "text",
        hint: "e.g. smtp.gmail.com",
      },
      {
        key: "SMTP_PORT",
        label: "SMTP Port",
        type: "text",
        hint: "587 for TLS, 465 for SSL",
      },
      {
        key: "SMTP_USER",
        label: "SMTP Email Address",
        type: "text",
        hint: "Your full email address",
      },
      {
        key: "SMTP_PASS",
        label: "SMTP Password",
        type: "password",
        hint: "App Password for Gmail",
      },
    ],
  },
  {
    id: "ai",
    title: "AI — Text & Image Generation",
    icon: "\u2726",
    description:
      "OpenRouter powers all AI — text generation (product descriptions, SEO, captions) and image generation (ad creatives, lifestyle shots). One key for everything.",
    testable: true,
    fields: [
      {
        key: "OPENROUTER_API_KEY",
        label: "OpenRouter API Key",
        type: "password",
        hint: "Powers ALL AI — text generation, image generation, captions, SEO, competitor analysis",
        howToGet: "Go to openrouter.ai → Sign Up → Dashboard → Keys (openrouter.ai/keys) → Create Key → copy. Add credits at openrouter.ai/credits (pay-as-you-go, ~$0.10-0.50 per product)",
        required: true,
      },
    ],
  },
  // Social Media (Postiz) section removed — not in use
  // Crawler section removed — built-in, no client config needed
  {
    id: "brand",
    title: "Brand Identity",
    icon: "\u2605",
    description:
      "Your brand details — used in emails, WhatsApp messages, AI-generated content, and social posts.",
    fields: [
      {
        key: "BRAND_NAME",
        label: "Brand Name",
        type: "text",
        hint: "e.g. SBEK",
        required: true,
      },
      {
        key: "BRAND_PRIMARY_COLOR",
        label: "Primary Color",
        type: "text",
        hint: "Hex code, e.g. #B8860B (used in email templates)",
      },
      {
        key: "BRAND_WEBSITE",
        label: "Website URL",
        type: "text",
        hint: "e.g. https://sbek.com",
      },
      {
        key: "BRAND_SUPPORT_PHONE",
        label: "Support Phone",
        type: "text",
        hint: "e.g. +91XXXXXXXXXX",
      },
      {
        key: "BRAND_SUPPORT_EMAIL",
        label: "Support Email",
        type: "text",
        hint: "e.g. support@sbek.com",
      },
      {
        key: "REVIEW_URL",
        label: "Review Link",
        type: "text",
        hint: "Where customers leave reviews (Google, Trustpilot, etc.)",
      },
    ],
  },
];

/* ── Icons ──────────────────────────────────────────────────────────── */

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <path d="M2 14L14 2" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      style={{
        transition: "transform 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        transform: open ? "rotate(0deg)" : "rotate(-90deg)",
        willChange: "transform",
      }}
    >
      <path d="M3 5l4 4 4-4" />
    </svg>
  );
}

function ValidationIcon({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
        <circle cx="7" cy="7" r="6" stroke="var(--text-secondary)" strokeWidth="1.2" fill="none" />
        <path d="M4 7l2 2 4-4" stroke="var(--text-secondary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
      <circle cx="7" cy="7" r="6" stroke="var(--border-strong)" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

/* ── Skeleton ───────────────────────────────────────────────────────── */

function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse ${className ?? ""}`} style={{ background: "var(--bg-hover)" }} />
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="p-6"
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <Skeleton className="h-4 w-32 mb-6" />
          <div className="space-y-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Inline Toast ──────────────────────────────────────────────────── */

function InlineToast({ result, onDismiss }: { result: ValidationResult; onDismiss: () => void }) {
  useEffect(() => {
    if (result.valid) {
      const t = setTimeout(onDismiss, 5000);
      return () => clearTimeout(t);
    }
  }, [result.valid, onDismiss]);

  return (
    <div
      className="flex items-start gap-2 px-3 py-2 mt-2 text-[11px] font-mono leading-relaxed animate-enter-fade"
      style={{
        background: result.valid ? "#F0FAF0" : "#FFF0F0",
        border: `1px solid ${result.valid ? "#D5E8D5" : "#E8D5D5"}`,
        borderRadius: "var(--radius-sm)",
        color: result.valid ? "var(--text-secondary)" : "var(--error)",
      }}
    >
      <span className="flex-shrink-0 mt-0.5">{result.valid ? "\u2713" : "\u2717"}</span>
      <span className="flex-1">{result.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="flex-shrink-0 ml-2 opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: result.valid ? "var(--text-secondary)" : "var(--error)" }}
      >
        \u2715
      </button>
    </div>
  );
}

/* ── Google Sheets & Drive Section (custom) ────────────────────────── */

function GoogleSection({
  values,
  sources,
  onChange,
}: {
  values: Record<string, string>;
  sources: Record<string, "database" | "env" | "none">;
  onChange: (key: string, val: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [devOpen, setDevOpen] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<{ connected: boolean; email: string }>({ connected: false, email: "" });
  const [oauthLoading, setOauthLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [setupStatus, setSetupStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [setupMsg, setSetupMsg] = useState("");

  // Sheet URL state — we show the user-friendly URL but store the extracted ID
  const [sheetUrl, setSheetUrl] = useState("");
  const [driveUrl, setDriveUrl] = useState("");

  // Derived: do we have service account or OAuth creds?
  const serviceAccountEmail = values["GOOGLE_SERVICE_ACCOUNT_EMAIL"] ?? "";
  const hasServiceAccount = serviceAccountEmail.length > 0 && !serviceAccountEmail.includes("***") && sources["GOOGLE_SERVICE_ACCOUNT_EMAIL"] !== "none";
  const hasOAuthCreds = (sources["GOOGLE_OAUTH_CLIENT_ID"] !== "none" && sources["GOOGLE_OAUTH_CLIENT_ID"] !== undefined);

  useEffect(() => {
    fetchApi<{ connected: boolean; email: string }>("/auth/google/status")
      .then(setOauthStatus)
      .catch(() => setOauthStatus({ connected: false, email: "" }))
      .finally(() => setOauthLoading(false));
  }, []);

  // Sync sheet URL from stored ID
  useEffect(() => {
    const storedId = values["GOOGLE_SHEET_ID"] ?? "";
    if (storedId && !storedId.includes("***") && !sheetUrl) {
      setSheetUrl(storedId.includes("/") ? storedId : `https://docs.google.com/spreadsheets/d/${storedId}/edit`);
    }
  }, [values, sheetUrl]);

  useEffect(() => {
    const storedId = values["GOOGLE_DRIVE_FOLDER_ID"] ?? "";
    if (storedId && !storedId.includes("***") && !driveUrl) {
      setDriveUrl(storedId.includes("/") ? storedId : `https://drive.google.com/drive/folders/${storedId}`);
    }
  }, [values, driveUrl]);

  const handleSheetUrlChange = (url: string) => {
    setSheetUrl(url);
    const id = extractSheetId(url);
    onChange("GOOGLE_SHEET_ID", id);
  };

  const handleDriveUrlChange = (url: string) => {
    setDriveUrl(url);
    if (url.trim()) {
      const id = extractDriveFolderId(url);
      onChange("GOOGLE_DRIVE_FOLDER_ID", id);
    } else {
      onChange("GOOGLE_DRIVE_FOLDER_ID", "");
    }
  };

  const handleConnect = () => {
    window.location.href = "/api/auth/google/authorize";
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await postApi("/auth/google/disconnect");
      setOauthStatus({ connected: false, email: "" });
    } catch { /* ignore */ }
    finally { setDisconnecting(false); }
  };

  const handleSetup = async () => {
    setSetupStatus("loading");
    setSetupMsg("");
    try {
      const result = await postApi<{ success: boolean; message?: string; error?: string }>("/dashboard/google/setup");
      if (result.success) {
        setSetupStatus("success");
        setSetupMsg(result.message || "Sheet tabs and Drive folder ready!");
      } else {
        setSetupStatus("error");
        setSetupMsg(result.error || "Setup failed");
      }
    } catch (err) {
      setSetupStatus("error");
      setSetupMsg(err instanceof Error ? err.message : "Setup failed");
    }
  };

  const sheetId = values["GOOGLE_SHEET_ID"] ?? "";
  const hasSheet = sheetId.length > 0 && !sheetId.includes("***");

  const configuredCount = [
    oauthStatus.connected || (sources["GOOGLE_SERVICE_ACCOUNT_EMAIL"] !== "none" && sources["GOOGLE_SERVICE_ACCOUNT_EMAIL"] !== undefined),
    sources["GOOGLE_SHEET_ID"] !== "none" && sources["GOOGLE_SHEET_ID"] !== undefined,
  ].filter(Boolean).length;

  const allDoneGoogle = configuredCount >= 2;

  return (
    <div
      className="mb-4"
      style={{
        border: `1px solid ${allDoneGoogle ? "#D5E8D5" : "var(--border)"}`,
        background: "var(--bg-surface)",
        borderRadius: "var(--radius-md)",
      }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left row-hover"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-base leading-none" style={{ color: "var(--text-subtle)" }}>{"\u25A6"}</span>
          <h2 className="text-xs uppercase tracking-[0.15em] font-medium" style={{ color: "var(--text-muted)" }}>
            Google Sheets & Drive
          </h2>
          {allDoneGoogle && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
              <circle cx="7" cy="7" r="6" stroke="#2D8A4E" strokeWidth="1.2" fill="#F0FAF0" />
              <path d="M4 7l2 2 4-4" stroke="#2D8A4E" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span
            className="text-[10px] font-mono"
            style={{ color: allDoneGoogle ? "#2D8A4E" : "var(--text-disabled)" }}
          >
            {configuredCount}/2
          </span>
        </div>
        <span style={{ color: "var(--text-subtle)" }}>
          <ChevronIcon open={open} />
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5" style={{ borderTop: "1px solid var(--border)" }}>
          <p className="text-[11px] leading-relaxed pt-4 pb-4" style={{ color: "var(--text-subtle)" }}>
            Share your Google Sheet and Drive folder with the service account email below, then paste the links. The system will auto-create all required tabs and columns.
          </p>

          {/* ── Step 1: Google Account ── */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold"
                style={{ background: (oauthStatus.connected || hasServiceAccount) ? "var(--text-secondary)" : "var(--border-strong)", color: (oauthStatus.connected || hasServiceAccount) ? "#fff" : "var(--text-muted)" }}
              >
                1
              </span>
              <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                Connect Google Account
              </span>
              {oauthStatus.connected && (
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
                  Connected via OAuth
                </span>
              )}
              {!oauthStatus.connected && hasServiceAccount && (
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
                  Connected via Service Account
                </span>
              )}
            </div>

            {oauthLoading ? (
              <div className="text-[11px] py-2 pl-7" style={{ color: "var(--text-subtle)" }}>Checking...</div>
            ) : oauthStatus.connected ? (
              <div
                className="flex items-center justify-between px-3 py-2.5 ml-7"
                style={{ background: "#F0FAF0", border: "1px solid #D5E8D5", borderRadius: "var(--radius-sm)" }}
              >
                <span className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Logged in as <strong>{oauthStatus.email}</strong>
                </span>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="btn-ghost px-2 py-1 text-[10px] uppercase tracking-wider font-medium"
                  style={{ color: "var(--error)", opacity: disconnecting ? 0.5 : 1 }}
                >
                  {disconnecting ? "..." : "Disconnect"}
                </button>
              </div>
            ) : hasOAuthCreds ? (
              <button
                type="button"
                onClick={handleConnect}
                className="btn-ghost ml-7 px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] font-medium flex items-center gap-2"
                style={{ background: "#F0F6FF", borderColor: "#D5E0F0", color: "var(--text-muted)" }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <circle cx="7" cy="7" r="5.5" />
                  <path d="M7 4v6M4 7h6" />
                </svg>
                Login with Google
              </button>
            ) : (
              <div className="ml-7">
                {hasServiceAccount ? (
                  <div
                    className="px-3 py-2.5"
                    style={{ background: "#F0FAF0", border: "1px solid #D5E8D5", borderRadius: "var(--radius-sm)" }}
                  >
                    <p className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
                      Service account connected. Share your Sheet and Drive folder with this email as <strong>Editor</strong>:
                    </p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <code
                        className="text-[11px] font-mono px-2 py-1 select-all cursor-text"
                        style={{ background: "#E8F5E8", borderRadius: "var(--radius-sm)", color: "#333" }}
                      >
                        {serviceAccountEmail}
                      </code>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(serviceAccountEmail); }}
                        className="text-[10px] px-2 py-0.5 font-medium uppercase tracking-wider"
                        style={{ color: "var(--text-subtle)", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="px-3 py-2.5"
                    style={{ background: "#FFF8F0", border: "1px solid #E8DDD5", borderRadius: "var(--radius-sm)" }}
                  >
                    <p className="text-[11px]" style={{ color: "var(--warning)" }}>
                      No Google account connected. Set up OAuth credentials or a service account in Developer Settings below.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Step 2: Google Sheet URL ── */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold"
                style={{ background: hasSheet ? "var(--text-secondary)" : "var(--border-strong)", color: hasSheet ? "#fff" : "var(--text-muted)" }}
              >
                2
              </span>
              <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                Google Sheet URL
              </span>
              {!hasSheet && (
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#CC3333" }}>
                  Required
                </span>
              )}
              {sources["GOOGLE_SHEET_ID"] && sources["GOOGLE_SHEET_ID"] !== "none" && (
                <span
                  className="badge text-[9px] font-mono uppercase tracking-wider"
                  style={{
                    color: sources["GOOGLE_SHEET_ID"] === "database" ? "var(--text-secondary)" : "var(--warning)",
                    background: sources["GOOGLE_SHEET_ID"] === "database" ? "#F0FAF0" : "#FFFEF0",
                  }}
                >
                  {sources["GOOGLE_SHEET_ID"] === "database" ? "DB" : "ENV"}
                </span>
              )}
            </div>
            <div className="ml-7">
              <input
                type="text"
                value={sheetUrl}
                onChange={(e) => handleSheetUrlChange(e.target.value)}
                className="input w-full font-mono text-sm"
                placeholder="https://docs.google.com/spreadsheets/d/your-sheet-id/edit"
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--text-subtle)" }}>
                <strong>How to set up:</strong> Go to <a href="https://sheets.google.com" target="_blank" rel="noopener" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>sheets.google.com</a> &rarr; Create a blank spreadsheet &rarr; Click <strong>Share</strong> &rarr; Add <strong>{hasServiceAccount ? serviceAccountEmail : "your service account email"}</strong> as <strong>Editor</strong> &rarr; Copy the URL and paste it here.
              </p>
              {hasSheet && (
                <p className="text-[10px] mt-0.5 font-mono" style={{ color: "var(--text-disabled)" }}>
                  Extracted ID: {sheetId}
                </p>
              )}
            </div>
          </div>

          {/* ── Step 3: Drive Folder URL (optional) ── */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold"
                style={{ background: "var(--border-strong)", color: "var(--text-muted)" }}
              >
                3
              </span>
              <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                Google Drive Folder URL
              </span>
              <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-subtle)" }}>
                Optional
              </span>
            </div>
            <div className="ml-7">
              <input
                type="text"
                value={driveUrl}
                onChange={(e) => handleDriveUrlChange(e.target.value)}
                className="input w-full font-mono text-sm"
                placeholder="https://drive.google.com/drive/folders/your-folder-id"
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--text-subtle)" }}>
                <strong>How to set up:</strong> Go to <a href="https://drive.google.com" target="_blank" rel="noopener" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>drive.google.com</a> &rarr; Create a new folder (e.g. &quot;SBEK Creatives&quot;) &rarr; Right-click &rarr; <strong>Share</strong> &rarr; Add <strong>{hasServiceAccount ? serviceAccountEmail : "your service account email"}</strong> as <strong>Editor</strong> &rarr; Open the folder &rarr; Copy the URL and paste it here. Leave empty to auto-create a folder.
              </p>
            </div>
          </div>

          {/* ── Setup Sheet Button ── */}
          <div
            className="pt-4 mt-2 flex items-center gap-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <button
              type="button"
              onClick={handleSetup}
              disabled={setupStatus === "loading" || (!oauthStatus.connected && !hasServiceAccount)}
              className="btn-ghost px-4 py-2 text-[11px] uppercase tracking-[0.08em] font-medium flex items-center gap-2"
              style={{
                background: setupStatus === "success" ? "#F0FAF0" : setupStatus === "error" ? "#FFF0F0" : "#F0F6FF",
                borderColor: setupStatus === "success" ? "#D5E8D5" : setupStatus === "error" ? "#E8D5D5" : "#D5E0F0",
                color: setupStatus === "success" ? "var(--text-secondary)" : setupStatus === "error" ? "var(--error)" : "var(--text-muted)",
                opacity: setupStatus === "loading" ? 0.7 : 1,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M1 6h3m4 0h3" />
                <circle cx="6" cy="6" r="2.5" />
              </svg>
              {setupStatus === "loading"
                ? "Setting up..."
                : setupStatus === "success"
                  ? "Sheet Ready!"
                  : "Setup Sheet & Drive"}
            </button>
            <span className="text-[10px]" style={{ color: "var(--text-subtle)" }}>
              Creates 7 tabs (Orders, Production, QC, etc.) with headers, dropdowns, and color coding
            </span>
          </div>

          {setupMsg && (
            <div
              className="mt-2 px-3 py-2 text-[11px] font-mono animate-enter-fade"
              style={{
                background: setupStatus === "error" ? "#FFF0F0" : "#F0FAF0",
                border: `1px solid ${setupStatus === "error" ? "#E8D5D5" : "#D5E8D5"}`,
                borderRadius: "var(--radius-sm)",
                color: setupStatus === "error" ? "var(--error)" : "var(--text-secondary)",
              }}
            >
              {setupMsg}
            </div>
          )}

          {/* ── Developer Settings (collapsible) ── */}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setDevOpen(!devOpen)}
              className="flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] font-medium py-1"
              style={{ color: "var(--text-disabled)" }}
            >
              <ChevronIcon open={devOpen} />
              Developer Settings (Service Account Fallback)
            </button>
            {devOpen && (
              <div className="mt-3 pl-4" style={{ borderLeft: "2px solid var(--border)" }}>
              <p className="text-[10px] mb-3" style={{ color: "var(--text-disabled)" }}>
                  These are managed by your developer. Service account credentials are configured via environment variables.
                </p>
                {[
                  { key: "GOOGLE_SERVICE_ACCOUNT_EMAIL", label: "Service Account Email", type: "text" as const, hint: "e.g. sbek-bot@project.iam.gserviceaccount.com" },
                  { key: "GOOGLE_PRIVATE_KEY", label: "Service Account Private Key", type: "textarea" as const, hint: "PEM-encoded private key" },
                ].map((field) => (
                  <SettingsField
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? ""}
                    source={sources[field.key]}
                    onChange={(val) => onChange(field.key, val)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Test Connection Button ─────────────────────────────────────────── */

function TestConnectionButton({
  sectionId,
  values,
  onResult,
}: {
  sectionId: string;
  values: Record<string, string>;
  onResult: (result: ValidationResult) => void;
}) {
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    try {
      const sectionFields = SECTIONS.find((s) => s.id === sectionId)?.fields ?? [];
      const sectionValues: Record<string, string> = {};
      for (const f of sectionFields) {
        const v = values[f.key];
        if (v && !v.includes("***")) sectionValues[f.key] = v;
      }
      const result = await postApi<ValidationResult>("/dashboard/settings/validate", {
        section: sectionId,
        values: sectionValues,
      });
      onResult(result);
    } catch (err) {
      onResult({ valid: false, message: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleTest}
      disabled={testing}
      className="btn-ghost px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] font-medium"
      style={{
        opacity: testing ? 0.7 : 1,
        color: testing ? "var(--text-subtle)" : "var(--text-muted)",
      }}
    >
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1 6h3m4 0h3" />
          <circle cx="6" cy="6" r="2.5" />
        </svg>
        {testing ? "Testing..." : "Test Connection"}
      </span>
    </button>
  );
}

/* ── Field component ────────────────────────────────────────────────── */

function SettingsField({
  field,
  value,
  source,
  onChange,
}: {
  field: FieldDef;
  value: string;
  source?: "database" | "env" | "none";
  onChange: (val: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const isSensitive = field.type === "password" || field.type === "textarea";
  const isTextarea = field.type === "textarea";
  const isSelect = field.type === "select";
  const hasFill = value.trim().length > 0;
  const isMasked = value.includes("***");

  const handleToggleVisible = async () => {
    if (!visible && isMasked && !revealedValue) {
      // Fetch the real value from the server
      setRevealing(true);
      try {
        const result = await fetchApi<{ value: string }>(`/dashboard/settings/reveal/${field.key}`);
        setRevealedValue(result.value);
      } catch {
        // If reveal fails, just show the masked value
      }
      setRevealing(false);
    }
    setVisible(!visible);
  };

  // Display value: show revealed value when visible and we have it
  const displayValue = visible && revealedValue && isMasked ? revealedValue : value;

  const inputClasses = "input w-full font-mono text-sm";

  const sourceBadge = source && source !== "none" && (
    <span
      className="badge text-[9px] font-mono uppercase tracking-wider"
      style={{
        color: source === "database" ? "var(--text-secondary)" : "var(--warning)",
        background: source === "database" ? "#F0FAF0" : "#FFFEF0",
      }}
    >
      {source === "database" ? "DB" : "ENV"}
    </span>
  );

  const labelRow = (
    <div className="flex items-center gap-2 mb-1.5">
      <ValidationIcon filled={hasFill} />
      <label
        className="text-[13px]"
        style={{
          color: "#222",
          fontWeight: field.required ? 700 : 500,
        }}
      >
        {field.label}
      </label>
      {field.required && !hasFill && (
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#CC3333" }}>
          Required
        </span>
      )}
      {sourceBadge}
    </div>
  );

  const hintBlock = (
    <>
      {field.hint && <p className="text-[12px] mt-1 font-medium" style={{ color: "#555" }}>{field.hint}</p>}
      {field.howToGet && (
        <p className="text-[11px] mt-1 flex items-start gap-1.5 leading-relaxed" style={{ color: "#777", background: "#F8F8F8", padding: "6px 8px", borderRadius: "4px", border: "1px solid #EEE" }}>
          <span className="flex-shrink-0 font-bold" style={{ color: "#999" }}>How:</span>
          <span>{field.howToGet}</span>
        </p>
      )}
    </>
  );

  if (isSelect) {
    return (
      <div className="mb-5">
        {labelRow}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClasses}
          style={{ appearance: "none" }}
        >
          <option value="">-- select --</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        {hintBlock}
      </div>
    );
  }

  if (isTextarea) {
    return (
      <div className="mb-5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-2">
            <ValidationIcon filled={hasFill} />
            <label
              className="text-xs"
              style={{
                color: "var(--text-muted)",
                fontWeight: field.required ? 600 : 400,
              }}
            >
              {field.label}
            </label>
            {field.required && !hasFill && (
              <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#CC3333" }}>
                Required
              </span>
            )}
            {sourceBadge}
          </div>
          <button
            type="button"
            onClick={handleToggleVisible}
            disabled={revealing}
            className="p-1 transition-colors"
            style={{ color: "var(--text-subtle)" }}
            title={visible ? "Hide value" : "Show value"}
          >
            {revealing ? <span className="text-[10px]">...</span> : visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        <textarea
          value={displayValue}
          onChange={(e) => { setRevealedValue(null); onChange(e.target.value); }}
          rows={4}
          className={`${inputClasses} resize-y`}
          style={
            visible ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)
          }
          spellCheck={false}
        />
        {hintBlock}
      </div>
    );
  }

  return (
    <div className="mb-5">
      {labelRow}
      <div className="relative">
        <input
          type={isSensitive && !visible ? "password" : "text"}
          value={displayValue}
          onChange={(e) => { setRevealedValue(null); onChange(e.target.value); }}
          className={inputClasses}
          spellCheck={false}
          autoComplete="off"
        />
        {isSensitive && (
          <button
            type="button"
            onClick={handleToggleVisible}
            disabled={revealing}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 transition-colors"
            style={{ color: "var(--text-subtle)" }}
            title={visible ? "Hide value" : "Show value"}
          >
            {revealing ? <span className="text-[10px]">...</span> : visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
      {hintBlock}
    </div>
  );
}

/* ── Section component ──────────────────────────────────────────────── */

function SettingsSection({
  section,
  values,
  sources,
  onChange,
  validationResult,
  onValidationResult,
}: {
  section: SectionDef;
  values: Record<string, string>;
  sources: Record<string, "database" | "env" | "none">;
  onChange: (key: string, val: string) => void;
  validationResult?: ValidationResult | null;
  onValidationResult: (sectionId: string, result: ValidationResult | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const [smtpOpen, setSmtpOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | "auto">("auto");
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      const observer = new ResizeObserver(() => {
        if (contentRef.current && open) {
          setContentHeight(contentRef.current.scrollHeight);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, [open]);

  const toggleOpen = useCallback(() => {
    if (open) {
      if (contentRef.current) {
        setContentHeight(contentRef.current.scrollHeight);
      }
      setIsAnimating(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setContentHeight(0);
        });
      });
      setTimeout(() => {
        setOpen(false);
        setIsAnimating(false);
      }, 300);
    } else {
      setOpen(true);
      setContentHeight(0);
      setIsAnimating(true);
      requestAnimationFrame(() => {
        if (contentRef.current) {
          setContentHeight(contentRef.current.scrollHeight);
        }
      });
      setTimeout(() => {
        setContentHeight("auto");
        setIsAnimating(false);
      }, 300);
    }
  }, [open]);

  const configuredCount = section.fields.filter(
    (f) => sources[f.key] !== "none" && sources[f.key] !== undefined
  ).length;
  const totalCount = section.fields.length;
  const requiredFields = section.fields.filter((f) => f.required);
  const requiredDone = requiredFields.every(
    (f) => sources[f.key] !== "none" && sources[f.key] !== undefined
  );
  const allDone = configuredCount === totalCount;

  return (
    <div
      className="mb-4"
      style={{
        border: `1px solid ${allDone ? "#D5E8D5" : "var(--border)"}`,
        background: "var(--bg-surface)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <button
        type="button"
        onClick={toggleOpen}
        className="w-full flex items-center justify-between px-5 py-4 text-left row-hover"
        style={{ borderRadius: "var(--radius-md)" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-base leading-none" style={{ color: "#555" }}>{section.icon}</span>
          <h2 className="text-[13px] uppercase tracking-[0.12em] font-bold" style={{ color: "#333" }}>
            {section.title}
          </h2>
          {requiredDone && (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
              <circle cx="7" cy="7" r="6" stroke="#2D8A4E" strokeWidth="1.2" fill="#F0FAF0" />
              <path d="M4 7l2 2 4-4" stroke="#2D8A4E" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span
            className="text-[10px] font-mono"
            style={{ color: requiredDone ? "#2D8A4E" : "var(--text-disabled)" }}
          >
            {configuredCount}/{totalCount}
          </span>
        </div>
        <span style={{ color: "var(--text-subtle)" }}>
          <ChevronIcon open={open} />
        </span>
      </button>

      {(open || isAnimating) && (
        <div
          ref={contentRef}
          style={{
            maxHeight: contentHeight === "auto" ? "none" : `${contentHeight}px`,
            overflow: "hidden",
            transition: isAnimating ? "max-height 300ms cubic-bezier(0.4, 0, 0.2, 1)" : "none",
          }}
        >
          <div className="px-5 pb-5" style={{ borderTop: "1px solid var(--border)" }}>
            <p className="text-[12px] leading-relaxed pt-4 pb-3 font-medium" style={{ color: "#666" }}>
              {section.description}
            </p>
            <div>
              {section.fields.map((field) => (
                <SettingsField
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  source={sources[field.key]}
                  onChange={(val) => onChange(field.key, val)}
                />
              ))}
            </div>
            {section.smtpFallbackFields && section.smtpFallbackFields.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setSmtpOpen(!smtpOpen)}
                  className="flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] font-medium py-1"
                  style={{ color: "var(--text-disabled)" }}
                >
                  <ChevronIcon open={smtpOpen} />
                  SMTP Fallback (optional)
                </button>
                {smtpOpen && (
                  <div className="mt-2 pl-4" style={{ borderLeft: "2px solid var(--border)" }}>
                    <p className="text-[10px] mb-2" style={{ color: "var(--text-disabled)" }}>
                      Only needed if Gmail API is not set up. SMTP is blocked on some hosts (e.g. Railway).
                    </p>
                    {section.smtpFallbackFields.map((field) => (
                      <SettingsField
                        key={field.key}
                        field={field}
                        value={values[field.key] ?? ""}
                        source={sources[field.key]}
                        onChange={(val) => onChange(field.key, val)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            {section.testable && (
              <div
                className="pt-3 mt-1 flex items-center justify-between gap-3"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <div className="flex-1 min-w-0">
                  {validationResult && (
                    <InlineToast
                      result={validationResult}
                      onDismiss={() => onValidationResult(section.id, null)}
                    />
                  )}
                </div>
                <TestConnectionButton
                  sectionId={section.id}
                  values={values}
                  onResult={(result) => onValidationResult(section.id, result)}
                />
              </div>
            )}
            {!section.testable && validationResult && (
              <InlineToast
                result={validationResult}
                onDismiss={() => onValidationResult(section.id, null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Save status types ──────────────────────────────────────────────── */

type SaveStatus = "idle" | "saving" | "success" | "error";

/* ── Main Settings page ─────────────────────────────────────────────── */

export default function SettingsPage() {
  const { data: remote, isLoading, error: fetchError } = useSettings();

  const [values, setValues] = useState<Record<string, string>>({});
  const [initialValues, setInitialValues] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, "database" | "env" | "none">>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [validationResults, setValidationResults] = useState<Record<string, ValidationResult | null>>({});

  // Hydrate form from API response
  useEffect(() => {
    if (remote && !hydrated) {
      const flat: Record<string, string> = {};
      const src: Record<string, "database" | "env" | "none"> = {};

      if (Array.isArray(remote.settings)) {
        for (const item of remote.settings) {
          flat[item.key] = item.maskedValue;
          src[item.key] = item.source;
        }
      } else {
        const raw = remote as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) {
          if (k !== "settings" && k !== "configurableKeys") {
            flat[k.toUpperCase()] = v != null ? String(v) : "";
            src[k.toUpperCase()] = "database";
          }
        }
      }

      setValues(flat);
      setInitialValues(flat);
      setSources(src);
      setHydrated(true);
    }
  }, [remote, hydrated]);

  const handleChange = useCallback((key: string, val: string) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setSaveStatus("idle");
    setSaveError(null);
  }, []);

  const handleValidationResult = useCallback((sectionId: string, result: ValidationResult | null) => {
    setValidationResults((prev) => ({ ...prev, [sectionId]: result }));
  }, []);

  const allKeys = new Set([...Object.keys(values), ...Object.keys(initialValues)]);
  const dirtyKeys: string[] = [];
  allKeys.forEach((k) => {
    if ((values[k] ?? "") !== (initialValues[k] ?? "")) {
      dirtyKeys.push(k);
    }
  });
  const hasChanges = dirtyKeys.length > 0;

  const dirtySections = new Set<string>();
  for (const k of dirtyKeys) {
    for (const s of SECTIONS) {
      if (s.fields.some((f) => f.key === k)) {
        dirtySections.add(s.id);
      }
    }
  }

  const handleSave = async () => {
    if (!hasChanges) return;

    setSaveStatus("saving");
    setSaveError(null);
    setValidationResults({});

    const keys: Record<string, string | null> = {};
    for (const k of dirtyKeys) {
      const val = values[k]?.trim() ?? "";
      keys[k] = val === "" ? null : val;
    }

    try {
      await putApi("/dashboard/settings", { keys });
      setSaveStatus("success");
      setInitialValues({ ...values });

      setSources((prev) => {
        const next = { ...prev };
        for (const k of dirtyKeys) {
          next[k] = keys[k] ? "database" : "none";
        }
        return next;
      });

      // Auto-validate testable dirty sections
      for (const sectionId of dirtySections) {
        const section = SECTIONS.find((s) => s.id === sectionId);
        if (!section?.testable) continue;

        const sectionValues: Record<string, string> = {};
        for (const f of section.fields) {
          if (values[f.key]) sectionValues[f.key] = values[f.key];
        }

        postApi<ValidationResult>("/dashboard/settings/validate", {
          section: sectionId,
          values: sectionValues,
        })
          .then((result) => {
            setValidationResults((prev) => ({ ...prev, [sectionId]: result }));
          })
          .catch((err) => {
            setValidationResults((prev) => ({
              ...prev,
              [sectionId]: { valid: false, message: err instanceof Error ? err.message : "Validation failed" },
            }));
          });
      }

      setTimeout(() => {
        setSaveStatus((prev) => (prev === "success" ? "idle" : prev));
      }, 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  // Insert Google section after WooCommerce (index 0)
  const wooSection = SECTIONS[0]; // woocommerce
  const restSections = SECTIONS.slice(1); // everything after woo (google-sheets was removed from SECTIONS)

  return (
    <div className="animate-enter">
      <PageHeader title="Settings" />

      {isLoading ? (
        <SettingsSkeleton />
      ) : fetchError ? (
        <div
          className="p-6"
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <p className="text-sm font-mono" style={{ color: "var(--error)" }}>
            Failed to load settings: {fetchError.message ?? "Unknown error"}
          </p>
        </div>
      ) : (
        <>
          <div className="stagger">
            {/* WooCommerce */}
            <SettingsSection
              section={wooSection}
              values={values}
              sources={sources}
              onChange={handleChange}
              validationResult={validationResults[wooSection.id]}
              onValidationResult={handleValidationResult}
            />

            {/* Google Sheets & Drive — custom section */}
            <GoogleSection
              values={values}
              sources={sources}
              onChange={handleChange}
            />

            {/* All other sections */}
            {restSections.map((section) => (
              <SettingsSection
                key={section.id}
                section={section}
                values={values}
                sources={sources}
                onChange={handleChange}
                validationResult={validationResults[section.id]}
                onValidationResult={handleValidationResult}
              />
            ))}
          </div>

          {/* Save bar */}
          <div
            className="p-4 flex items-center justify-between sticky bottom-0 z-10"
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md)",
              borderTopWidth: "2px",
              borderTopColor: hasChanges ? "var(--text-subtle)" : "var(--border-strong)",
              boxShadow: "0 -4px 12px rgba(0, 0, 0, 0.06)",
            }}
          >
            <div className="flex items-center gap-3">
              {saveStatus === "success" && (
                <span className="flex items-center gap-2 text-xs font-mono animate-enter-fade">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
                  <span style={{ color: "var(--text-muted)" }}>Settings saved</span>
                </span>
              )}
              {saveStatus === "error" && (
                <span className="flex items-center gap-2 text-xs font-mono animate-enter-fade">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "var(--error)" }} />
                  <span style={{ color: "var(--error)" }}>{saveError ?? "Save failed"}</span>
                </span>
              )}
              {hasChanges && saveStatus === "idle" && (
                <span className="text-xs font-mono" style={{ color: "var(--text-subtle)" }}>
                  {dirtyKeys.length} unsaved change{dirtyKeys.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges || saveStatus === "saving"}
              className={hasChanges ? "btn-solid px-6 py-2.5 text-xs uppercase tracking-[0.1em] font-medium" : "px-6 py-2.5 text-xs uppercase tracking-[0.1em] font-medium"}
              style={
                hasChanges
                  ? {
                      opacity: saveStatus === "saving" ? 0.6 : 1,
                      borderRadius: "var(--radius-sm)",
                    }
                  : {
                      background: "var(--bg-hover)",
                      color: "var(--text-disabled)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "default",
                    }
              }
            >
              {saveStatus === "saving" ? "Saving..." : "Save All"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
