#!/bin/bash
SECRET="4fb2ae0165b7b5ebca9d78a4462db07a"
PAYLOAD='{"action":"ping"}'
WEBHOOK_KEY="2f5f6b72-c3bd-49a7-a058-6cfd3bd74f08"

# 1) Calculate Signature Locally
SIG_HEX=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
SIG_HEADER="sha256=$SIG_HEX"

echo "--- LOCAL DIAGNOSTIC ---"
echo "HEAD: $(git rev-parse --short HEAD)"
echo "SIG: $SIG_HEADER"
echo ""

# 2) Test Public Endpoints
echo "--- PUBLIC ENDPOINT TESTS ---"
for URL in "https://api.pmc-dev.com/whatsapp/flows" "https://api.pmc-dev.com/whatsapp" "https://api.pmc-dev.com/webhook?key=$WEBHOOK_KEY"; do
    echo "Testing $URL..."
    RESP=$(curl -sS -i -X POST "$URL" -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG_HEADER" -d "$PAYLOAD")
    echo "$RESP" | head -n 1
    echo "$RESP" | sed -n '/^{/p' | head -n 1
    echo ""
done

# 3) Remote Diagnostic using expect to handle password
# We use braces {} for the send strings in expect to prevent it from trying to interpolate $ variables as Tcl variables.
echo "--- REMOTE DIAGNOSTIC ---"
expect -c "
set timeout 60
spawn ssh -o StrictHostKeyChecking=no -p 51576 root@144.91.114.49
expect \"password:\"
send \"FacturaPMC2026\\r\"
expect \"root@*\"
send {cd /opt/chatbot}
send \"\\r\"
expect \"root@*\"
send {echo \"REMOTE HEAD: \$(git rev-parse --short HEAD)\"}
send \"\\r\"
expect \"root@*\"

send {echo --- REMOTE LOCALHOST TESTS ---}
send \"\\r\"
expect \"root@*\"

# Flows
send {curl -sS -i -X POST http://127.0.0.1:3200/whatsapp/flows -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: }
send \"$SIG_HEADER\"
send { ' -d '}
send {'$PAYLOAD'}
send { ' | head -n 1}
send \"\\r\"
expect \"root@*\"
send {curl -sS -X POST http://127.0.0.1:3200/whatsapp/flows -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: }
send \"$SIG_HEADER\"
send { ' -d '}
send {'$PAYLOAD'}
send { ' | sed -n '/^{/p'}
send \"\\r\"
expect \"root@*\"

# WhatsApp
send {curl -sS -i -X POST http://127.0.0.1:3200/whatsapp -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: }
send \"$SIG_HEADER\"
send { ' -d '}
send {'$PAYLOAD'}
send { ' | head -n 1}
send \"\\r\"
expect \"root@*\"

# Webhook
send {curl -sS -i -X POST 'http://127.0.0.1:3200/webhook?key=}
send \"$WEBHOOK_KEY\"
send {' -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: }
send \"$SIG_HEADER\"
send { ' -d '}
send {'$PAYLOAD'}
send { ' | head -n 1}
send \"\\r\"
expect \"root@*\"
send {curl -sS -X POST 'http://127.0.0.1:3200/webhook?key=}
send \"$WEBHOOK_KEY\"
send {' -H 'Content-Type: application/json' -H 'X-Hub-Signature-256: }
send \"$SIG_HEADER\"
send { ' -d '}
send {'$PAYLOAD'}
send { ' | sed -n '/^{/p'}
send \"\\r\"
expect \"root@*\"

send {echo --- RECENT LOGS (5m) ---}
send \"\\r\"
expect \"root@*\"
send {docker compose logs --since=5m api | grep -Ei 'signature|mismatch|invalid webhook|WF_SIG|x-hub|flows webhook|whatsapp webhook' || true}
send \"\\r\"
expect \"root@*\"

send {exit}
send \"\\r\"
expect eof
" | grep -v "password:"
