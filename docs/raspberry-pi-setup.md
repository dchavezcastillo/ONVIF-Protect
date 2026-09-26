# Raspberry Pi OS Lite: one camera with video and motion

This guide installs the bridge directly on Raspberry Pi OS Lite with systemd. It starts with one virtual camera, verifies video, then adds motion events and checks delivery to UniFi Protect. No desktop or Docker is required.

**Run the commands in this guide on the Raspberry Pi**, in its terminal or an SSH session. Follow sections 1–11 for a new installation. If the bridge already works and you want to add cameras, go directly to [section 14](#14-add-or-edit-cameras-directly-on-the-pi).

In nano, save with **Ctrl+O**, press **Enter**, and exit with **Ctrl+X**. Copy only the text inside command blocks, without Markdown link brackets. Replace example addresses and placeholder values before running commands.

| File | What you edit |
| --- | --- |
| `/etc/onvif-protect.yaml` | Cameras, stream paths, snapshots, and motion settings |
| `/etc/onvif-protect.env` | Event and snapshot account credentials |
| `/usr/local/sbin/onvif-network` | Virtual interfaces, MACs, and IPs |
| `/etc/sysctl.d/90-onvif-network.conf` | Optional ARP settings, only after the network test |

Video works with compatible RTSP/TCP sources. Motion requires a separate compatible event interface: the included adapter reads an HTTP(S) XML stream using Digest authentication. RTSP support alone does not imply event compatibility. The bridge neither analyzes images nor transcodes video.

## 1. Prepare the Raspberry Pi

Connect Ethernet and open a terminal or SSH session on the Pi. Run:

```sh
dpkg --print-architecture
ip -br address
```

Use a 64-bit installation (`arm64`). If the result is `armhf`, use Raspberry Pi OS Lite 64-bit for this deployment. Identify the Ethernet interface; this guide assumes `eth0`. Macvlan generally does not work over a Wi-Fi client connection.

Plan your addresses before creating interfaces:

| Purpose | Example |
| --- | --- |
| Raspberry Pi management IP | `192.168.1.169` |
| Source recorder or camera | `192.168.1.25` |
| Virtual camera | `192.168.1.201/24` |
| Virtual camera MAC | `a2:a2:a2:a2:a2:a1` |
| Virtual ONVIF port | `8081` |
| Virtual RTSP port | `8554` |
| Source RTSP port | `554` |

These are examples, not automatically available addresses. Use your actual subnet and an unused virtual IP outside the DHCP pool or excluded from it. The Pi, source, and virtual camera must have different IPs. Use stable addresses for the Pi and source. Protect must be able to reach the virtual camera.

## 2. Install Node.js and download the project

```sh
sudo apt update
sudo apt install -y git curl ca-certificates nano iproute2
```

The project requires Node.js 22 or later. If a suitable version is already installed at `/usr/bin/node`, skip the installation below. Otherwise, the following uses the [NodeSource Debian installation method](https://github.com/nodesource/distributions/blob/master/DEV_README.md), which adds an external package repository:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node --version
npm --version
command -v node
```

The supplied systemd unit expects `/usr/bin/node`. Adjust its `ExecStart` if your installation uses a different path.

For a fresh project directory:

```sh
sudo mkdir -p /opt/onvif-protect
sudo chown "$(id -un):$(id -gn)" /opt/onvif-protect
git clone https://github.com/dchavezcastillo/ONVIF-Protect.git /opt/onvif-protect
cd /opt/onvif-protect
npm ci --omit=dev --ignore-scripts
```

If access to the repository requires authentication, use an account with access. If the project already exists, use that checkout instead of cloning over it.

## 3. Configure one video stream

Obtain the real RTSP URL from the source configuration or documentation. Begin with H.264 and RTSP/TCP. The bridge does not convert unsupported codecs.

Generate a UUID once:

```sh
node -e 'console.log(require("node:crypto").randomUUID())'
sudo nano /etc/onvif-protect.yaml
```

Paste this complete video-only configuration into the new file, replacing the UUID, stream path, source address, and video parameters:

```yaml
onvif:
  - name: Camera 1
    mac: a2:a2:a2:a2:a2:a1
    uuid: REPLACE-WITH-GENERATED-UUID
    ports:
      server: 8081
      rtsp: 8554
    highQuality:
      rtsp: "/actual/stream/path"
      width: 1920
      height: 1080
      framerate: 15
      bitrate: 2048
      quality: 4
    target:
      hostname: 192.168.1.25
      ports:
        rtsp: 554
```

`highQuality.rtsp` is only the path, starting with `/`, including a query string if required. For `rtsp://192.168.1.25:554/actual/stream/path`, use `/actual/stream/path`. Do not put the complete URL or credentials in this field. Video credentials are supplied during adoption in Protect.

`target.hostname` is the real source IP, **not** the virtual IP `192.168.1.201`. Pointing it at the virtual camera prevents the proxy from reaching the source.

Save in nano with Ctrl+O, Enter, then Ctrl+X. Protect the new file before continuing:

```sh
sudo chown root:root /etc/onvif-protect.yaml
sudo chmod 600 /etc/onvif-protect.yaml
```

Keep the UUID and MAC stable after adoption. The resolution, frame rate, and bitrate must describe the actual source stream.

## 4. Create persistent virtual networking

Open the installed script directly:

```sh
sudo nano /usr/local/sbin/onvif-network
```

Paste the following. Replace `eth0`, the MAC, and the IP/prefix with your values. The MAC must match `/etc/onvif-protect.yaml`.

```sh
#!/bin/sh
set -eu

add_camera() {
    name="$1"
    mac="$2"
    address="$3"
    if ! ip link show "$name" >/dev/null 2>&1; then
        ip link add "$name" link eth0 address "$mac" type macvlan mode bridge
    fi
    test "$(cat "/sys/class/net/$name/address")" = "$mac"
    ip address replace "$address" dev "$name"
    ip link set "$name" up
}

add_camera onvif1 a2:a2:a2:a2:a2:a1 192.168.1.201/24
```

Save, then check the script and install the network service:

```sh
sudo chmod 755 /usr/local/sbin/onvif-network
sudo sh -n /usr/local/sbin/onvif-network
```

No output means the syntax check passed. If it reports an error, fix it before continuing.

```sh
cd /opt/onvif-protect
sudo install -m 0644 scripts/onvif-network.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-network.service
ip -br address
```

Expect `onvif1` with `192.168.1.201/24`. On failure:

```sh
sudo journalctl -u onvif-network.service -n 50 --no-pager
```

For future changes, edit `/usr/local/sbin/onvif-network` directly with `sudo nano`. The script does not remove old interfaces or addresses. IP/MAC changes require deliberate cleanup of the previous interface.

If a firewall or VLAN separates the devices, allow Protect to reach UDP 3702 for discovery, TCP 8081 for ONVIF, and TCP 8554 for video. The Pi also needs access to the source's RTSP and event ports. Use a trusted network: the virtual ONVIF and health endpoints do not authenticate clients.

If some cameras are missing or their IP associations change in Protect, use [network troubleshooting](network-troubleshooting.md). It includes checks for every configured IP, ARP inspection from the correct subnet, optional persistent ARP settings, and reboot verification. Keep the existing camera identities. A successful local HTTP check alone does not verify what Protect sees on the network.

When adding snapshots, also allow TCP 8580 to the virtual IP and HTTP access from the Pi to the source snapshot port (80 in the examples). The `/snapshot.png` image URL uses the existing ONVIF port 8081.

## 5. Validate and test manually

```sh
cd /opt/onvif-protect
sudo /usr/bin/node main.js --check-config /etc/onvif-protect.yaml
sudo /usr/bin/node main.js /etc/onvif-protect.yaml
```

Leave the process running. From another terminal:

```sh
curl --show-error --max-time 5 http://192.168.1.201:8081/healthz
```

A video-only camera reports `motion: null`, `subscriptions: 0`, and `source: null`. This confirms HTTP access, not source video connectivity. Test actual video in Protect.

Copy commands from code blocks as plain text; do not include Markdown link brackets. `ping` accepts an IP or hostname, not an HTTP URL:

```sh
ping 192.168.1.201
```

When an HTTP request cannot connect, check the interface and listener:

```sh
ip -br address
sudo ss -lntp | grep ':8081'
```

Stop the manual process with Ctrl+C before starting the systemd service.

## 6. Install the application service

Create the service account if it does not already exist:

```sh
sudo useradd --system --user-group --home-dir /opt/onvif-protect --shell /usr/sbin/nologin onvif
```

Give the service account read access to the existing configuration and create an initially empty environment file:

```sh
cd /opt/onvif-protect
sudo chown root:onvif /etc/onvif-protect.yaml
sudo chmod 640 /etc/onvif-protect.yaml
sudo touch /etc/onvif-protect.env
sudo chown root:root /etc/onvif-protect.env
sudo chmod 600 /etc/onvif-protect.env
sudo install -m 0644 scripts/onvif-protect.service /etc/systemd/system/
sudo -u onvif /usr/bin/node /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

Project files and dependencies must be readable by `onvif`. Resolve permission or validation errors before continuing.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now onvif-protect.service
sudo systemctl status onvif-protect.service --no-pager
sudo journalctl -u onvif-protect.service -f
```

Ctrl+C exits the log viewer without stopping the service. **Edit `/etc/onvif-protect.yaml`** for both manual runs and the service. No second configuration copy is needed.

## 7. Adopt and check video in Protect

In Protect, enable **Discover Third-Party Cameras** under Settings > System. Adopt the virtual camera and enter the source's video credentials. If discovery fails, use advanced adoption with the virtual address `192.168.1.201` and ONVIF port `8081`.

The bridge currently advertises model/name `Cardinal`, so that label may appear before renaming the adopted camera. The recorder may also appear independently at its own IP; select the virtual camera for this bridge.

Confirm live video and recording. Continuous recording or an Online status does not prove motion delivery. See [Protect's third-party camera documentation](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect).

You can also complete the motion configuration below before first adoption, so Protect discovers the Events capability immediately.

## 8. Enable motion notifications on the source

For the source channel that supplies this camera:

1. Enable motion detection.
2. Draw the detection region and set sensitivity.
3. Set an arming schedule that includes the current day and time.
4. Enable the action that publishes alarms to monitoring clients, often called **Notify Surveillance Center**. Recording on motion alone is not sufficient.
5. Save changes and trigger a new motion episode.

Names and availability vary by device. Synchronize the source, Pi, and Protect clocks. The source must expose the compatible event protocol described below; other protocols require another adapter.

## 9. Verify the raw event stream first

Obtain the source's HTTP(S) event URL. Replace `EVENT_STREAM_PATH` and `YOUR_USERNAME`:

```sh
curl --digest --user YOUR_USERNAME --no-buffer --max-time 120 \
  http://192.168.1.25/EVENT_STREAM_PATH
```

Enter the password when prompted. Do not include it in the URL or shell command. On sources that expose it, `/ISAPI/Event/notification/alertStream` is an example compatible endpoint; it is not universal.

Trigger movement while the request is open. A compatible channel-1 motion message contains:

```xml
<EventNotificationAlert>
  <channelID>1</channelID>
  <eventType>VMD</eventType>
  <eventState>active</eventState>
</EventNotificationAlert>
```

Use the actual reported values. An RTSP stream identifier is not necessarily the event channel ID. For devices using paths such as `/Streaming/Channels/101`, `101` denotes channel 1's main stream; still verify the event's `channelID` independently. If the event instead uses `dynChannelID`, configure that field explicitly.

On this compatible protocol, repeated `videoloss` / `inactive` messages with channel `0` can be heartbeats. They prove the connection is alive, not motion. Do not change the camera's motion channel to `0`. A timeout at the requested 120 seconds is expected for this persistent stream.

If only heartbeats arrive, check detection, region, arming schedule, notification linkage, and whether the source itself displays a motion alarm. For HTTP 401/403, check credentials and permissions; for 404, check the endpoint and firmware support.

## 10. Add motion to the camera configuration

Edit the active configuration directly:

```sh
sudo nano /etc/onvif-protect.yaml
```

Use this complete structure. **Preserve your existing UUID, MAC, working video path, and video parameters.** Replace the event URL with the one verified using curl. `eventSources` and `onvif` are top-level keys; `motion` belongs to the camera, alongside `target` and `highQuality`.

```yaml
eventSources:
  - id: recorder-events
    url: http://192.168.1.25/EVENT_STREAM_PATH
    usernameEnv: EVENT_USERNAME
    passwordEnv: EVENT_PASSWORD
    idleTimeoutMs: 90000

onvif:
  - name: Camera 1
    mac: a2:a2:a2:a2:a2:a1
    uuid: REPLACE-WITH-YOUR-EXISTING-UUID
    ports:
      server: 8081
      rtsp: 8554
    highQuality:
      rtsp: "/actual/stream/path"
      width: 1920
      height: 1080
      framerate: 15
      bitrate: 2048
      quality: 4
    target:
      hostname: 192.168.1.25
      ports:
        rtsp: 554
    motion:
      source: recorder-events
      channel: 1
      channelField: channelID
      eventTypes: [VMD]
      resetAfterMs: 30000
```

Omitting `type` selects the existing default XML/Digest adapter; it does not automatically detect arbitrary event protocols. `motion.source` must match the source `id`. This example filters out events for other channels and event types.

Store the event account credentials:

```sh
sudo nano /etc/onvif-protect.env
```

```dotenv
EVENT_USERNAME='YOUR_USERNAME'
EVENT_PASSWORD='YOUR_PASSWORD'
```

Replace the placeholders. Use `NAME=value` without `export`. The simple quoted form above works for ordinary values; embedded quotes or multiline values require appropriate environment-file syntax. Never share this file. The event account may differ from the video account.

```sh
sudo chown root:onvif /etc/onvif-protect.yaml
sudo chmod 640 /etc/onvif-protect.yaml
sudo chown root:root /etc/onvif-protect.env
sudo chmod 600 /etc/onvif-protect.env
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

If validation fails, correct the error before restarting. Validation does not contact the source or certify Protect compatibility.

```sh
sudo systemctl restart onvif-protect.service
sudo journalctl -u onvif-protect.service -n 40 --no-pager
```

Look for `Events recorder-events: connected`.

## 11. Verify motion through all three stages

Run:

```sh
watch -n 1 'curl --show-error --max-time 2 http://192.168.1.201:8081/healthz'
```

Trigger movement and interpret the response:

| Field | Meaning |
| --- | --- |
| `motion: null` | This running camera does not have Events enabled; check the loaded configuration. |
| `source: null` | No event source is associated with this running camera. |
| `source.connected: false` | The event-source connection is not active; inspect logs. |
| `source.connected: true` | Connected to the event stream; this alone does not prove movement. |
| `source.lastEvent` | Last parsed event, including heartbeats and events for other channels. |
| `motion: true` | The bridge recognized active movement for this camera. |
| `subscriptions: 0` | No active ONVIF PullPoint subscriptions. Protect is not currently subscribed through this interface. |
| `subscriptions` greater than `0` | A client is subscribed; if Protect is the only client, this is its subscription. Delivery/acceptance still needs verification. |
| `source.reconnects` | Reconnection count; inspect logs if it keeps increasing. |

The bridge returns to `motion: false` when it receives an inactive event, or after 30 seconds without another matching activation. Repeated active events refresh that timer. Continuous motion need not produce a separate timeline entry for every repeated message.

Finally, verify a motion event on **this virtual camera's Protect timeline** at the test time. Live video, continuous recording, HTTP 200, and an active subscription are not substitutes for this acceptance check.

## 12. If motion reaches the bridge but not Protect

If `motion: true` is visible but `subscriptions: 0` persists, the source-to-bridge path works. Investigate Protect's event subscription next.

After enabling motion, check that Protect subscribes to events. If it does not, use the following restart and verification procedure, then collect debug logs if the issue persists.

1. Ensure the saved service configuration includes motion and starts successfully.
2. Restart the Pi and reconnect after it boots:

   ```sh
   sudo reboot
   ```

3. Verify interfaces and both services:

   ```sh
   ip -br address
   systemctl is-active onvif-network.service onvif-protect.service
   curl --show-error --max-time 5 http://192.168.1.201:8081/healthz
   ```

4. If subscriptions remain at zero, restart the **Protect application** through your console's application management. This temporarily interrupts viewing and recording for its cameras. Wait for the virtual camera to return online.
5. Check `/healthz` again. Let motion return to false, trigger a new episode, and check the Protect timeline.

Do not regenerate the UUID or MAC as a troubleshooting step. Do not immediately remove/re-adopt the camera: that can affect its association with existing recordings. If restarting does not help, collect the Protect version, health response, and ONVIF debug logs below before deciding on further changes.

If subscriptions exist but no timeline event appears, inspect event requests/errors and Protect settings. A subscription alone does not guarantee notification compatibility.

## 13. Capture debug logs

A manual debug process temporarily replaces the service and interrupts video during the switch. Never run both simultaneously:

```sh
sudo systemctl stop onvif-protect.service
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js /etc/onvif-protect.yaml --debug
```

Keep this terminal open. Look for `Motion Camera 1: true` and ONVIF requests/errors. From another SSH session, check `/healthz` while moving. If needed, repeat the raw event-stream curl test at the same time to compare source events with bridge activity.

Share relevant debug output and the health response, not credentials. When done, press Ctrl+C in the debug terminal and restore the service:

```sh
sudo systemctl start onvif-protect.service
```

If the service receives no movement but the manual process does, compare the service's loaded configuration, environment, and logs:

```sh
sudo systemctl cat onvif-protect.service
sudo journalctl -u onvif-protect.service -n 100 --no-pager
pgrep -af 'node.*main.js'
sudo ss -lntup | grep -E ':3702|:8081|:8554'
```

## 14. Add or edit cameras directly on the Pi

Use this procedure after the initial installation. Edit the active files with nano; no upload, backup, or configuration-copy step is needed. Keep the UUID and MAC of each existing camera unchanged.

### Step 1: Stop the bridge

This temporarily interrupts its video streams:

```sh
sudo systemctl stop onvif-protect.service
```

### Step 2: Edit the cameras

For each new camera, generate a UUID once:

```sh
node -e 'console.log(require("node:crypto").randomUUID())'
sudo nano /etc/onvif-protect.yaml
```

Keep one top-level `onvif:` list. Add each new camera as another `- name:` entry in that list, aligned with the first camera. Do not paste a second `onvif:` key or place it inside `eventSources`.

For example, append this entry under the existing camera, replacing the placeholder UUID and stream path. Use the event channel and type verified from the source, and the same event-source ID already in your file:

```yaml
  - name: Camera 2
    mac: a2:a2:a2:a2:a2:a2
    uuid: REPLACE-WITH-NEW-UUID
    ports:
      server: 8081
      rtsp: 8554
    highQuality:
      rtsp: "/actual/second/stream/path"
      width: 1920
      height: 1080
      framerate: 15
      bitrate: 2048
      quality: 4
    target:
      hostname: 192.168.1.25
      ports:
        rtsp: 554
    motion:
      source: recorder-events
      channel: 2
      channelField: channelID
      eventTypes: [VMD]
      resetAfterMs: 30000
```

Use the actual video parameters. If your source ID is different, replace `recorder-events` with it. Reuse a single event-source entry for cameras on the same recorder. For video-only cameras, omit `motion`. For events using `dynChannelID`, change `channelField` accordingly; do not infer it from the RTSP path.

### Step 3: Add the matching virtual interface

```sh
sudo nano /usr/local/sbin/onvif-network
```

Keep the function and existing camera lines. Append one line per new camera, for example:

```sh
add_camera onvif2 a2:a2:a2:a2:a2:a2 192.168.1.202/24
```

Each camera needs a unique unused IP, MAC, and UUID. The script MAC must match its YAML entry. Ports `8081` and `8554` can be reused because the cameras have different IPs. Reserve/exclude the new addresses from DHCP before using them. The script does not automatically remove old interfaces when changing existing IPs or MACs.

### Step 4: Validate before starting

```sh
sudo chmod 755 /usr/local/sbin/onvif-network
sudo chown root:onvif /etc/onvif-protect.yaml
sudo chmod 640 /etc/onvif-protect.yaml
sudo sh -n /usr/local/sbin/onvif-network
sudo /usr/bin/node --env-file=/etc/onvif-protect.env \
  /opt/onvif-protect/main.js --check-config /etc/onvif-protect.yaml
```

The shell check should print nothing. The application should print `Configuration valid: N cameras`, with the expected count. **If either check fails, correct the file before continuing.** Validation does not verify IP availability or contact the source.

### Step 5: Start networking, then the bridge

```sh
sudo systemctl restart onvif-network.service
ip -br address
```

Confirm that every expected virtual interface and IP appears. If networking fails, inspect it before starting the bridge:

```sh
sudo journalctl -u onvif-network.service -n 50 --no-pager
```

Once the interfaces are correct:

```sh
sudo systemctl start onvif-protect.service
sudo systemctl status onvif-protect.service --no-pager
sudo journalctl -u onvif-protect.service -n 60 --no-pager
```

No `.service` edits or `daemon-reload` are needed when only changing the YAML, environment file, or network script. If you changed only existing camera settings and not interfaces, the network restart is unnecessary.

### Step 6: Adopt and verify each new camera

Adopt each new virtual IP in Protect using ONVIF port `8081` and the source's video credentials. Existing cameras keep their identities. On the source, enable motion notifications separately for every desired channel.

For the example second camera:

```sh
watch -n 1 'curl --show-error --max-time 2 http://192.168.1.202:8081/healthz'
```

Trigger movement and check `source.connected: true`, `motion: true`, an active subscription, and an event on that camera's Protect timeline. Also check that movement on one channel does not trigger another virtual camera. If `motion: true` appears but subscriptions remain zero, follow [section 12](#12-if-motion-reaches-the-bridge-but-not-protect).

If Protect lists the same virtual IP twice, compare identities, active processes, and the MAC displayed for each entry before changing anything. A source recorder listed at its own IP is a separate discovery entry. Preserve the working camera's identity.

## 15. Update the installed code

Follow [Update the code on the Raspberry Pi](update-raspberry-pi.md) for the exact branch, validation, and restart commands. Keep using `/etc/onvif-protect.yaml` and `/etc/onvif-protect.env`. Updating the project does not require regenerating camera identities, reinstalling network interfaces, or removing cameras from Protect.

## 16. Service commands

Run only the command needed for the action:

```sh
# Stop video/event forwarding.
sudo systemctl stop onvif-protect.service

# Start it again.
sudo systemctl start onvif-protect.service

# Reload camera settings and credentials by restarting.
sudo systemctl restart onvif-protect.service

# Inspect status and recent logs.
sudo systemctl status onvif-protect.service --no-pager
sudo journalctl -u onvif-protect.service -n 60 --no-pager
```

Restart networking only after changing the network script, following section 14. The network service is a oneshot unit: stopping it does not delete virtual interfaces. No `daemon-reload` is required for YAML, environment-file, or network-script edits; it is required after editing a systemd unit.
