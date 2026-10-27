'use strict';

// Local server for the Rinnai WF-100W Wi-Fi controller, sitting between the
// controller and the Rinnai cloud. Protocol from
// https://github.com/sasamix/ha-rinnai-boiler (MIT).
//
// Packet: <prefix 6><command 2><length 2><hex data><checksum 2>7d
// Commands go to the controller in the reply to its /state poll: only the
// bytes we need are patched in the state it just sent, the rest is echoed
// back verbatim.

const http = require('http');

const PLUGIN_NAME = 'homebridge-rinnai-local';
const PLATFORM_NAME = 'RinnaiLocal';

const ETX = '7d';
const REGISTER_PREFIX = 're0000';
const REGISTER_REPLY_PREFIX = 're0100';
const STATE_PREFIX = 're0101';
const COMMAND_REPLY_PREFIX = 'sm0101';

const FLAG_POWER = 0x01;
const FLAG_CIRCUIT_MODE = 0x02;
const FLAG_HEATING = 0x04;
const FLAG_HOT_WATER = 0x08;

const IDX_FLAGS = 0;
const IDX_ROOM_SET = 1;
const IDX_CIRCUIT_SET = 2;
const IDX_HW_SET = 3;
const IDX_ROOM_CUR = 4;
const IDX_WATER_CUR = 5;
const IDX_DRIVE = 6;
const IDX_ERROR = 7;
const IDX_AWAY = 9;

const ROOM_MIN = 10, ROOM_MAX = 40;
const CIRCUIT_MIN = 40, CIRCUIT_MAX = 80;
const HW_MIN = 35, HW_MAX = 60;

const ONLINE_TIMEOUT_MS = 30000;
const COMMAND_TTL_MS = 30000;

// ---------- protocol ----------

const checksum = (data) => [...data].reduce((s, c) => s + c.charCodeAt(0), 0) % 256;
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');

function parsePacket(raw) {
  raw = raw.trim();
  if (raw.length < 14 || !raw.endsWith(ETX)) throw new Error('bad framing');
  const prefix = raw.slice(0, 6);
  const command = parseInt(raw.slice(6, 8), 16);
  const length = parseInt(raw.slice(8, 10), 16);
  if (Number.isNaN(command) || Number.isNaN(length)) throw new Error('unreadable header');
  if (length % 2 || raw.length !== 10 + length + 4) throw new Error('length does not match header');
  const data = raw.slice(10, 10 + length);
  if (!/^[0-9a-fA-F]*$/.test(data)) throw new Error('data is not hex');
  const checksumOk = raw.slice(10 + length, -2).toLowerCase() === hex2(checksum(data));
  return { prefix, command, data, checksumOk };
}

const buildPacket = (prefix, command, data) =>
  `${prefix}${hex2(command)}${hex2(data.length)}${data}${hex2(checksum(data))}${ETX}`;

const byteAt = (data, i) => parseInt(data.slice(i * 2, i * 2 + 2), 16);

function setByte(data, i, value) {
  if (i * 2 + 2 > data.length) throw new Error(`byte ${i} is out of range`);
  return data.slice(0, i * 2) + hex2(value) + data.slice(i * 2 + 2);
}

// The high bit means +0.5 °C.
const halfDegree = (v) => (v & 0x80 ? (v & 0x7f) + 0.5 : v);

function decodeState(data) {
  if (data.length < 20) throw new Error('state data is too short');
  const flags = byteAt(data, IDX_FLAGS);
  const drive = byteAt(data, IDX_DRIVE);
  const error = data.slice(IDX_ERROR * 2, IDX_ERROR * 2 + 4).toLowerCase();
  return {
    flags,
    power: !!(flags & FLAG_POWER),
    circuitMode: !!(flags & FLAG_CIRCUIT_MODE),
    heating: !!(flags & FLAG_HEATING),
    hotWater: !!(flags & FLAG_HOT_WATER),
    roomSet: byteAt(data, IDX_ROOM_SET),
    circuitSet: byteAt(data, IDX_CIRCUIT_SET),
    hwSet: halfDegree(byteAt(data, IDX_HW_SET)),
    roomCur: byteAt(data, IDX_ROOM_CUR),
    hwCur: halfDegree(byteAt(data, IDX_WATER_CUR)),
    combustion: drive & 0x0f,
    hotWaterUsing: !!(drive & 0x20),
    away: byteAt(data, IDX_AWAY) > 0,
    errorCode: error === 'ffff' ? null : error,
  };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const normMac = (s) => (s || '').toLowerCase().replace(/[^0-9a-f]/g, '');

// ---------- platform ----------

class RinnaiLocalPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.port = this.config.port || 9105;
    this.mac = normMac(this.config.mac);
    this.readOnly = this.config.readOnly !== false;
    // Forward the controller to the real cloud so the My Rinnai app keeps working.
    // Use an IP, not a hostname: the hostname may be redirected to this plugin.
    // EU controllers talk to 37.206.147.54, Korean ones to wifiboilers1.rinnai.co.kr.
    this.cloudProxy = this.config.cloudProxy !== false;
    this.cloudHost = this.config.cloudHost || '37.206.147.54';
    this.cloudPort = this.config.cloudPort || 9105;
    this.accessories = new Map();
    this.state = null;
    this.rawData = null;
    this.lastSeen = 0;
    this.pending = [];

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.HapStatusError = api.hap.HapStatusError;
    this.HAPStatus = api.hap.HAPStatus;

    api.on('didFinishLaunching', () => {
      this.setupAccessory();
      this.startServer();
      setInterval(() => this.refreshAvailability(), 10000);
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  get online() {
    return this.state !== null && Date.now() - this.lastSeen < ONLINE_TIMEOUT_MS;
  }

  // ---------- HTTP server for the controller ----------

  startServer() {
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('latin1');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) req.destroy();
      });
      req.on('end', () => {
        try {
          this.handle(req, body, res).catch((err) => {
            this.log.error('Failed to handle controller request:', err.message);
            if (!res.headersSent) this.reply(res, 500, '');
          });
        } catch (err) {
          this.log.error('Failed to handle controller request:', err.message);
          this.reply(res, 500, '');
        }
      });
    });
    server.on('error', (err) => this.log.error(`Could not listen on port ${this.port}: ${err.message}`));
    server.listen(this.port, '0.0.0.0', () => {
      this.log.info(`Waiting for the Rinnai controller on port ${this.port}` + (this.readOnly ? ' (read-only)' : '') +
        (this.cloudProxy ? `, forwarding to cloud ${this.cloudHost}:${this.cloudPort}` : ''));
    });
  }

  reply(res, status, text, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text, 'latin1') });
    res.end(text, 'latin1');
  }

  // Forward the controller request to the real Rinnai cloud. null = cloud unreachable.
  forward(req, body) {
    if (!this.cloudProxy) return Promise.resolve(null);
    return new Promise((resolve) => {
      const payload = Buffer.from(body, 'latin1');
      const headers = { ...req.headers, 'content-length': payload.length };
      const r = http.request({
        host: this.cloudHost, port: this.cloudPort, method: req.method, path: req.url, headers, timeout: 8000,
      }, (resp) => {
        let b = '';
        resp.setEncoding('latin1');
        resp.on('data', (c) => { b += c; });
        resp.on('end', () => resolve({ status: resp.statusCode, contentType: resp.headers['content-type'], body: b }));
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', (err) => {
        if (!this.cloudDown) this.log.warn(`Rinnai cloud unreachable (${err.message}), answering the controller locally`);
        this.cloudDown = true;
        resolve(null);
      });
      r.end(payload);
    }).then((cloud) => {
      if (cloud && this.cloudDown) {
        this.cloudDown = false;
        this.log.info('Rinnai cloud is reachable again');
      }
      return cloud;
    });
  }

  passThrough(res, cloud) {
    this.reply(res, cloud.status, cloud.body, cloud.contentType || 'text/plain; charset=utf-8');
  }

  async handle(req, body, res) {
    const path = (req.url || '').split('?')[0];
    const from = req.socket.remoteAddress;

    if (req.method === 'GET' && path === '/health') {
      return this.reply(res, 200, JSON.stringify({
        online: this.online, mac: this.mac || null, readOnly: this.readOnly,
        cloudProxy: this.cloudProxy, cloudDown: !!this.cloudDown, state: this.state,
      }));
    }

    // Manual test from this machine only: POST /local/hw?t=51
    if (req.method === 'POST' && path === '/local/hw' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from)) {
      const t = Number(new URL(req.url, 'http://x').searchParams.get('t'));
      if (!Number.isInteger(t) || t < HW_MIN || t > HW_MAX) return this.reply(res, 400, 'bad t');
      try {
        this.queue((d) => setByte(d, IDX_HW_SET, t));
      } catch (err) {
        return this.reply(res, 409, 'not sent');
      }
      return this.reply(res, 200, 'queued');
    }

    const cloud = await this.forward(req, body);
    if (req.method === 'POST' && path === '/register') return this.handleRegister(body.trim(), from, res, cloud);
    if (req.method === 'POST' && path === '/state') return this.handleState(req, body.trim(), from, res, cloud);

    // Unknown request: other firmware may differ, so log everything.
    this.log.warn(`Unknown request from ${from}: ${req.method} ${req.url} ` +
      `headers=${JSON.stringify(req.headers)} body=${JSON.stringify(body)}` +
      (cloud ? ` -> cloud ${cloud.status} ${JSON.stringify(cloud.body)}` : ''));
    if (cloud) return this.passThrough(res, cloud);
    this.reply(res, 404, '');
  }

  handleRegister(body, from, res, cloud) {
    this.log.info(`/register from ${from}: ${body}` + (cloud ? ` -> cloud ${cloud.status} ${cloud.body}` : ''));
    let packet;
    try {
      packet = parsePacket(body);
    } catch (err) {
      this.log.warn(`Unrecognized /register (${err.message})`);
      return cloud ? this.passThrough(res, cloud) : this.reply(res, 400, '');
    }
    if (packet.prefix !== REGISTER_PREFIX || !packet.checksumOk) {
      this.log.warn('Unexpected /register: prefix or checksum');
      return cloud ? this.passThrough(res, cloud) : this.reply(res, 400, '');
    }
    const mac = packet.data.slice(0, 12).toLowerCase();
    if (this.mac && mac !== this.mac) {
      this.log.warn(`Rejected /register from unknown controller ${mac}`);
      return this.reply(res, 403, '');
    }
    this.log.info(`Controller registered: MAC ${mac}, data ${packet.data}`);
    if (cloud && cloud.status === 200) return this.passThrough(res, cloud);
    this.reply(res, 200, buildPacket(REGISTER_REPLY_PREFIX, packet.command, '1'.repeat(32)));
  }

  handleState(req, body, from, res, cloud) {
    const referer = normMac(req.headers.referer);
    if (this.mac && referer !== this.mac) {
      this.log.warn(`Rejected /state from ${from}: Referer ${req.headers.referer}`);
      return this.reply(res, 403, '');
    }
    let packet, state;
    try {
      packet = parsePacket(body);
      if (packet.prefix !== STATE_PREFIX || packet.command !== 1 || !packet.checksumOk) {
        throw new Error('unexpected prefix, command or checksum');
      }
      state = decodeState(packet.data);
    } catch (err) {
      this.log.warn(`Unrecognized /state from ${from} (${err.message}): ${body}` +
        (cloud ? ` -> cloud ${cloud.status} ${cloud.body}` : ''));
      return cloud ? this.passThrough(res, cloud) : this.reply(res, 400, '');
    }

    if (!this.state) this.log.info(`Controller online (MAC from Referer: ${referer || 'none'})`);
    // The packet carries a clock and counters, so only log changes of the decoded fields.
    const summary = JSON.stringify(state);
    if (summary !== this.lastSummary) {
      this.log.info(`State: ${summary}`);
      this.log.debug(`Raw data: ${packet.data}`);
      this.lastSummary = summary;
    }
    this.state = state;
    this.rawData = packet.data;
    this.lastSeen = Date.now();
    this.updateCharacteristics();

    // A command from the My Rinnai app: pass it through as is and keep ours
    // for the next poll.
    const cloudOk = cloud && cloud.status === 200;
    if (cloudOk && cloud.body.trim().startsWith(COMMAND_REPLY_PREFIX)) {
      this.log.info(`Command from app: ${cloud.body.trim()}`);
      return this.passThrough(res, cloud);
    }

    let data = packet.data;
    if (this.pending.length) {
      const pending = this.pending;
      this.pending = [];
      for (const { deadline, patch } of pending) {
        if (Date.now() > deadline) {
          this.log.warn('Dropped expired command');
          continue;
        }
        try {
          data = patch(data);
        } catch (err) {
          this.log.error(`Skipped command: ${err.message}`);
        }
      }
    }
    if (data !== packet.data) {
      // The controller only applies changes from a packet with this prefix.
      this.log.info(`Command to controller: ${packet.data} -> ${data}`);
      return this.reply(res, 200, buildPacket(COMMAND_REPLY_PREFIX, packet.command, data));
    }
    if (cloudOk) return this.passThrough(res, cloud);
    this.reply(res, 200, buildPacket(packet.prefix, packet.command, data));
  }

  // ---------- commands ----------

  queue(patch) {
    if (this.readOnly) {
      this.log.warn('Read-only mode: command not sent');
      throw new this.HapStatusError(this.HAPStatus.READ_ONLY_CHARACTERISTIC);
    }
    if (!this.online) {
      this.log.warn('Controller offline: command not sent');
      throw new this.HapStatusError(this.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.pending.push({ deadline: Date.now() + COMMAND_TTL_MS, patch });
  }

  updateFlags(setBits, clearBits) {
    this.queue((d) => setByte(d, IDX_FLAGS, (byteAt(d, IDX_FLAGS) | setBits) & ~clearBits & 0xff));
  }

  setSetpoint(index, value) {
    // The active setpoint is mirrored in bytes 1 and 2; patch the mirror only
    // if they match and this is the active mode's setpoint.
    this.queue((d) => {
      const active = byteAt(d, IDX_FLAGS) & FLAG_CIRCUIT_MODE ? IDX_CIRCUIT_SET : IDX_ROOM_SET;
      const mirrored = byteAt(d, IDX_ROOM_SET) === byteAt(d, IDX_CIRCUIT_SET);
      let out = setByte(d, index, value);
      if (index === active && mirrored) out = setByte(out, 3 - index, value);
      return out;
    });
  }

  // ---------- HomeKit ----------

  require() {
    if (!this.online) throw new this.HapStatusError(this.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return this.state;
  }

  setupAccessory() {
    const { Service, Characteristic: C } = this;
    // Heating and hot water are separate accessories, otherwise the Home app
    // merges them into one tile.
    const wanted = new Set();
    const ensure = (key, name, legacyName) => {
      // The Home app keeps the name it saw when the accessory was added, so a
      // new name gets a new UUID. The original Russian default keeps the old UUID.
      const uuid = this.api.hap.uuid.generate(name === legacyName ? `rinnai-local-${key}` : `rinnai-local-${key}:${name}`);
      wanted.add(uuid);
      let acc = this.accessories.get(uuid);
      if (!acc) {
        acc = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.accessories.set(uuid, acc);
      }
      acc.getService(Service.AccessoryInformation)
        .setCharacteristic(C.Manufacturer, 'Rinnai')
        .setCharacteristic(C.Model, 'WF-100W')
        .setCharacteristic(C.SerialNumber, `${this.mac || 'unknown'}-${key}`);
      const svc = acc.getService(Service.Thermostat) || acc.addService(Service.Thermostat, name);
      svc.platformAccessory = acc;
      return svc;
    };

    // powerSwitches: thermostats offer HEAT only and on/off lives on a separate
    // switch. Otherwise Siri's "turn off the AC" turns the boiler off: to Siri a
    // thermostat is climate control just like an air conditioner.
    const sw = this.config.powerSwitches === true;
    const modes = sw
      ? [C.TargetHeatingCoolingState.HEAT]
      : [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.HEAT];
    const powerSwitch = (svc, name, flag) => {
      const acc = svc.platformAccessory;
      const old = acc.getServiceById(Service.Switch, 'power');
      if (!sw) {
        if (old) acc.removeService(old);
        return null;
      }
      const s = old || acc.addService(Service.Switch, `${name} Power`, 'power');
      s.getCharacteristic(C.On)
        .onGet(() => { const st = this.require(); return st.power && (st.flags & flag) !== 0; })
        .onSet((v) => (v ? this.updateFlags(FLAG_POWER | flag, 0) : this.updateFlags(0, flag)));
      return s;
    };

    // Heating
    const heatName = this.config.heatingName || 'Heating';
    const heat = ensure('heating', heatName, 'Отопление');
    this.heatService = heat;
    this.heatSwitch = powerSwitch(heat, heatName, FLAG_HEATING);
    heat.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: modes })
      .onGet(() => this.heatTargetMode())
      .onSet((v) => {
        if (v === C.TargetHeatingCoolingState.HEAT) this.updateFlags(FLAG_POWER | FLAG_HEATING, 0);
        else this.updateFlags(0, FLAG_HEATING);
      });
    heat.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => this.heatCurrentMode());
    heat.getCharacteristic(C.CurrentTemperature).onGet(() => this.require().roomCur);
    heat.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: ROOM_MIN, maxValue: ROOM_MAX, minStep: 1 })
      .onGet(() => this.heatTarget())
      .onSet((v) => {
        const s = this.require();
        if (s.circuitMode) this.setSetpoint(IDX_CIRCUIT_SET, clamp(Math.round(v), CIRCUIT_MIN, CIRCUIT_MAX));
        else this.setSetpoint(IDX_ROOM_SET, clamp(Math.round(v), ROOM_MIN, ROOM_MAX));
      });
    heat.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);

    // Hot water
    const hwName = this.config.hotWaterName || 'Hot Water';
    const hw = ensure('hotwater', hwName, 'Горячая вода');
    this.hwService = hw;
    this.hwSwitch = powerSwitch(hw, hwName, FLAG_HOT_WATER);
    hw.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: modes })
      .onGet(() => this.hwTargetMode())
      .onSet((v) => {
        if (v === C.TargetHeatingCoolingState.HEAT) this.updateFlags(FLAG_POWER | FLAG_HOT_WATER, 0);
        else this.updateFlags(0, FLAG_HOT_WATER);
      });
    hw.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => this.hwCurrentMode());
    hw.getCharacteristic(C.CurrentTemperature).onGet(() => this.require().hwCur);
    hw.getCharacteristic(C.TargetTemperature)
      .updateValue(HW_MIN)
      .setProps({ minValue: HW_MIN, maxValue: HW_MAX, minStep: 1 })
      .onGet(() => clamp(this.require().hwSet, HW_MIN, HW_MAX))
      .onSet((v) => this.queue((d) => setByte(d, IDX_HW_SET, clamp(Math.round(v), HW_MIN, HW_MAX))));
    hw.getCharacteristic(C.TemperatureDisplayUnits).onGet(() => C.TemperatureDisplayUnits.CELSIUS);

    this.removeStale(wanted);
  }

  removeStale(wanted) {
    const stale = [...this.accessories.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.accessories.delete(a.UUID));
    }
  }

  heatTargetMode() {
    const s = this.require();
    const T = this.Characteristic.TargetHeatingCoolingState;
    if (this.config.powerSwitches === true) return T.HEAT;
    return s.power && s.heating ? T.HEAT : T.OFF;
  }

  heatCurrentMode() {
    const s = this.require();
    const C = this.Characteristic.CurrentHeatingCoolingState;
    return s.power && s.heating && s.combustion && !s.hotWaterUsing ? C.HEAT : C.OFF;
  }

  heatTarget() {
    const s = this.require();
    return s.circuitMode
      ? clamp(s.circuitSet, CIRCUIT_MIN, CIRCUIT_MAX)
      : clamp(s.roomSet, ROOM_MIN, ROOM_MAX);
  }

  hwTargetMode() {
    const s = this.require();
    const T = this.Characteristic.TargetHeatingCoolingState;
    if (this.config.powerSwitches === true) return T.HEAT;
    return s.power && s.hotWater ? T.HEAT : T.OFF;
  }

  hwCurrentMode() {
    const s = this.require();
    const C = this.Characteristic.CurrentHeatingCoolingState;
    return s.combustion && s.hotWaterUsing ? C.HEAT : C.OFF;
  }

  updateCharacteristics() {
    if (!this.heatService || !this.online) return;
    const C = this.Characteristic;
    const s = this.state;
    // The heating setpoint range depends on the mode: room air or flow water.
    const max = s.circuitMode ? CIRCUIT_MAX : ROOM_MAX;
    const target = this.heatService.getCharacteristic(C.TargetTemperature);
    if (target.props.maxValue !== max) {
      target.setProps({ minValue: s.circuitMode ? CIRCUIT_MIN : ROOM_MIN, maxValue: max });
    }
    this.heatService.updateCharacteristic(C.TargetHeatingCoolingState, this.heatTargetMode());
    this.heatService.updateCharacteristic(C.CurrentHeatingCoolingState, this.heatCurrentMode());
    this.heatService.updateCharacteristic(C.CurrentTemperature, s.roomCur);
    this.heatService.updateCharacteristic(C.TargetTemperature, this.heatTarget());
    this.hwService.updateCharacteristic(C.TargetHeatingCoolingState, this.hwTargetMode());
    this.hwService.updateCharacteristic(C.CurrentHeatingCoolingState, this.hwCurrentMode());
    this.hwService.updateCharacteristic(C.CurrentTemperature, s.hwCur);
    this.hwService.updateCharacteristic(C.TargetTemperature, clamp(s.hwSet, HW_MIN, HW_MAX));
    if (this.heatSwitch) this.heatSwitch.updateCharacteristic(C.On, s.power && s.heating);
    if (this.hwSwitch) this.hwSwitch.updateCharacteristic(C.On, s.power && s.hotWater);
  }

  refreshAvailability() {
    if (this.state && !this.online && !this.warnedOffline) {
      this.warnedOffline = true;
      this.log.warn('Controller has not polled for more than 30 seconds');
    } else if (this.online) {
      this.warnedOffline = false;
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, RinnaiLocalPlatform);
};
module.exports.__test = { parsePacket, buildPacket, decodeState, setByte, checksum };
