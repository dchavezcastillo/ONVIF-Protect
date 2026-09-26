# Restore thumbnails without removing adopted cameras

This correction is for clients that cached `/snapshot.png` before real snapshots were configured. Protect can retain that old URL even when `GetSnapshotUri` now advertises the correct source image.

The updated bridge serves a fresh source image at the old URL whenever the camera has a snapshot path. It sends the actual image type (`image/jpeg` or `image/png`) even though the legacy URL ends in `.png`. IPs, MACs, UUIDs, ONVIF profiles, subscriptions, and Protect camera records are not changed. Existing missing thumbnails are not guaranteed to regenerate; verify a new event.

## 1. Install the corrected project files on the Pi

This is a code update, not just a YAML change. The Pi must have the updated versions of:

- `src/snapshot.js` (new)
- `src/config.js`
- `src/onvif-server.js`
- `src/onvif/http.js`

Use your normal project deployment method to install all four files together under `/opt/onvif-protect`. Updating your local computer's checkout does not update the Pi. No new npm dependencies are required. Do not remove/re-adopt cameras or change their identities.

## 2. Verify the source image and edit the configuration

Before editing, test the source directly using the actual channel's snapshot path. Enter the correct source password at the prompt:

```sh
curl --digest --user YOUR_USERNAME --fail --show-error --max-time 15 \
  -o /tmp/source-snapshot.jpg http://192.168.1.25/actual/snapshot/path
file /tmp/source-snapshot.jpg
```

Expect JPEG or PNG image data. A final 401 means the account/authentication still needs fixing. Do not diagnose a bridge failure using an incorrect password.

On the Pi:

```sh
sudo nano /etc/onvif-protect.yaml
```

For each camera, keep its existing name, UUID, MAC, motion, and real video parameters. Add the snapshot path, both snapshot ports, and `snapshotAuth`. The following fields belong to the same camera entry, alongside `name` and `motion`:

```yaml
    ports:
      server: 8081
      rtsp: 8554
      snapshot: 8580
    highQuality:
      rtsp: "/actual/stream/path"
      snapshot: "/actual/snapshot/path"
      width: 1920
      height: 1080
      framerate: 15
      bitrate: 2048
      quality: 4
    target:
      hostname: 192.168.1.25
      ports:
        rtsp: 554
        snapshot: 80
    snapshotAuth:
      usernameEnv: EVENT_USERNAME
      passwordEnv: EVENT_PASSWORD
```

Use the snapshot endpoint verified for that source/channel; do not infer arbitrary device paths. Modify the existing `ports`, `highQuality`, and `target` blocks rather than duplicating their YAML keys. For devices exposing `/ISAPI/Streaming/channels/101/picture`, that is a possible channel-1 snapshot path, but it must be tested on the source.

`snapshotAuth` is explicitly configured because event credentials and snapshot credentials can differ. If your environment file already contains `HIKVISION_USER` and `HIKVISION_PASSWORD` and that account can fetch the JPEG, reuse those variable names instead of `EVENT_USERNAME` and `EVENT_PASSWORD`. Nothing is reused automatically. A separate account can be configured with other environment-variable names.

The compatibility route performs HTTP Digest authentication itself using these credentials and the source snapshot path. Client Authorization and Cookie headers are not forwarded. The existing TCP snapshot proxy on port 8580 still uses the requesting client's source credentials.

**Access:** `/snapshot.png` remains an unauthenticated LAN endpoint, but now returns a real image using the configured account. Limit the ONVIF port to your trusted network/Protect. Do not expose it to the Internet. Event, video, and snapshot passwords are not returned to clients or logged.

For an anonymous snapshot source, omit `snapshotAuth`. Without any snapshot path, `/snapshot.png` retains the original static fallback. An unreachable or unauthorized configured source returns an error instead of silently returning the placeholder.

If the referenced variables are not already present, edit the environment file:

```sh
sudo nano /etc/onvif-protect.env
```

Add or update the values, preserving any existing event credentials:

```dotenv
EVENT_USERNAME='YOUR_USERNAME'
EVENT_PASSWORD='YOUR_PASSWORD'
```

Use these names only if they match `snapshotAuth` and this account can retrieve the source image. If using a separate snapshot account, choose separate variable names in both files. Use `NAME=value` without `export`.

```sh
sudo chown root:root /etc/onvif-protect.env
sudo chmod 600 /etc/onvif-protect.env
sudo chown root:onvif /etc/onvif-protect.yaml
sudo chmod 640 /etc/onvif-protect.yaml
```

## 3. Validate and restart

Save in nano with Ctrl+O, Enter, then Ctrl+X. Validate using the environment file:

```sh
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

If validation succeeds:

```sh
sudo systemctl restart onvif-protect.service
sudo journalctl -u onvif-protect.service -n 40 --no-pager
```

The restart briefly interrupts bridge video. It does not modify Protect's camera records. No network-script changes or Protect restart are needed for the old URL to use this handler.

## 4. Test the exact URL Protect already knows

For the first virtual camera:

```sh
curl --fail --show-error --max-time 15 \
  -o /tmp/camera1-legacy-snapshot.jpg \
  http://192.168.1.201:8081/snapshot.png
file /tmp/camera1-legacy-snapshot.jpg
```

For a JPEG source, expect `JPEG image data`, despite the `.png` URL. No `--user` is needed on this compatibility route: the bridge authenticates upstream. View the saved image and confirm it is current and belongs to the correct camera. Also test from a machine that can reach the Pi over the LAN.

If the old URL still returns the original PNG, check that the corrected code is installed, the camera has a snapshot path in `/etc/onvif-protect.yaml`, and the service was restarted.

If you receive an error, inspect:

```sh
sudo journalctl -u onvif-protect.service -n 60 --no-pager
```

- `502`: upstream connection/authentication/status or image-format/size failure. A logged `source HTTP 401` means the configured snapshot credentials were not accepted (or were omitted).
- `504`: the entire source operation exceeded 10 seconds.
- `503`: the camera already has four active snapshot requests, or the handler is shutting down; retry later.

Only JPEG/PNG responses with matching file signatures are accepted, with an 8 MiB limit. Redirects are not followed. Requests are cancelled when clients disconnect or the camera closes. The HTTP source host, port, and path come only from the camera configuration.

## 5. Verify a new event

Trigger motion on this camera, wait for the event to finish, and check its thumbnail in Protect. The correction makes the already stored snapshot URL return the current source image; it still requires validation with your Protect installation. Repeat for other cameras using their individual snapshot paths and virtual IPs.

If a new event still returns 404, capture the new Protect error at that time. Do not use an old event as proof of failure: a previously saved `thumbnailId: null` may remain unchanged.

If images work from the Pi but not from another LAN client, follow [network troubleshooting](network-troubleshooting.md). A capture limited to port 8580 will not see requests to the cached `/snapshot.png` route on port 8081. Successful image downloads from your computer still require testing a new event in Protect to verify its own access and thumbnail creation.
