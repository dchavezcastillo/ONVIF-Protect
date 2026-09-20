#!/bin/sh
# EDIT the interface, IP/prefix, and MAC before installing. Ethernet only, no Wi-Fi.
set -eu
add_camera() {
    name="$1"; mac="$2"; address="$3"
    if ! ip link show "$name" >/dev/null 2>&1; then
        ip link add "$name" link eth0 address "$mac" type macvlan mode bridge
    fi
    # Fail if this interface name already belongs to a different MAC.
    test "$(cat "/sys/class/net/$name/address")" = "$mac"
    ip address replace "$address" dev "$name"
    ip link set "$name" up
}
add_camera onvif1 a2:a2:a2:a2:a2:a1 192.168.1.201/24
add_camera onvif2 a2:a2:a2:a2:a2:a2 192.168.1.202/24
