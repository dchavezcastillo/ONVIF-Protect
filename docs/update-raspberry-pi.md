# Update the code on the Raspberry Pi

Run these commands on the Pi over SSH. This procedure assumes the existing Git checkout is `/opt/onvif-protect`, owned by your login account, and uses the installed systemd service.

Update from `origin/main` using the commands below; stop if repository access or branch lookup fails.

Keep the existing `/etc/onvif-protect.yaml`, `/etc/onvif-protect.env`, `/usr/local/sbin/onvif-network`, and any ARP settings. No configuration copying, backups, or camera removal are required. The bridge restart briefly interrupts video and event forwarding.

## 1. Check the checkout and runtime

```sh
cd /opt/onvif-protect
/usr/bin/node --version
git status --short
git remote -v
```

Node must be version 22 or later. `git status --short` must be empty before proceeding. If it lists changes, stop and review them; do not use `reset --hard` or discard them. The remote should refer to the ONVIF-Protect repository you installed. Run Git and npm as the checkout owner, not with sudo.

## 2. Download the branch before stopping video

```sh
git fetch origin
git log -1 --oneline origin/main
```

If either command fails, leave the running service alone and resolve the repository access or missing branch first.

## 3. Stop the bridge and update

```sh
sudo systemctl stop onvif-protect.service
git switch main
git pull --ff-only origin main
npm ci --omit=dev --ignore-scripts
```

Run each command only after the preceding command succeeds. `git switch` uses the existing local branch, or creates it from the fetched remote branch when it is not present locally. A non-fast-forward error requires reviewing the branch differences, not forcing an overwrite.

Do not restart the network service or reinstall the service units for this application-only update.

## 4. Validate the existing configuration

```sh
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

Expect `Configuration valid: N cameras` with your camera count. If validation fails, correct the reported configuration error before starting the service. This validates configuration and credential references; it does not verify source authentication or Protect thumbnail creation.

## 5. Start and verify

```sh
sudo systemctl start onvif-protect.service
sudo systemctl status onvif-protect.service --no-pager
sudo journalctl -u onvif-protect.service -n 60 --no-pager
git log -1 --oneline
curl --fail --silent --show-error --max-time 5 \
  http://192.168.1.201:8081/healthz
```

Use your actual virtual IP. Expect an active service and the correct camera in the health response. Confirm video and a new motion event in Protect. Existing adopted cameras retain the identifiers from your unchanged configuration.

If snapshots and their required credentials are configured, test the image endpoint:

```sh
curl --fail --show-error --max-time 15 \
  -o /tmp/camera1-snapshot.jpg http://192.168.1.201:8081/snapshot.png
file /tmp/camera1-snapshot.jpg
```

Check that the image is current and belongs to this camera, then verify a new completed event in Protect. The source image path and any required credentials must be configured for image retrieval to work.
