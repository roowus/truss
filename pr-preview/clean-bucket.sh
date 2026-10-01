#!/bin/bash
# clean-bucket.sh <pr> — merged PR: delete its OCI bucket. Dormant w/o creds.
set -e
PR=$1
ENVF=/etc/truss/oci.env
[ -f "$ENVF" ] || exit 0
set -a; . "$ENVF"; set +a
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
ENDPOINT="https://${OCI_NAMESPACE}.compat.objectstorage.${OCI_REGION}.oraclecloud.com"
aws s3 rb "s3://truss-pr-${PR}" --force --endpoint-url "$ENDPOINT" && echo "bucket truss-pr-${PR} deleted"
