# Virtual camera networking and stable identities

Use this procedure when only some cameras appear for adoption or Protect displays different IP associations after a restart. Keep each adopted camera's UUID, MAC, and assigned IP unchanged. Do not remove cameras as a diagnostic step.

Commands run on the Pi unless a step explicitly says otherwise. Edit files directly with nano: Ctrl+O, Enter, Ctrl+X. Use your actual subnet and interface names.

## 1. Check the installed interfaces and services

```sh
ip -br address
ip -br link
systemctl is-active onvif-network.service onvif-protect.service
sudo journalctl -u onvif-network.service -n 50 --no-pager
sudo journalctl -u onvif-protect.service -n 60 --no-pager
```

Every camera needs an interface with its own static IP and a MAC matching its YAML entry. The example network script does not use DHCP. Reserve/exclude these IPs from the DHCP pool and ensure no other device uses them.

If interfaces are missing, edit and validate the active script:

```sh
sudo nano /usr/local/sbin/onvif-network
sudo sh -n /usr/local/sbin/onvif-network
```

Fix errors first. Then apply the script before starting the bridge (video is interrupted during this step):

```sh
sudo systemctl stop onvif-protect.service
sudo systemctl restart onvif-network.service
ip -br address
sudo systemctl start onvif-protect.service
```

The script does not remove obsolete addresses/interfaces. Do not change existing assignments as a troubleshooting shortcut.

## 2. Check each camera's HTTP endpoint

For an example installation with channels 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, and 17, run this on the Pi, then from another computer able to reach the cameras. Adjust the list for your installation:

```sh
for n in 201 202 203 205 206 207 209 210 211 213 217; do
  printf '\n192.168.1.%s\n' "$n"
  curl --fail --silent --show-error --connect-timeout 2 --max-time 3 \
    "http://192.168.1.$n:8081/healthz"
  printf '\n'
done
```

Each IP should return its own expected camera name. All endpoints responding proves HTTP reachability from that test computer, not discovery, video, or correct MAC identification by Protect. `subscriptions: 0` on an unadopted camera is not evidence of a network failure.

## 3. Inspect ARP from the camera subnet

Use another computer on the **same LAN/VLAN and subnet as the virtual cameras**. Do not use the Pi to inspect ARP for its own virtual IPs.

On a Linux computer in that subnet:

```sh
curl --fail --show-error --max-time 5 http://192.168.1.201:8081/healthz
ip neigh show 192.168.1.201
```

On a Mac in that subnet:

```sh
route -n get 192.168.1.201
curl --fail --show-error --max-time 5 http://192.168.1.201:8081/healthz
arp -n 192.168.1.201
```

Repeat for the other camera IPs. Compare each learned MAC with `ip -br link` on the Pi and the corresponding YAML MAC. For example, `.201` should match `a2:a2:a2:a2:a2:a1` when using the guide's example.

If the Mac's route uses a gateway such as `192.168.2.1`, it reaches the cameras through a router. No ARP entry for `192.168.1.201` is expected there: the Mac resolves the gateway instead. Check on a computer in the camera subnet or inspect the router's neighbor table on that LAN.

A host MAC appearing for several camera IPs warrants investigating ARP behavior. A MAC belonging to a different device warrants checking an address conflict. Neither should be inferred only from the IP labels displayed in Protect.

## 4. Test ARP settings only when indicated

If the Pi is answering for virtual IPs with the host MAC, test the following settings. They apply to **all IPv4 interfaces** on the Pi; consider other services using those interfaces. This is a diagnostic adjustment, not a guaranteed discovery fix.

First record the current values so you can restore them:

```sh
sysctl net.ipv4.conf.all.arp_ignore \
       net.ipv4.conf.all.arp_announce \
       net.ipv4.conf.eth0.arp_ignore \
       net.ipv4.conf.eth0.arp_announce
```

Apply a temporary change:

```sh
sudo sysctl -w net.ipv4.conf.all.arp_ignore=1
sudo sysctl -w net.ipv4.conf.all.arp_announce=2
```

Repeat the remote MAC and HTTP checks after neighbor entries refresh. These settings restrict ARP replies and select more appropriate source addresses for ARP requests. They do not change camera IPs or identifiers. If they do not improve the observed behavior, restore the previous values and continue diagnosis.

To retain a successful adjustment after reboot:

```sh
sudo nano /etc/sysctl.d/90-onvif-network.conf
```

Put these two lines in this dedicated file:

```conf
net.ipv4.conf.all.arp_ignore = 1
net.ipv4.conf.all.arp_announce = 2
```

Apply and verify:

```sh
sudo sysctl -p /etc/sysctl.d/90-onvif-network.conf
sysctl net.ipv4.conf.all.arp_ignore net.ipv4.conf.all.arp_announce
```

For rollback, edit the same file to restore the values you recorded, then run the same `sysctl -p` command. For a temporary-only test, restore the recorded values with `sudo sysctl -w` instead. Do not assume the previous values were zero.

## 5. Separate discovery from reachability

If all HTTP checks and MAC mappings are correct but cameras remain undiscovered:

- Confirm each camera has a unique UUID and MAC in `/etc/onvif-protect.yaml`.
- Check UDP 3702/multicast reachability between Protect and the virtual cameras. Routed HTTP access does not prove multicast discovery works.
- For cameras not yet adopted, try advanced adoption using each virtual IP and ONVIF port 8081. Preserve cameras already adopted.
- Allow Protect to reach TCP 8081 (ONVIF and snapshots), 8554 (RTSP), and 8580 if configured (direct snapshot proxy). The Pi also needs access to the source's configured ports.

Collect bridge logs and, if tcpdump is installed, discovery traffic while Protect searches:

```sh
sudo timeout 60 tcpdump -nn -i eth0 'udp port 3702'
```

A healthy HTTP endpoint does not prove that discovery responses carry the correct identity or source address. Investigate those responses if the problem persists; ARP settings alone cannot establish the cause.

## 6. Verify persistence

After saving and validating the configuration, reboot the Pi during a suitable interruption window:

```sh
sudo reboot
```

Reconnect and run:

```sh
ip -br address
systemctl is-active onvif-network.service onvif-protect.service
sysctl net.ipv4.conf.all.arp_ignore net.ipv4.conf.all.arp_announce
```

Repeat the per-camera HTTP checks and remote MAC checks. Confirm that Protect retains each existing camera's identity, video, and motion events. If network mappings are stable but Protect still shows stale associations, a Protect application restart can be tested; it interrupts recording and is not guaranteed to resolve discovery.

For routine application updates, follow [Update the code on the Raspberry Pi](update-raspberry-pi.md). Updating application code is separate from changing ARP settings or camera identities.
