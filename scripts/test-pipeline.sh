#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# SBEK Pipeline Test Script
# Tests both Order and Product webhook pipelines on any hosted URL.
#
# Usage:
#   ./scripts/test-pipeline.sh <BASE_URL> <WEBHOOK_SECRET>
#
# Examples:
#   ./scripts/test-pipeline.sh https://your-app.up.railway.app your_webhook_secret_here
#   ./scripts/test-pipeline.sh http://localhost:3000 your_webhook_secret_here
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────
BASE_URL="${1:-}"
SECRET="${2:-}"

if [[ -z "$BASE_URL" || -z "$SECRET" ]]; then
  echo ""
  echo "Usage: ./scripts/test-pipeline.sh <BASE_URL> <WEBHOOK_SECRET>"
  echo ""
  echo "  BASE_URL       Your backend URL (e.g. https://your-app.up.railway.app)"
  echo "  WEBHOOK_SECRET Your WOO_WEBHOOK_SECRET from .env"
  echo ""
  exit 1
fi

# Remove trailing slash
BASE_URL="${BASE_URL%/}"

echo ""
echo "=========================================="
echo "  SBEK Pipeline Test"
echo "=========================================="
echo "  URL:    $BASE_URL"
echo "  Secret: ${SECRET:0:4}****"
echo "=========================================="
echo ""

# ── Helper: compute HMAC-SHA256 signature ────────────────────────────
compute_sig() {
  echo -n "$1" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64
}

# ── Helper: send webhook ─────────────────────────────────────────────
send_webhook() {
  local endpoint="$1"
  local topic="$2"
  local payload="$3"
  local label="$4"

  local sig
  sig=$(compute_sig "$payload")

  echo "── $label ──"
  echo "   Endpoint: $BASE_URL$endpoint"
  echo "   Topic:    $topic"
  echo "   Signature: ${sig:0:20}..."
  echo ""

  local response
  local http_code

  response=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL$endpoint" \
    -H "Content-Type: application/json" \
    -H "X-WC-Webhook-Topic: $topic" \
    -H "X-WC-Webhook-ID: test-$(date +%s)" \
    -H "X-WC-Webhook-Signature: $sig" \
    -d "$payload" 2>&1)

  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "200" ]]; then
    echo "   Status: $http_code OK"
  else
    echo "   Status: $http_code FAIL"
  fi
  echo "   Response: $body"
  echo ""
}

# ──────────────────────────────────────────────────────────────────────
# TEST 1: Health Check
# ──────────────────────────────────────────────────────────────────────
echo "== TEST 0: Health Check =="
echo ""
HEALTH=$(curl -s -w "\n%{http_code}" "$BASE_URL/health" 2>&1)
HEALTH_CODE=$(echo "$HEALTH" | tail -1)
HEALTH_BODY=$(echo "$HEALTH" | sed '$d')
echo "   Status: $HEALTH_CODE"
echo "   Response: $HEALTH_BODY"
echo ""

if [[ "$HEALTH_CODE" != "200" ]]; then
  echo "   FAILED: Backend is not reachable at $BASE_URL"
  echo "   Check your URL and try again."
  exit 1
fi
echo "   Backend is UP!"
echo ""

# ──────────────────────────────────────────────────────────────────────
# TEST 2: New Order (order.created)
# ──────────────────────────────────────────────────────────────────────

ORDER_PAYLOAD='{
  "id": 99901,
  "status": "processing",
  "currency": "INR",
  "date_created": "2026-03-03T10:30:00",
  "total": "45000.00",
  "customer_id": 42,
  "customer_note": "Please engrave Forever in cursive",
  "payment_method": "razorpay",
  "payment_method_title": "Razorpay",
  "billing": {
    "first_name": "Test",
    "last_name": "Customer",
    "email": "test@example.com",
    "phone": "9876543210",
    "address_1": "123 MG Road",
    "city": "Mumbai",
    "state": "Maharashtra",
    "postcode": "400001",
    "country": "IN"
  },
  "shipping": {
    "first_name": "Test",
    "last_name": "Customer",
    "address_1": "123 MG Road",
    "city": "Mumbai",
    "state": "Maharashtra",
    "postcode": "400001",
    "country": "IN"
  },
  "line_items": [
    {
      "id": 101,
      "name": "Celestial Gold Ring",
      "product_id": 501,
      "variation_id": 0,
      "quantity": 1,
      "total": "45000.00",
      "sku": "SBEK-TEST-001",
      "meta_data": [
        { "id": 1, "key": "pa_ring-size", "value": "7" },
        { "id": 2, "key": "pa_metal-type", "value": "18K Yellow Gold" },
        { "id": 3, "key": "pa_stone-type", "value": "Diamond" },
        { "id": 4, "key": "_engraving_text", "value": "Forever" }
      ],
      "image": {
        "id": 201,
        "src": "https://sb-ek.com/wp-content/uploads/celestial-ring.jpg"
      }
    }
  ],
  "meta_data": []
}'

echo "== TEST 1: New Order (order.created) =="
echo "   This will:"
echo "     - Add order to Google Sheets (Orders tab)"
echo "     - Add/update customer in Google Sheets (Customers tab)"
echo "     - Send order confirmation email"
echo "     - Send order confirmation WhatsApp (if configured)"
echo ""
send_webhook "/webhooks/woocommerce/order" "order.created" "$ORDER_PAYLOAD" "Order #99901 — Celestial Gold Ring — INR 45,000"

# ──────────────────────────────────────────────────────────────────────
# TEST 3: Order Updated (order.updated)
# ──────────────────────────────────────────────────────────────────────

ORDER_UPDATE_PAYLOAD='{
  "id": 99901,
  "status": "completed",
  "currency": "INR",
  "date_created": "2026-03-03T10:30:00",
  "total": "45000.00",
  "customer_id": 42,
  "billing": {
    "first_name": "Test",
    "last_name": "Customer",
    "email": "test@example.com",
    "phone": "9876543210"
  },
  "line_items": [
    {
      "id": 101,
      "name": "Celestial Gold Ring",
      "product_id": 501,
      "quantity": 1,
      "total": "45000.00",
      "sku": "SBEK-TEST-001",
      "meta_data": []
    }
  ],
  "meta_data": []
}'

echo "== TEST 2: Order Updated (order.updated → completed) =="
echo "   This will:"
echo "     - Update order status in Google Sheets to 'Delivered'"
echo ""
send_webhook "/webhooks/woocommerce/order" "order.updated" "$ORDER_UPDATE_PAYLOAD" "Order #99901 — Status → completed"

# ──────────────────────────────────────────────────────────────────────
# TEST 4: New Product (product.created)
# ──────────────────────────────────────────────────────────────────────

PRODUCT_PAYLOAD='{
  "id": 99801,
  "name": "Royal Diamond Necklace",
  "slug": "royal-diamond-necklace",
  "type": "simple",
  "status": "publish",
  "description": "<p>A breathtaking Royal Diamond Necklace handcrafted in 22K gold with VS1 clarity diamonds. This exquisite piece features a cascading design with 24 brilliant-cut diamonds set in a traditional Indian motif. Perfect for weddings, anniversaries, and special occasions. Each piece is individually crafted by master artisans with over 30 years of experience.</p>",
  "short_description": "Handcrafted 22K gold necklace with 24 VS1 brilliant-cut diamonds in traditional Indian cascading design. Perfect for weddings and special occasions.",
  "sku": "SBEK-TEST-NK-001",
  "price": "185000",
  "regular_price": "185000",
  "sale_price": "",
  "categories": [
    { "id": 15, "name": "Necklaces", "slug": "necklaces" },
    { "id": 20, "name": "Diamond", "slug": "diamond" },
    { "id": 25, "name": "Wedding", "slug": "wedding" }
  ],
  "images": [
    {
      "id": 301,
      "src": "https://sb-ek.com/wp-content/uploads/royal-diamond-necklace.jpg",
      "name": "Royal Diamond Necklace",
      "alt": "SBEK Royal Diamond Necklace 22K Gold"
    }
  ],
  "attributes": [
    {
      "id": 1,
      "name": "Metal",
      "slug": "pa_metal",
      "visible": true,
      "options": ["22K Yellow Gold"]
    },
    {
      "id": 2,
      "name": "Stone",
      "slug": "pa_stone",
      "visible": true,
      "options": ["VS1 Diamond"]
    }
  ],
  "meta_data": [
    { "id": 100, "key": "_estimated_production_days", "value": "21" }
  ]
}'

echo "== TEST 3: New Product (product.created) =="
echo "   This will trigger 7 jobs in parallel:"
echo "     1. SEO Meta (title + description for Yoast)"
echo "     2. FAQ generation (JSON-LD structured data)"
echo "     3. AEO Knowledge Base article"
echo "     4. Comparison article vs competitors"
echo "     5. Schema injection (Product JSON-LD)"
echo "     6. Internal linking"
echo "     7. Creative generation (5 image variants):"
echo "        - White background studio shot"
echo "        - Lifestyle (woman wearing jewelry)"
echo "        - Festive (Diwali themed)"
echo "        - Minimal text overlay"
echo "        - Story format (9:16 vertical)"
echo ""
send_webhook "/webhooks/woocommerce/product" "product.created" "$PRODUCT_PAYLOAD" "Product #99801 — Royal Diamond Necklace — INR 1,85,000"

# ──────────────────────────────────────────────────────────────────────
# TEST 5: Check Queue Status
# ──────────────────────────────────────────────────────────────────────

echo "== TEST 4: Queue Status =="
echo ""
STATS=$(curl -s "$BASE_URL/dashboard/stats" 2>&1)
echo "   Queue Stats: $STATS" | head -5
echo ""

echo "=========================================="
echo "  ALL TESTS SENT!"
echo "=========================================="
echo ""
echo "  What to check now:"
echo ""
echo "  1. GOOGLE SHEETS — Open your sheet and check:"
echo "     - Orders tab: new row for order #99901"
echo "     - Customers tab: 'Test Customer' entry"
echo ""
echo "  2. EMAIL — Check test@example.com inbox for:"
echo "     - Order confirmation email"
echo "     (Note: test@example.com won't receive it — check your SMTP logs)"
echo ""
echo "  3. DASHBOARD — Go to your dashboard:"
echo "     - Queues page: check order-sync, notification, content-generation, creative-generation"
echo "     - Activity page: webhook events should appear"
echo ""
echo "  4. CONTENT PIPELINE (takes 2-5 min) — After product webhook:"
echo "     - SEO meta generated and pushed to WooCommerce"
echo "     - FAQ JSON-LD created"
echo "     - Knowledge base page published"
echo "     - Comparison article published"
echo "     - Schema markup injected"
echo ""
echo "  5. CREATIVES (takes 5-10 min) — After product webhook:"
echo "     - 5 image variants generated"
echo "     - Uploaded to Google Drive folder"
echo "     - Logged in Creatives tab of Google Sheet"
echo ""
echo "  TIP: Watch the dashboard Queues page to see jobs processing in real-time."
echo ""
