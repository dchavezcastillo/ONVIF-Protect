# ONVIF Protect — Universal RTSP to ONVIF Bridge

Use compatible RTSP/TCP streams from DVRs, NVRs, or cameras of any brand as virtual ONVIF devices in UniFi Protect or other compatible clients. The source device does not need to support ONVIF when configured manually. Motion forwarding is an **optional event integration**, separate from video streaming.

Designed for Raspberry Pi with Ethernet, 64-bit Raspberry Pi OS, and Node.js 22 or later. Docker configuration is also included for Linux ARM64/AMD64. This bridge does not transcode or analyze video: motion detection happens on the source device.

**Installing on Raspberry Pi OS Lite?** Follow the [complete installation and motion setup guide](docs/raspberry-pi-setup.md). It covers Node.js installation, one virtual camera, persistent networking, systemd, source-side motion settings, event credentials, Protect adoption, troubleshooting, and reboot verification. Camera examples are manufacturer-independent; motion still requires the supported XML/Digest event protocol.

```text
DVR / NVR / camera ── RTSP / snapshot ── TCP proxies ── virtual cameras ── Protect
Optional events ── compatible event stream (one connection per source/DVR)
                  └── configured channel ── ONVIF Motion ── Protect PullMessages
```

## Brand-independent compatibility

- **Video:** configure the host, port, and RTSP path without manufacturer-specific path parsing. Each virtual camera can use a different DVR/NVR. The bridge provides ONVIF even if the source only provides RTSP. The video codec must be supported by Protect, and RTSP/TCP is required.
- **Profiles and snapshots:** `highQuality` is required; `lowQuality` and snapshots are optional. `--create-config` requires ONVIF on the source to retrieve profiles. For RTSP-only sources, configure YAML manually.
- **Motion:** RTSP alone does not guarantee motion notifications. A compatible event source is required. The included event adapter reads compatible XML event streams over HTTP(S) with Digest authentication. Universal event-protocol support and RTSP metadata decoding are not implemented; other protocols need additional adapters.

Start with [config.example.yaml](config.example.yaml) for generic RTSP. Add optional event settings only when your source exposes a compatible event stream. Existing event sources without `type` continue to use the default adapter for backward compatibility. Unknown adapter types are rejected explicitly.

## First installation on Raspberry Pi

For copyable commands and a complete single-camera configuration, use the [step-by-step Raspberry Pi OS Lite guide](docs/raspberry-pi-setup.md). Run all commands on the Pi, locally or over SSH. The steps below are a shorter reference. For an existing installation, jump to [Add or edit cameras](#add-or-edit-cameras-directly-on-the-pi). In nano, save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

1. Copy this project to your Raspberry Pi, for example to `/opt/onvif-protect`. Install Node.js 22 or later and check `node --version`. The supplied systemd unit expects `/usr/bin/node`; adjust `ExecStart` if your executable is elsewhere.
2. Inside the project directory:

   ```sh
   npm ci --omit=dev --ignore-scripts
   ```

3. Open `/etc/onvif-protect.yaml` using `sudo nano /etc/onvif-protect.yaml`. Paste the [complete single-camera example](docs/raspberry-pi-setup.md#3-configure-one-video-stream), then set your source address, real RTSP path, video parameters, and a unique UUID and MAC. For a new installation, run `sudo chown root:root /etc/onvif-protect.yaml` and `sudo chmod 600 /etc/onvif-protect.yaml` after saving. The default example **does not require ONVIF on the source or event credentials**. For optional motion forwarding, configure an event source as described below and create `/etc/onvif-protect.env` with the environment variables referenced by that source. Keep it owned by root with mode `0600`.
4. Create the virtual interfaces described below. Each camera needs **its own local IP and MAC address**, plus a stable UUID. Writing a MAC address in YAML does not create an interface.
5. Validate and start:

   ```sh
   sudo /usr/bin/node main.js --check-config /etc/onvif-protect.yaml
   sudo /usr/bin/node main.js /etc/onvif-protect.yaml
   ```

When loading event credentials from `/etc/onvif-protect.env`, add `--env-file=/etc/onvif-protect.env` after `/usr/bin/node` in both commands. `usernameEnv` and `passwordEnv` reference environment variables; inline `username` and `password` fields are also supported in YAML.

`--check-config` validates configuration structure and available credentials. It does not connect to the DVR, check local interfaces, or certify Protect compatibility. Startup checks address availability and listener conflicts before opening services.

### Persistent virtual networking

Use Ethernet (`eth0` in the example). Macvlan generally does not work over a Wi-Fi client connection. Reserve unused addresses outside the DHCP pool or exclude them from it: **192.168.1.201 and .202 are examples**, not addresses you can assume are available. The DVR, Raspberry Pi, and virtual cameras need different IP addresses.

Create the active network script directly:

```sh
sudo nano /usr/local/sbin/onvif-network
```

Paste the [complete network script](docs/raspberry-pi-setup.md#4-create-persistent-virtual-networking), then set your Ethernet interface, subnet, IP addresses, and MAC addresses. Keep one `add_camera` line per camera, matching `/etc/onvif-protect.yaml`. The script assigns static addresses; it does not request DHCP leases.

Save, then validate its syntax:

```sh
sudo chmod 755 /usr/local/sbin/onvif-network
sudo sh -n /usr/local/sbin/onvif-network
```

If the check prints an error, fix it first. Otherwise install and start the service:

```sh
cd /opt/onvif-protect
sudo install -m 0644 scripts/onvif-network.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-network.service
ip -br address
```

The service recreates interfaces after reboot. After editing the script, run `sudo systemctl restart onvif-network`. It does not remove old interfaces or addresses: when changing an IP/MAC, explicitly clean up the previous interface before recreating it.

Protect must be able to reach the virtual IP addresses and configured ports. Allow UDP 3702 for discovery, TCP 8081/8082 for ONVIF in the examples, TCP 8554 for RTSP, and TCP 8580 when snapshots are configured. The bridge connects to the DVR using ports such as TCP 80/443 and 554, depending on configuration. RTSP/snapshot ports can be reused on different virtual IPs because each proxy binds to its own address.

If cameras disappear from discovery or Protect associates them with different IPs after restarting, follow [network checks and persistent ARP settings](docs/network-troubleshooting.md). Check every virtual IP, then compare its MAC from a machine on the same subnet. An empty ARP entry on a computer reaching the cameras through a router is normal. Do not change adopted camera UUIDs or MACs to troubleshoot this.

The network guide includes a conditional test of `arp_ignore=1` and `arp_announce=2`, persistence in `/etc/sysctl.d/90-onvif-network.conf`, and rollback. Apply these only after checking address ownership; they affect all IPv4 interfaces and are not a confirmed fix for every discovery problem.

### Optional motion event setup

Configure motion detection, zones, sensitivity, and schedules on each source channel. Synchronize time/NTP on the recorder, Raspberry Pi, and Protect. Enable event access for an account with the required permissions.

The event source must match the included adapter's protocol: a persistent HTTP(S) XML stream with Digest authentication and `EventNotificationAlert` documents containing `eventType`, `eventState`, and `channelID` or `dynChannelID`. A device exposing RTSP does not necessarily expose this event protocol.

Add a source to `/etc/onvif-protect.yaml`. Replace the URL placeholder with your device's compatible event endpoint:

```yaml
eventSources:
  - id: recorder-events
    url: http://DVR_IP/EVENT_STREAM_PATH
    usernameEnv: EVENT_USERNAME
    passwordEnv: EVENT_PASSWORD
    idleTimeoutMs: 90000
```

Create `/etc/onvif-protect.env` with `EVENT_USERNAME` and `EVENT_PASSWORD` (root-owned, mode `0600`), then start with `sudo /usr/bin/node --env-file=/etc/onvif-protect.env main.js /etc/onvif-protect.yaml`. The source ID is a local name used to connect virtual cameras to their event source.

Inspect the configured endpoint without writing the password into shell history:

```sh
curl --digest --user YOUR_USERNAME --no-buffer --max-time 60 \
  http://DVR_IP/EVENT_STREAM_PATH
```

`curl` prompts for the password. Trigger motion on one channel and inspect its event type, state, and channel ID. Review identifying information before sharing XML. For HTTP 401/403, check credentials, permissions, and authentication settings. HTTP 404 may indicate an incorrect or unavailable endpoint.

Configure each camera using the exact channel ID and event type reported by its event source. This example uses a source that reports `VMD`:

```yaml
motion:
  source: recorder-events  # Matching eventSources ID
  channel: 1              # Exact event channel ID, not a streaming profile ID
  channelField: channelID # Or dynChannelID when used by the source
  eventTypes: [VMD]
  resetAfterMs: 30000
```

Use H.264 for the first video test and set HQ/LQ to the actual stream parameters. The bridge does not convert H.265 to H.264. Verify stream paths and event IDs independently in your device configuration.

Channel IDs are never inferred from RTSP paths. Without `motion`, the camera provides video without advertising Events. Events from other sources, channels, or event types are ignored. `active` starts motion; `inactive` ends it. Repeated activations refresh the reset timer without duplicating state changes. After 30 seconds without another activation, the bridge sends `false` to prevent motion from remaining active indefinitely when an end event is lost. Adjust this interval for your DVR; `0` disables automatic reset and requires reliable `inactive` events.

## Snapshots and missing thumbnails

Snapshots need their own source path and port; a working RTSP stream or motion event does not prove that image retrieval works. Follow [the snapshot setup and recovery guide](docs/snapshot-compatibility.md), including installing the corrected code on the Pi.

| Setting | Example and purpose |
| --- | --- |
| Camera `ports.snapshot` | `8580`: virtual TCP snapshot proxy |
| `target.ports.snapshot` | `80`: source HTTP image service |
| `highQuality.snapshot` | Verified source image path for this channel |
| Camera `snapshotAuth` | Explicit source credentials for the legacy `/snapshot.png` route |

The source account can be the same as the event account, but its environment-variable names must also be set in `snapshotAuth`. Test the legacy route after validating and restarting the service:

```sh
curl --fail --show-error --max-time 15 \
  -o /tmp/camera1-snapshot.jpg http://192.168.1.201:8081/snapshot.png
file /tmp/camera1-snapshot.jpg
```

Expect a real, current image of this camera. The legacy route uses the configured credentials without asking the client for a password; restrict the ONVIF port to trusted clients. Verify a **new, completed motion event** in Protect. Old events with missing thumbnails may stay unchanged.

## Adoption and acceptance testing in Protect

If events play video but thumbnails return 404, Protect may still have the original `/snapshot.png` URL stored. The bridge now serves the configured source image at that legacy URL, using explicit `snapshotAuth` credentials when required. Follow [Restore thumbnails without removing adopted cameras](docs/snapshot-compatibility.md) to configure and test it without changing camera identities or removing their history.

Enable **Discover Third-Party Cameras**, adopt each virtual camera, and provide the DVR's video credentials. The event account can be different. If multicast discovery does not find the camera, use advanced adoption with its virtual IP and ONVIF port.

Ubiquiti states that third-party motion detection must be configured on the camera and sent to Protect: [official documentation](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect). This bridge does not require Protect administrator credentials.

1. Start with one channel and verify video, plus LQ and snapshots if configured.
2. For motion-enabled cameras, inspect `http://VIRTUAL_IP:8081/healthz`: `source.connected` should be `true`, and `subscriptions` should increase when Protect subscribes.
3. Trigger motion and confirm `motion: true`, followed by `false`, and an event on **that same camera's** Protect timeline.
4. Add another channel and verify that it does not receive the first channel's motion.
5. Restart the DVR and check reconnection. Restart the Raspberry Pi and check interfaces, the service, and persistent adoption.

`/healthz` reports local status; HTTP 200 does not guarantee DVR connectivity or recording in Protect. Logs identify connections and retries by source. `--debug` adds ONVIF operations and motion transitions without logging passwords or authentication headers.

### Verify motion and recover a missing Protect subscription

On the source, enable motion detection, select its region and sensitivity, configure the arming schedule, and enable notification to monitoring clients (often called **Notify Surveillance Center**). Save the settings. Triggering recording on the source alone does not enable event forwarding.

Verify a raw event before troubleshooting Protect: it must contain the expected channel, event type, and `active` state. A compatible stream may also send `videoloss` / `inactive` heartbeats with channel `0`; these are not motion events. Do not infer the event channel from the RTSP stream identifier.

Observe the bridge while triggering movement:

```sh
watch -n 1 'curl --show-error --max-time 2 http://VIRTUAL_IP:8081/healthz'
```

| Health field | Interpretation |
| --- | --- |
| `motion: null` | Events are not enabled for this running camera. |
| `source.connected: true` | Connected to the event source; not proof of movement. |
| `source.lastEvent` | Updated by parsed events, including heartbeats and other channels. |
| `motion: true` | The bridge recognized movement for this camera. |
| `subscriptions: 0` | No active PullPoint subscriptions; Protect is not currently subscribed through this interface. |
| `subscriptions > 0` | An ONVIF client is subscribed; confirm actual events in Protect's timeline. |

If movement reaches the bridge but Protect has no subscription, especially after adding motion to an already adopted camera, verify the saved configuration and restart the Pi. Confirm `onvif-network.service` and `onvif-protect.service` are active after reboot. If needed, restart the Protect application through the console's application management, then check subscriptions and trigger a new motion episode. Restarting Protect temporarily interrupts viewing and recording for its cameras.

Restarting the system and Protect restored motion delivery in a real deployment. This is an observed recovery step, not a guaranteed fix or proof of a specific caching issue. Preserve the camera UUID and MAC. Before removing/re-adopting a camera, collect the Protect version, `/healthz` response, and debug logs; removal can affect its association with existing recordings.

See the [full motion verification, restart, and debug procedure](docs/raspberry-pi-setup.md#11-verify-motion-through-all-three-stages) for commands and expected results.

**Physical validation is still required:** your device's event numbering, event endpoint access, and notification acceptance by your Protect installation. Automated tests use simulated devices and clients; they are not ONVIF certification or hardware validation.

## Automatic startup without Docker

With the project in `/opt/onvif-protect`, create a dedicated user and grant it read access to the existing `/etc/onvif-protect.yaml`. Create the environment file if it does not exist; it can remain empty for video without events:

```sh
sudo useradd --system --user-group --home-dir /opt/onvif-protect --shell /usr/sbin/nologin onvif
sudo chown root:onvif /etc/onvif-protect.yaml
sudo chmod 640 /etc/onvif-protect.yaml
sudo touch /etc/onvif-protect.env
sudo chown root:root /etc/onvif-protect.env
sudo chmod 600 /etc/onvif-protect.env
sudo install -m 0644 scripts/onvif-protect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-protect
journalctl -u onvif-protect -f
```

Skip `useradd` if the account already exists. Project files and dependencies must be readable by `onvif`. The systemd environment file uses `NAME=value`, without `export`; quote values containing spaces according to `EnvironmentFile` syntax. Do not run the manual process and systemd service simultaneously.

Manual runs and the service both read **`/etc/onvif-protect.yaml`**. No second configuration copy is needed. After adding event credentials to `/etc/onvif-protect.env`, validate with those credentials loaded before restarting:

```sh
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

If validation succeeds:

```sh
sudo systemctl restart onvif-protect.service
sudo journalctl -u onvif-protect.service -n 40 --no-pager
```

## Add or edit cameras directly on the Pi

For an existing systemd installation, edit these files directly with nano:

| File | Purpose |
| --- | --- |
| `/etc/onvif-protect.yaml` | Camera streams, snapshots, identities, and motion settings |
| `/usr/local/sbin/onvif-network` | One virtual IP and MAC per camera |
| `/etc/onvif-protect.env` | Event and snapshot credentials referenced by the YAML |

Follow this sequence. No upload, backup, or second configuration file is needed.

1. Stop the bridge; video is temporarily interrupted:

   ```sh
   sudo systemctl stop onvif-protect.service
   ```

2. Edit the cameras and their matching network entries:

   ```sh
   sudo nano /etc/onvif-protect.yaml
   sudo nano /usr/local/sbin/onvif-network
   ```

   Add new cameras under the existing `onvif:` list, with unique UUIDs and MACs. Keep existing identities unchanged. Add one matching `add_camera` line with an unused IP for each new camera. Use the [complete additional-camera example and editing instructions](docs/raspberry-pi-setup.md#14-add-or-edit-cameras-directly-on-the-pi). Use verified event channels and actual stream parameters.

3. Validate the files:

   ```sh
   sudo chmod 755 /usr/local/sbin/onvif-network
   sudo chown root:onvif /etc/onvif-protect.yaml
   sudo chmod 640 /etc/onvif-protect.yaml
   sudo sh -n /usr/local/sbin/onvif-network
   sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
     /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
   ```

   The script check prints nothing on success. Configuration validation must report the expected camera count. **Fix any errors before continuing.**

4. Apply networking and check all virtual IPs:

   ```sh
   sudo systemctl restart onvif-network.service
   ip -br address
   ```

   If networking fails or interfaces are missing, check `sudo journalctl -u onvif-network.service -n 50 --no-pager` and correct it first. If only camera settings changed, the network restart can be skipped.

5. Start the bridge and inspect its status:

   ```sh
   sudo systemctl start onvif-protect.service
   sudo systemctl status onvif-protect.service --no-pager
   sudo journalctl -u onvif-protect.service -n 60 --no-pager
   ```

6. Adopt each new virtual IP in Protect using ONVIF port `8081` and the source's video credentials. Enable motion notification on each source channel, then verify its `/healthz` response and Protect timeline. If the bridge shows movement but subscriptions stay at zero, follow [the restart and subscription checks](docs/raspberry-pi-setup.md#12-if-motion-reaches-the-bridge-but-not-protect).

You do not need to edit the `.service` files or run `daemon-reload` for these configuration changes.

## Docker on Raspberry Pi or Linux

Create the same macvlan interfaces on the **Linux host** first. The image does not modify host networking or require privileged mode. Use your validated `config.yaml`. For RTSP without events, create an empty `.env` using `touch .env`; for motion forwarding, use the environment variables referenced by your event source:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose logs -f
```

When migrating from systemd, stop `onvif-protect.service` first to release its ports, but keep `onvif-network.service`. Compose uses `network_mode: host`; Docker Desktop on macOS/Windows is not a substitute for this Linux deployment's multicast and independent MAC requirements. The official Node 22 Alpine base provides ARM64/AMD64 variants, and this project has no custom native compilation step. Verify image building and execution on your target machine.

## Compatibility and limitations

- `sudo /usr/bin/node main.js /etc/onvif-protect.yaml`, `--create-config`, `--version`, `--debug`, and their CLI aliases are supported. The generator retrieves ONVIF profiles and produces YAML; assign MAC addresses and add optional `eventSources`/`motion` after verifying channel IDs. Save generated UUIDs to keep device identities stable.
- The TCP proxy preserves the DVR's RTSP/snapshot authentication. Virtual ONVIF endpoints and `/healthz` do not authenticate clients. The legacy `/snapshot.png` route also has no client authentication and fetches real images using explicit `snapshotAuth` credentials when configured. Use a trusted LAN/VLAN and do not expose these ports to the Internet. Event credentials allow event access independently of video clients.
- RTSP is passed through over TCP. Configure the consumer for interleaved RTP over RTSP/TCP. RTP/UDP forwarding, transcoding, image-based motion detection, PTZ, additional ONVIF audio support, and full Profile T are not implemented.
- Events supports PullPoint subscriptions, renewal, unsubscribe, and synchronization. Push `Subscribe`, historical event search, and arbitrary filters are not implemented. Only `RuleEngine/CellMotionDetector/Motion` is advertised.
- Each camera supports up to 32 subscriptions and 256 queued changes per subscription. Full queues discard the oldest changes. Events are not persisted. New subscriptions receive the current state.
- One event-stream connection is opened per used `eventSources` entry. Reuse its `id` across cameras on the same DVR. Each video consumer opens its own stream to the DVR, so the recorder's concurrent stream limits still apply.
- Event-source TLS certificates are verified by default. Use `NODE_EXTRA_CA_CERTS` for a private CA; certificate validation is not disabled.
- ONVIF/W3C/OASIS schemas are included locally, so startup does not require Internet access. `scripts/vendor-wsdl.py` refreshes them deliberately and records their sources in `wsdl/sources.json`.

## Code organization

- `main.js` is the executable entry point; `src/cli.js` handles command-line options and interactive setup.
- `src/application.js` validates and copies configuration, starts camera services and event sources, and owns shutdown and startup rollback.
- `src/config.js` validates source, camera, profile, and motion settings. `src/config-builder.js` discovers profiles and generates configuration.
- `src/onvif/` contains Device and Media operations, discovery, HTTP routing, event XML, and subscription state used to assemble virtual cameras.
- `src/event-stream/` handles event stream connections and XML framing. `src/event-sources.js` selects adapters, and `src/motion-router.js` routes events to configured cameras.
- `src/transport/` contains shared XML, Digest authentication, and server lifecycle utilities. `src/tcp-proxy.js` provides stream passthrough; `src/snapshot.js` fetches real source images for the legacy snapshot route.

Each application owns its listeners, event sources, and timers. Shutdown can be called repeatedly. A failed startup closes acquired resources, and the application does not mutate the configuration supplied by its caller. Subscription state is separate from SOAP serialization so lifecycle behavior can be tested independently.

## Development

```sh
npm ci --ignore-scripts
npm test
```

Tests cover configurations with and without event sources, fragmented event parsing, channel isolation, Digest authentication against a simulated DVR, reconnection, subscription lifecycle, long polling, Device and Media SOAP operations, discovery, TCP passthrough, failed-startup cleanup, repeated shutdown, and cancelled requests.

## License

Contributions by David Chavez are licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). This is source-available software for the purposes permitted by that license, including its specified institutional uses. Uses outside those permissions require a separate license from the relevant rights holder. Commercial terms and royalties must be agreed separately; this license does not set a royalty rate.

Incorporated third-party code, derived portions, dependencies, and schemas retain their applicable licenses. This change does not withdraw permissions already granted for copies distributed under earlier licenses.
