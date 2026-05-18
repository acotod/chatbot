#!/bin/bash
SECRET="4fb2ae0165b7b5ebca9d78a4462db07a"
PAYLOAD='{"action":"ping"}'

# Function to generate signature and perform curl
test_endpoint() {
  local label=$1
  local url=$2
  
  # Calculate HMAC-SHA256 signature
  # OpenSSL outputs (stdin)= <hash>, we take the last part
  local sig=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.* //')
  
  echo "--- Testing $label: $url ---"
  curl -sS -i -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Hub-Signature-256: sha256=$sig" \
    -d "$PAYLOAD" | head -n 15
  echo -e "\n"
}

echo "1) Local HEAD:"
git rev-parse --short HEAD

echo "2) Remote status & source:"
expect -c '
spawn ssh -o StrictHostKeyChecking=no -p 51576 root@144.91.114.49
expect "password:"
send "FacturaPMC2026\r"
expect "root@*"
send "cd /opt/chatbot && echo \"Remote HEAD: \$(git rev-parse --short HEAD)\"\r"
expect "root@*"
send "docker compose exec -T api sh -c \"grep -nE '\''resolveMetaAppSecrets|verifyMetaSignature|signature mismatch'\'' src/routes/whatsapp.js | head -n 20\"\r"
expect "root@*"
send "docker compose exec -T api sh -c \"sed -n '\''70,210p'\'' src/routes/whatsapp.js\"\r"
expect "root@*"
send "exit\r"
expect eof
' | grep -v "password:"

echo "3) Public Domain Tests:"
test_endpoint "Public Flows" "https://api.pmc-dev.com/whatsapp/flows"
test_endpoint "Public WA" "https://api.pmc-dev.com/whatsapp"
test_endpoint "Public Webhook" "https://api.pmc-dev.com/webhook?key=diag-test"

echo "4 & 5) Remote Local Tests & Logs:"
expect -c '
spawn ssh -o StrictHostKeyChecking=no -p 51576 root@144.91.114.49
expect "password:"
send "FacturaPMC2026\r"
expect "root@*"
send "cat > /tmp/remote_test.sh << '\''INNER'\''
SECRET=\"4fb2ae0165b7b5ebca9d78a4462db07a\"
PAYLOAD='\''{\"action\":\"ping\"}'\''
sig=\$(echo -n \"\$PAYLOAD\" | openssl dgst -sha256 -hmac \"\$SECRET\" | sed '\''s/.* //\\'')
for path in \"/whatsapp/flows\" \"/whatsapp\" \"/webhook?key=diag-test\"; do
  echo \"--- Localhost: \$path ---\"
  curl -sS -i -X POST \"http://127.0.0.1:3200\$path\" -H \"Content-Type: application/json\" -H \"X-Hub-Signature-256: sha256=\$sig\" -d \"\$PAYLOAD\" | head -n 10
  echo
done
INNER
bash /tmp/remote_test.sh\r"
expect "root@*"
send "cd /opt/chatbot && docker compose logs --since=10m api | grep -Ei '\''signature|mismatch|flows|webhook|x-hub'\'' | tail -n 50\r"
expect "root@*"
send "exit\r"
expect eof
' | grep -v "password:"
