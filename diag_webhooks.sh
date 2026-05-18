#!/bin/bash

# Configuration
SECRET="4fb2ae0165b7b5ebca9d78a4462db07a"
PAYLOAD='{"action":"ping"}'
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

redact() {
  local val="$1"
  if [ -z "$val" ]; then echo "<unset>"; return; fi
  if [ ${#val} -le 8 ]; then echo "****"; return; fi
  echo "${val:0:4}...${val: -4}"
}

echo "--- LOCAL ENV VARS (REDACTED) ---"
docker compose exec -T api sh -c 'echo "WA_APP_SECRET=$(echo $WA_APP_SECRET)" && echo "FACEBOOK_APP_SECRET=$(echo $FACEBOOK_APP_SECRET)"' | while read line; do
  key=$(echo $line | cut -d= -f1)
  val=$(echo $line | cut -d= -f2)
  echo "$key=$(redact $val)"
done

endpoints=(
  "https://api.pmc-dev.com/whatsapp"
  "https://api.pmc-dev.com/whatsapp/flows"
  "https://api.pmc-dev.com/webhook?key=9fe4454ce4cd0f5f5034b92f7200db066ab753723cc7b916343a222d1557a03c"
)

echo ""
echo "--- LOCAL TESTS AGAINST REMOTE API ---"
for url in "${endpoints[@]}"; do
  echo "Testing: $url"
  res=$(curl -sS -i -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Hub-Signature-256: $SIGNATURE" \
    -d "$PAYLOAD")
  echo "Status: $(echo "$res" | head -n 1)"
  echo "Body: $(echo "$res" | sed -n '/^\r\{0,1\}$/,$p' | sed '1d' | head -c 200)"
  echo "-----------------------------------"
done
