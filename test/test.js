const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const hap = require(process.env.HAP_PATH || '@homebridge/hap-nodejs');
const plugin = require('../index.js');
const { parsePacket, buildPacket, setByte } = plugin.__test;

let Platform;
const api = Object.assign(new EventEmitter(), {
  hap, platformAccessory: class { constructor(n, u) { this.acc = new hap.Accessory(n, u); }
    get UUID() { return this.acc.UUID; } getService(s) { return this.acc.getService(s); } getServiceById(s, id) { return this.acc.getServiceById(s, id); }
    addService(...a) { return this.acc.addService(...a); } removeService(s) { this.acc.removeService(s); } },
  registerPlatform: (_, __, c) => { Platform = c; }, registerPlatformAccessories() {}, unregisterPlatformAccessories() {},
});
plugin(api);
const log = Object.assign((...a) => console.log(...a), { info: console.log, warn: console.log, error: console.log, debug() {} });

const post = (port, path, body, headers = {}) => new Promise((res, rej) => {
  const r = http.request({ port, path, method: 'POST', headers }, (resp) => { let b = ''; resp.on('data', c => b += c); resp.on('end', () => res([resp.statusCode, b])); });
  r.on('error', rej); r.end(body);
});

(async () => {
  const data = '0d18183217a902ffff00' + '00'.repeat(66);
  const frame = buildPacket('re0101', 1, data);
  assert.deepStrictEqual(parsePacket(frame).data, data);
  assert(parsePacket(frame).checksumOk);

  let cloudMode = 'echo';
  const fake = http.createServer((req, res) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    if (cloudMode === 'down') return req.socket.destroy();
    let out = b;
    if (req.url === '/register') out = buildPacket('re0100', 0, 'f'.repeat(32));
    if (cloudMode === 'cmd') out = buildPacket('sm0101', 1, setByte(parsePacket(b).data, 1, 30));
    res.writeHead(200, {'Content-Type':'text/plain'}); res.end(out); }); }).listen(19106);
  const p = new Platform(log, { port: 19105, readOnly: false, cloudHost: '127.0.0.1', cloudPort: 19106 }, api);
  api.emit('didFinishLaunching');
  await new Promise(r => setTimeout(r, 200));
  const H = { Referer: 'aa:bb:cc:dd:ee:ff' };

  let [st, body] = await post(19105, '/register', buildPacket('re0000', 0, 'aabbccddeeff0001'));
  assert.strictEqual(st, 200); assert.strictEqual(body, buildPacket('re0100', 0, 'f'.repeat(32)), 'register from cloud');
  [st, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(st, 200); assert.strictEqual(body, frame);
  assert.strictEqual(p.state.roomSet, 24); assert.strictEqual(p.state.hwSet, 50); assert.strictEqual(p.state.roomCur, 23);
  assert.strictEqual(p.state.hwCur, 41.5);

  const C = hap.Characteristic;
  await p.heatService.getCharacteristic(C.TargetTemperature).handleSetRequest(25);
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(body, buildPacket('sm0101', 1, setByte(setByte(data, 1, 25), 2, 25)));

  await p.hwService.getCharacteristic(C.TargetTemperature).handleSetRequest(47);
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(parsePacket(body).data, setByte(data, 3, 47));

  await p.heatService.getCharacteristic(C.TargetHeatingCoolingState).handleSetRequest(0);
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(parsePacket(body).data.slice(0, 2), '09');

  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(body, frame, 'idle echoes');

  cloudMode = 'cmd';
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(parsePacket(body).data, setByte(data, 1, 30), 'app command passes through');
  await p.hwService.getCharacteristic(C.TargetTemperature).handleSetRequest(45);
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(parsePacket(body).data, setByte(data, 1, 30), 'app command wins, ours waits');
  cloudMode = 'echo';
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(parsePacket(body).data, setByte(data, 3, 45), 'our command next poll');
  cloudMode = 'down';
  [, body] = await post(19105, '/state', frame, H);
  assert.strictEqual(body, frame, 'cloud down: local echo');
  let [st2, b2] = await post(19105, '/weird', 'xyz', H);
  assert.strictEqual(st2, 404);
  cloudMode = 'echo';
  [st2, b2] = await post(19105, '/weird', 'xyz', H);
  assert.strictEqual(b2, 'xyz', 'unknown path proxied');
  // powerSwitches: термостаты без «выкл», питание — выключателями
  const q = new Platform(log, { port: 19107, readOnly: false, cloudProxy: false, powerSwitches: true }, api);
  api.emit("didFinishLaunching");
  await new Promise(r => setTimeout(r, 200));
  await post(19107, "/state", frame, H);
  assert.deepStrictEqual(q.hwService.getCharacteristic(C.TargetHeatingCoolingState).props.validValues, [C.TargetHeatingCoolingState.HEAT]);
  assert.strictEqual(await q.hwService.getCharacteristic(C.TargetHeatingCoolingState).handleGetRequest(), C.TargetHeatingCoolingState.HEAT);
  assert.strictEqual(await q.hwSwitch.getCharacteristic(C.On).handleGetRequest(), true);
  await q.hwSwitch.getCharacteristic(C.On).handleSetRequest(false);
  [, body] = await post(19107, "/state", frame, H);
  assert.strictEqual(parsePacket(body).data.slice(0, 2), "05", "hot water switch off");
  await q.heatSwitch.getCharacteristic(C.On).handleSetRequest(false);
  [, body] = await post(19107, "/state", frame, H);
  assert.strictEqual(parsePacket(body).data.slice(0, 2), "09", "heating switch off");

  p.readOnly = true;
  await assert.rejects(p.hwService.getCharacteristic(C.TargetTemperature).handleSetRequest(40));
  console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
