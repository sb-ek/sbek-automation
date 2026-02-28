#!/bin/bash
# Test all webhook endpoints with sample data
# Usage: ./scripts/test-webhooks.sh [BASE_URL]
#
# Requires WOO_WEBHOOK_SECRET to be set in .env (or as an env variable)
# for HMAC signature generation.

BASE_URL="${1:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if it exists
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/.env" | grep WOO_WEBHOOK_SECRET | xargs)
fi

WEBHOOK_SECRET="${WOO_WEBHOOK_SECRET:-}"

# Function to compute HMAC-SHA256 signature
compute_signature() {
  local payload_file="$1"
  if [ -z "$WEBHOOK_SECRET" ]; then
    echo ""
    return
  fi
  cat "$payload_file" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary | base64
}

echo "=== SBEK Automation — Webhook Tests ==="
echo "Base URL: $BASE_URL"
if [ -z "$WEBHOOK_SECRET" ]; then
  echo "WARNING: WOO_WEBHOOK_SECRET not set — webhook tests will fail auth"
fi
echo ""

# 1. Health check
echo "--- Health Check ---"
curl -s "$BASE_URL/health" | python3 -m json.tool 2>/dev/null || curl -s "$BASE_URL/health"
echo ""

# 2. Deep health check
echo "--- Deep Health Check ---"
curl -s "$BASE_URL/health/ready" | python3 -m json.tool 2>/dev/null || curl -s "$BASE_URL/health/ready"
echo ""

# 3. Order webhook (order.created)
echo "--- Order Created Webhook ---"
ORDER_SIG=$(compute_signature "$PROJECT_DIR/test-data/sample_order.json")
curl -s -X POST "$BASE_URL/webhooks/woocommerce/order" \
  -H "Content-Type: application/json" \
  -H "X-WC-Webhook-Topic: order.created" \
  -H "X-WC-Webhook-ID: test-001" \
  -H "X-WC-Webhook-Signature: $ORDER_SIG" \
  -d @"$PROJECT_DIR/test-data/sample_order.json" | python3 -m json.tool 2>/dev/null
echo ""

# 4. Product webhook (product.created)
echo "--- Product Created Webhook ---"
PRODUCT_SIG=$(compute_signature "$PROJECT_DIR/test-data/sample_product.json")
curl -s -X POST "$BASE_URL/webhooks/woocommerce/product" \
  -H "Content-Type: application/json" \
  -H "X-WC-Webhook-Topic: product.created" \
  -H "X-WC-Webhook-ID: test-002" \
  -H "X-WC-Webhook-Signature: $PRODUCT_SIG" \
  -d @"$PROJECT_DIR/test-data/sample_product.json" | python3 -m json.tool 2>/dev/null
echo ""

# 5. Job queue status (requires admin auth)
echo "--- Queue Status ---"
ADMIN_USER="${ADMIN_USERNAME:-admin}"
ADMIN_PASS="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASS" ]; then
  if [ -f "$PROJECT_DIR/.env" ]; then
    export $(grep -v '^#' "$PROJECT_DIR/.env" | grep -E 'ADMIN_(USERNAME|PASSWORD)' | xargs)
    ADMIN_USER="${ADMIN_USERNAME:-admin}"
    ADMIN_PASS="${ADMIN_PASSWORD:-}"
  fi
fi
if [ -n "$ADMIN_PASS" ]; then
  curl -s -u "$ADMIN_USER:$ADMIN_PASS" "$BASE_URL/jobs/status" | python3 -m json.tool 2>/dev/null || curl -s "$BASE_URL/jobs/status"
else
  echo "WARNING: ADMIN_PASSWORD not set — skipping authenticated jobs/status test"
  curl -s "$BASE_URL/jobs/status"
fi
echo ""

echo "=== Tests complete ==="
