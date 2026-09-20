# ONVIF Protect — Universal RTSP to ONVIF Bridge

Use compatible RTSP/TCP streams from DVRs, NVRs, or cameras of any brand as virtual ONVIF devices in UniFi Protect or other compatible clients. The source device does not need to support ONVIF when configured manually. Motion forwarding is an **optional event integration**, separate from video streaming.

Designed for Raspberry Pi with Ethernet, 64-bit Raspberry Pi OS, and Node.js 22 or later. Docker configuration is also included for Linux ARM64/AMD64. This bridge does not transcode or analyze video: motion detection happens on the source device.

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

1. Copy this project to your Raspberry Pi, for example to `/opt/onvif-protect`. Install Node.js 22 or later and check `node --version`. The supplied systemd unit expects `/usr/bin/node`; adjust `ExecStart` if your executable is elsewhere.
2. Inside the project directory:

   ```sh
   npm ci --omit=dev --ignore-scripts
   cp config.example.yaml config.yaml
   ```

3. Edit `config.yaml` with your DVR/NVR/camera address, actual RTSP path, resolution, frame rate, and a unique UUID and MAC for each virtual camera. The default example **does not require ONVIF on the source or event credentials**. For optional motion forwarding, configure an event source as described below and create a `.env` file with the environment variables referenced by that source.
4. Create the virtual interfaces described below. Each camera needs **its own local IP and MAC address**, plus a stable UUID. Writing a MAC address in YAML does not create an interface.
5. Validate and start:

   ```sh
   node main.js --check-config config.yaml
   node main.js config.yaml
   ```

When loading event credentials from `.env`, add `--env-file=.env` after `node` in both commands. `usernameEnv` and `passwordEnv` reference environment variables; inline `username` and `password` fields are also supported in YAML.

`--check-config` validates configuration structure and available credentials. It does not connect to the DVR, check local interfaces, or certify Protect compatibility. Startup checks address availability and listener conflicts before opening services.

### Persistent virtual networking

Use Ethernet (`eth0` in the example). Macvlan generally does not work over a Wi-Fi client connection. Reserve unused addresses outside the DHCP pool or exclude them from it: **192.168.1.201 and .202 are examples**, not addresses you can assume are available. The DVR, Raspberry Pi, and virtual cameras need different IP addresses.

Edit `scripts/network.example.sh` with your physical interface, subnet, IP addresses, and MAC addresses. Its entries must match `config.yaml`. Keep one entry per virtual camera. The script assigns static addresses; it does not request DHCP leases.

After reviewing the addresses:

```sh
sudo install -m 0755 scripts/network.example.sh /usr/local/sbin/onvif-network
sudo install -m 0644 scripts/onvif-network.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-network.service
ip -br address
```

The service recreates interfaces after reboot. After editing the script, run `sudo systemctl restart onvif-network`. It does not remove old interfaces or addresses: when changing an IP/MAC, explicitly clean up the previous interface before recreating it.

Protect must be able to reach the virtual IP addresses and configured ports. Allow UDP 3702 for discovery, TCP 8081/8082 for ONVIF in the examples, TCP 8554 for RTSP, and TCP 8580 when snapshots are configured. The bridge connects to the DVR using ports such as TCP 80/443 and 554, depending on configuration. RTSP/snapshot ports can be reused on different virtual IPs because each proxy binds to its own address.

If Protect sees the host MAC for multiple virtual IPs, inspect ARP from another machine. Settings such as `net.ipv4.conf.all.arp_ignore=1` and `net.ipv4.conf.all.arp_announce=2` may help; consider their effects on the Raspberry Pi's other interfaces and routes. Communication between a host and its own macvlan interfaces may need additional network configuration. Test adoption from Protect on the LAN.

### Optional motion event setup

Configure motion detection, zones, sensitivity, and schedules on each source channel. Synchronize time/NTP on the recorder, Raspberry Pi, and Protect. Enable event access for an account with the required permissions.

The event source must match the included adapter's protocol: a persistent HTTP(S) XML stream with Digest authentication and `EventNotificationAlert` documents containing `eventType`, `eventState`, and `channelID` or `dynChannelID`. A device exposing RTSP does not necessarily expose this event protocol.

Add a source to `config.yaml`. Replace the URL placeholder with your device's compatible event endpoint:

```yaml
eventSources:
  - id: recorder-events
    url: http://DVR_IP/EVENT_STREAM_PATH
    usernameEnv: EVENT_USERNAME
    passwordEnv: EVENT_PASSWORD
    idleTimeoutMs: 90000
```

Create `.env` with `EVENT_USERNAME` and `EVENT_PASSWORD`, then start with `node --env-file=.env main.js config.yaml`. The source ID is a local name used to connect virtual cameras to their event source.

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

## Adoption and acceptance testing in Protect

Enable **Discover Third-Party Cameras**, adopt each virtual camera, and provide the DVR's video credentials. The event account can be different. If multicast discovery does not find the camera, use advanced adoption with its virtual IP and ONVIF port.

Ubiquiti states that third-party motion detection must be configured on the camera and sent to Protect: [official documentation](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect). This bridge does not require Protect administrator credentials.

1. Start with one channel and verify video, plus LQ and snapshots if configured.
2. For motion-enabled cameras, inspect `http://VIRTUAL_IP:8081/healthz`: `source.connected` should be `true`, and `subscriptions` should increase when Protect subscribes.
3. Trigger motion and confirm `motion: true`, followed by `false`, and an event on **that same camera's** Protect timeline.
4. Add another channel and verify that it does not receive the first channel's motion.
5. Restart the DVR and check reconnection. Restart the Raspberry Pi and check interfaces, the service, and persistent adoption.

`/healthz` reports local status; HTTP 200 does not guarantee DVR connectivity or recording in Protect. Logs identify connections and retries by source. `--debug` adds ONVIF operations and motion transitions without logging passwords or authentication headers.

**Physical validation is still required:** your device's event numbering, event endpoint access, and notification acceptance by your Protect installation. Automated tests use simulated devices and clients; they are not ONVIF certification or hardware validation.

## Automatic startup without Docker

With the project in `/opt/onvif-protect`, create a dedicated user and install your configuration. For RTSP video without events, create an empty environment file using `touch .env`:

```sh
sudo useradd --system --user-group --home-dir /opt/onvif-protect --shell /usr/sbin/nologin onvif
sudo install -o root -g onvif -m 0640 config.yaml /etc/onvif-protect.yaml
sudo install -o root -g root -m 0600 .env /etc/onvif-protect.env
sudo install -m 0644 scripts/onvif-protect.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-protect
journalctl -u onvif-protect -f
```

Skip `useradd` if the account already exists. Project files and dependencies must be readable by `onvif`. The systemd environment file uses `NAME=value`, without `export`; quote values containing spaces according to `EnvironmentFile` syntax. Do not run the manual process and systemd service simultaneously.

## Docker on Raspberry Pi or Linux

Create the same macvlan interfaces on the **Linux host** first. The image does not modify host networking or require privileged mode. Use your validated `config.yaml`. For RTSP without events, create an empty `.env` using `touch .env`; for motion forwarding, use the environment variables referenced by your event source:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose logs -f
```

When migrating from systemd, stop `onvif-protect.service` first to release its ports, but keep `onvif-network.service`. Compose uses `network_mode: host`; Docker Desktop on macOS/Windows is not a substitute for this Linux deployment's multicast and independent MAC requirements. The official Node 22 Alpine base provides ARM64/AMD64 variants, and this project has no custom native compilation step. Verify image building and execution on your target machine.

## Compatibility and limitations

- `node main.js config.yaml`, `--create-config`, `--version`, `--debug`, and their CLI aliases are supported. The generator retrieves ONVIF profiles and produces YAML; assign MAC addresses and add optional `eventSources`/`motion` after verifying channel IDs. Save generated UUIDs to keep device identities stable.
- The TCP proxy preserves the DVR's RTSP/snapshot authentication. Virtual ONVIF endpoints and `/healthz` do not authenticate clients. Use a trusted LAN/VLAN and do not expose these ports to the Internet. Event credentials allow event access independently of video clients.
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
- `src/transport/` contains shared XML, Digest authentication, and server lifecycle utilities. `src/tcp-proxy.js` provides stream passthrough.

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
