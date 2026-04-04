#!/usr/bin/env bash
set -euo pipefail

NODE_ENV="${NODE_ENV:-development}"
if [[ "$NODE_ENV" == "production" ]]; then
  npm run start
else
  npm run dev
fi
