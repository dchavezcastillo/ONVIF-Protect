#!/usr/bin/env python3
"""Vendor official schema imports for offline startup. Run only to refresh schemas."""
from pathlib import Path
import re
import subprocess
import urllib.parse
import hashlib
import json
ROOT = Path(__file__).resolve().parent.parent / 'wsdl'
DEST = ROOT / 'vendor'
DEST.mkdir(exist_ok=True)
seen = {}

def fetch(url):
    url = url.replace('http://', 'https://', 1)
    if url in seen:
        return seen[url]
    name = hashlib.sha256(url.encode()).hexdigest()[:12] + '-' + url.rsplit('/', 1)[-1]
    seen[url] = name
    print(url, flush=True)
    text = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '40', url]).decode('utf-8-sig')
    def replace(m):
        target = urllib.parse.urljoin(url, m[2])
        return m[1] + fetch(target) + m[3]
    text = re.sub(r'((?:schemaLocation|location)\s*=\s*["\'])([^"\']+)(["\'])', replace, text)
    (DEST / name).write_text(text)
    return name

for filename, url in [('device_service.wsdl','https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl'), ('media_service.wsdl','https://www.onvif.org/ver10/media/wsdl/media.wsdl')]:
    name = fetch(url)
    path = ROOT / filename
    text = path.read_text(encoding='utf-8-sig')
    text = re.sub(r'(<wsdl:import\b[^>]*location=")[^"]+', r'\g<1>vendor/' + name, text)
    path.write_text(text)
(ROOT / 'sources.json').write_text(json.dumps(seen, indent=2)+'\n')
