#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env.production ]; then echo "Crie .env.production a partir de .env.production.example"; exit 1; fi
exec node --env-file=.env.production server.js
