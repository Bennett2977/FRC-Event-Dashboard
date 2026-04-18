#!/bin/sh
set -e
echo "window.TBA_API_KEY = \"${TBA_API_KEY}\";" > /usr/share/nginx/html/config.js
exec nginx -g 'daemon off;'
