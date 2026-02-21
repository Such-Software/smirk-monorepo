#!/bin/bash
# Publish remaining wownero-* crates in dependency order with rate-limit retry
set -e

CRATES=(
  # Level 2 (remaining)
  wownero-clsag
  wownero-borromean
  wownero-bulletproofs-generators
  wownero-address
  # Level 3
  wownero-bulletproofs
  wownero-oxide
  # Level 4
  wownero-interface
  wownero-daemon-rpc
  # Level 5
  wownero-simple-request-rpc
  wownero-wallet
)

for crate in "${CRATES[@]}"; do
  echo ""
  echo "=== Publishing $crate ==="
  while true; do
    output=$(cargo publish -p "$crate" --allow-dirty 2>&1) && {
      echo "$output" | tail -1
      echo "  OK: $crate published"
      break
    }
    if echo "$output" | grep -q "429 Too Many Requests"; then
      # Extract the retry-after time from the error message
      retry_after=$(echo "$output" | grep -oP 'after \K[^o]+' | head -1 | xargs)
      echo "  Rate limited. Retry after: $retry_after"
      # Parse the GMT time and calculate seconds to wait
      target=$(date -d "$retry_after" +%s 2>/dev/null || echo "0")
      now=$(date +%s)
      wait_secs=$(( target - now + 5 ))  # +5 second buffer
      if [ "$wait_secs" -lt 10 ]; then
        wait_secs=65
      fi
      echo "  Waiting ${wait_secs}s..."
      sleep "$wait_secs"
    else
      echo "  ERROR: unexpected failure"
      echo "$output"
      exit 1
    fi
  done
done

echo ""
echo "=== All crates published! ==="
