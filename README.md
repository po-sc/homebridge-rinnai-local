# homebridge-rinnai-local

[![npm](https://img.shields.io/npm/v/homebridge-rinnai-local)](https://www.npmjs.com/package/homebridge-rinnai-local)
[![test](https://github.com/po-sc/homebridge-rinnai-local/actions/workflows/test.yml/badge.svg)](https://github.com/po-sc/homebridge-rinnai-local/actions/workflows/test.yml)

Homebridge plugin for **Rinnai gas boilers with the WF-100W Wi-Fi controller** (the one used with the *My Rinnai* app). Tested with a WF-100W_EU controller and a REB-KAI3135FF combi boiler in Italy.

[Русская версия](README.ru.md)

## What you get

Two thermostats in the Home app:

| Tile | Shows | Controls |
|---|---|---|
| **Heating** | room temperature | on/off, setpoint 10–40 °C (40–80 °C in flow-temperature mode) |
| **Hot Water** | hot water temperature | on/off, setpoint 35–60 °C |

The **My Rinnai app keeps working**: the plugin sits between the controller and the Rinnai cloud and forwards everything. If the cloud is down, the plugin answers the controller itself, so HomeKit keeps working too.

## How it works

The WF-100W polls the Rinnai cloud every ~5 seconds over plain HTTP on TCP **9105**. Your router redirects that traffic to Homebridge:

```
WF-100W ──TCP 9105──▶ router (NAT) ──▶ Homebridge (this plugin) ──▶ Rinnai cloud
```

- The boiler state is read from the controller's packets.
- A HomeKit command patches only the bytes it needs in the controller's own state and sends it back in the reply. All other bytes are returned verbatim.
- Commands from the My Rinnai app take priority; HomeKit commands wait for the next poll (up to 30 s, then dropped).

## Setup

### 1. Install

Search for **Rinnai WF-100W** in the Homebridge UI → *Plugins*, or:

```sh
npm install -g homebridge-rinnai-local
```

### 2. Find the cloud address of your controller

The controller connects to an **IP address**, not always to the hostname you'd expect:

| Region | Cloud |
|---|---|
| EU (WF-100W_EU) | `37.206.147.54:9105` |
| Korea | `wifiboilers1.rinnai.co.kr:9105` |

To check yours, look at the router's connection table for the controller's IP and destination port 9105 (UniFi over SSH: `grep <controller IP> /proc/net/nf_conntrack`; OpenWrt: *Status → Realtime Graphs → Connections*).

> Overriding DNS alone does **not** work for EU controllers: they use the IP directly.

### 3. Redirect the controller to Homebridge (router)

Give the controller and the Homebridge host fixed IPs, then add two NAT rules:

| Rule | Source | Destination | Translate to |
|---|---|---|---|
| DNAT | controller IP | cloud IP, TCP 9105 | Homebridge IP, port 9105 |
| SNAT (masquerade) | controller IP | Homebridge IP, TCP 9105 | router IP |

The SNAT rule is needed when the controller and Homebridge are on the same subnet. Without it the reply reaches the controller from an unexpected address and is dropped.

<details>
<summary>UniFi (Network 9.x)</summary>

*Settings → Routing → NAT*: create a *Destination NAT* and a *Source NAT* rule as in the table above.
</details>

<details>
<summary>OpenWrt / Linux iptables</summary>

```sh
iptables -t nat -A PREROUTING  -s <controller> -d <cloud> -p tcp --dport 9105 -j DNAT --to-destination <homebridge>:9105
iptables -t nat -A POSTROUTING -s <controller> -d <homebridge> -p tcp --dport 9105 -j MASQUERADE
```
</details>

<details>
<summary>MikroTik</summary>

```
/ip firewall nat add chain=dstnat src-address=<controller> dst-address=<cloud> protocol=tcp dst-port=9105 action=dst-nat to-addresses=<homebridge> to-ports=9105
/ip firewall nat add chain=srcnat src-address=<controller> dst-address=<homebridge> protocol=tcp dst-port=9105 action=masquerade
```
</details>

**Power-cycle the controller afterwards.** It keeps one long-lived TCP connection, so new rules only apply after it reconnects.

### 4. Configure

Start read-only, check that the log shows `State: {...}`, then set `readOnly` to `false`.

```json
{
  "platform": "RinnaiLocal",
  "name": "Rinnai Boiler",
  "mac": "",
  "readOnly": true,
  "cloudHost": "37.206.147.54"
}
```

| Option | Default | Meaning |
|---|---|---|
| `heatingName` / `hotWaterName` | `Heating` / `Hot Water` | Tile names. The Home app keeps the name it saw first, so changing it creates a new tile. |
| `mac` | empty (accept any) | Controller MAC, 12 hex digits. Printed in the log on first contact. |
| `readOnly` | `true` | Never send commands. |
| `powerSwitches` | `false` | Thermostats offer *Heat* only; on/off moves to separate switches `<name> Power`. Use this if Siri turns the boiler off when you say "turn off the AC": to Siri a thermostat is climate control too. |
| `cloudProxy` | `true` | Forward to the Rinnai cloud so My Rinnai keeps working. |
| `cloudHost` / `cloudPort` | `37.206.147.54` / `9105` | Cloud address. Use an IP, not a hostname. |
| `port` | `9105` | Local port the plugin listens on. |

### Checking

```sh
curl http://localhost:9105/health
```

returns `online`, the cloud status and the decoded state. A manual hot water setpoint test, accepted only from the Homebridge host itself:

```sh
curl -X POST 'http://localhost:9105/local/hw?t=50'
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Tiles show *No Response* | `curl localhost:9105/health`. `online: false` means the controller isn't reaching the plugin: check NAT rules and fixed IPs, then power-cycle the controller. |
| `Unknown request` in the log | Your firmware speaks a slightly different protocol. Please open an issue with the log line. |
| `Rinnai cloud unreachable` | Wrong `cloudHost`. HomeKit keeps working locally, My Rinnai won't. |
| Undo everything | Disable the NAT rules and power-cycle the controller. |

## Development

```sh
npm install
npm test
```

The test starts the plugin and a fake cloud on ports 19105–19107 and covers registration, state, commands, app priority, cloud failure and `powerSwitches`.

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, push, then create a GitHub release with tag `v<version>`. The *publish* workflow tests and publishes to npm via trusted publishing.

## Credits and disclaimer

Protocol from [sasamix/ha-rinnai-boiler](https://github.com/sasamix/ha-rinnai-boiler) and [mog422/open-rinnai-server](https://github.com/mog422/open-rinnai-server) (MIT).

This software controls a gas appliance and is not affiliated with or endorsed by Rinnai. Unknown bytes are never changed, but use it at your own risk.
