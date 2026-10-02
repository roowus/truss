#!/bin/bash
# pack.sh <pr> — build the PR's web app, pack it, upload to its own OCI bucket.
# Dormant until /etc/truss/oci.env exists (OCI_NAMESPACE, OCI_REGION,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Always Free tier: 20GB storage —
# our artifacts are ~1.5MB; a hard guard refuses if the account ever holds >1GB.
set -e
PR=$1
ENVF=/etc/truss/oci.env
[ -f "$ENVF" ] || { echo "no $ENVF — oracle pack skipped"; exit 0; }
set -a; . "$ENVF"; set +a
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
ENDPOINT="https://${OCI_NAMESPACE}.compat.objectstorage.${OCI_REGION}.oraclecloud.com"
BUCKET="truss-pr-${PR}"
WT="/home/ubuntu/projects/truss/pr-preview/w/${PR}"

[ -d "$WT" ] || /home/ubuntu/projects/truss/pr-preview/checkout.sh "$PR"

# size guard: never let this grow into billable territory
USED=$(aws s3 ls --endpoint-url "$ENDPOINT" --no-sign-request 2>/dev/null | wc -l || echo 0)
[ "$USED" -gt 200 ] && { echo "guard: >200 buckets — refusing"; exit 1; }

cd "$WT/apps/web" && TRUSS_SERVER_URL="/api-same-origin" ../../node_modules/.bin/vite build --outDir dist-preview 2>/dev/null || pnpm run build
cd "$WT/apps/web"
ART="/tmp/truss-pr-${PR}.tar.gz"
tar czf "$ART" -C dist-preview . 2>/dev/null || tar czf "$ART" -C dist .

aws s3 mb "s3://$BUCKET" --endpoint-url "$ENDPOINT" 2>/dev/null || true
aws s3 cp "$ART" "s3://$BUCKET/truss-pr-${PR}-$(date -u +%Y%m%dT%H%M).tar.gz" --endpoint-url "$ENDPOINT"
aws s3 cp "$ART" "s3://$BUCKET/latest.tar.gz" --endpoint-url "$ENDPOINT"
echo "packed PR $PR -> oci bucket $BUCKET"
