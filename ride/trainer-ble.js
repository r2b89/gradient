/*
 * The sensors over Web Bluetooth (sensors_ble_web.c parses what they send and decides what the trainer gets). Follows
 * Sensors.java (Android), with what a browser makes different:
 *  - No scanning: SCAN opens the browser's own dialog, one sensor at a time, and only from a tap.
 *  - What a sensor is shows once it's connected (its services); its signal isn't known.
 *  - A sensor that drops out is connected again while the page is open. After a reload it must be picked again, unless
 *    the browser keeps permissions (navigator.bluetooth.getDevices).
 * One GATT operation at a time per sensor (a second one fails), so they wait in a queue.
 */
(function () {
  const TRAINER = 0, HEART = 1, CADENCE = 2, POWER = 3;
  const SEARCHING = 0, CONNECTING = 1, CONNECTED = 2;
  const BIKE_DATA = 0, POWER_MEASUREMENT = 1, HEART_MEASUREMENT = 2, CSC_MEASUREMENT = 3, CONTROL_POINT = 4;
  const FTMS = 0x1826, CPS = 0x1818, HRS = 0x180d, CSC = 0x1816, FEC = '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e';
  const BIKE_DATA_ID = 0x2ad2, CONTROL_ID = 0x2ad9, POWER_ID = 0x2a63, HEART_ID = 0x2a37, CSC_ID = 0x2a5b;
  const FEC_WRITE = '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e';
  const ROLE_OF = {T: TRAINER, H: HEART, C: CADENCE, P: POWER};
  const RETRY_SECONDS = [1, 2, 5, 10, 20];
  const REMEMBERED = 'gradient-sensors';
  const CONTROL_BYTES = 13;

  class TrainerBle {
    constructor(module, bluetooth) {
      this.module = module;
      this.bluetooth = bluetooth;
      this.links = new Map(); // by device id: {device, name, kind, role, state, queue, attempt}
      this.roles = [null, null, null, null]; // the device ids
      this.control = null; // {link, characteristic, fec}
      this.choosing = false;
    }

    // ---- sensors_source (called by the core)

    start() {
      if (!this.bluetooth) return false;
      setInterval(() => this.pump(), 1000);
      this.restore();
      this.module._web_sensor_scanning(0);
      return true;
    }

    // the browser's dialog, for one sensor: must be called from a tap
    async scan() {
      if (this.choosing) return;
      this.choosing = true;
      this.module._web_sensor_scanning(1);
      try {
        const device = await this.bluetooth.requestDevice({
          filters: [{services: [FTMS]}, {services: [CPS]}, {services: [HRS]}, {services: [CSC]}],
          optionalServices: [FTMS, CPS, HRS, CSC, FEC]
        });
        await this.connect(device);
      } catch (error) {
        if (error.name !== 'NotFoundError') this.say(`Bluetooth: ${error.message}`); // NotFoundError: the dialog was closed
      } finally {
        this.choosing = false;
        this.module._web_sensor_scanning(0);
      }
    }

    // a row tapped: connects it, or disconnects it
    select(id) {
      const link = this.links.get(id);
      if (!link) return;
      if (link.state === 'A') this.connect(link.device);
      else this.release(link);
    }

    // writes what the trainer's control point needs now (a request, the target; FE-C: each page that changed)
    pump() {
      const control = this.control;
      if (!control || control.link.state !== 'C' || control.link.waiting > 0) return; // the next ask takes the newest target
      const m = this.module, buffer = m._malloc(CONTROL_BYTES);
      for (let n; (n = m._web_control_next(buffer)) > 0;) {
        const bytes = m.HEAPU8.slice(buffer, buffer + n), c = control.characteristic;
        this.queue(control.link, () => (c.properties.write ? c.writeValueWithResponse(bytes) : c.writeValueWithoutResponse(bytes)))
          .catch(() => {}); // written again in 3 s (ftms_control.c)
        if (!control.fec) break; // FTMS: one at a time, the next after its response
      }
      m._free(buffer);
    }

    // ---- connections

    linkFor(device) {
      let link = this.links.get(device.id);
      if (!link) {
        link = {device, name: device.name || 'Sensor', kind: '', role: -1, state: 'A', chain: Promise.resolve(), waiting: 0, attempt: 0};
        this.links.set(device.id, link);
        device.addEventListener('gattserverdisconnected', () => this.lost(link));
      }
      return link;
    }

    async connect(device) {
      const link = this.linkFor(device);
      if (link.state !== 'A') return;
      link.state = 'W';
      link.wanted = true;
      this.report();
      await this.open(link);
    }

    async open(link) {
      try {
        const server = await link.device.gatt.connect();
        if (!link.wanted) return server.disconnect();
        link.chain = Promise.resolve();
        link.waiting = 0;
        const services = new Map();
        for (const service of await server.getPrimaryServices()) services.set(service.uuid, service);
        if (!link.wanted) return server.disconnect();
        await this.ready(link, services);
        link.attempt = 0;
      } catch (error) {
        if (!link.wanted) return;
        if (link.role < 0) { // the first connection: told, and let go
          this.say(`Bluetooth: ${link.name} can't be connected (${error.message})`);
          this.release(link);
        } else {
          // half connected: dropped, so the next try starts clean
          if (link.device.gatt.connected) link.device.gatt.disconnect(); // → lost(), which tries again
          else this.retry(link);
        }
      }
    }

    // its services: what it is, the role it takes, its notifications on
    async ready(link, services) {
      const service = id => services.get(typeof id === 'number' ? BluetoothUUID.getService(id) : id);
      const ftms = service(FTMS), cps = service(CPS), hrs = service(HRS), csc = service(CSC), fec = service(FEC);
      link.kind = ftms || fec ? 'T' : cps ? 'P' : hrs ? 'H' : csc ? 'C' : '';
      if (!link.kind) throw new Error('not a trainer, power meter, heart rate monitor or cadence sensor');
      const role = ROLE_OF[link.kind], held = this.links.get(this.roles[role]);
      if (held && held !== link) this.release(held); // one of each
      link.role = role;
      this.roles[role] = link.device.id;
      this.module._web_sensor_reset(role);
      if (role === TRAINER) this.loseControl();
      this.status(role, CONNECTING, link.name);
      let source;
      if (role === TRAINER) {
        if (ftms) {
          await this.listen(link, ftms, BIKE_DATA_ID, BIKE_DATA);
          source = 'Fitness Machine';
        } else if (cps) {
          await this.listen(link, cps, POWER_ID, POWER_MEASUREMENT);
          source = 'Cycling Power';
        } else {
          throw new Error('it offers neither the Fitness Machine nor the Cycling Power service');
        }
      } else if (role === POWER) {
        await this.listen(link, cps, POWER_ID, POWER_MEASUREMENT);
        source = 'Cycling Power';
      } else if (role === HEART) {
        await this.listen(link, hrs, HEART_ID, HEART_MEASUREMENT);
        source = 'Heart Rate';
      } else {
        await this.listen(link, csc, CSC_ID, CSC_MEASUREMENT);
        source = 'Speed and Cadence';
      }
      link.state = 'C';
      this.status(role, CONNECTED, `${link.name} (${source})`);
      this.remember();
      this.report();
      if (role === TRAINER) await this.takeControl(link, ftms, fec);
    }

    async takeControl(link, ftms, fec) {
      try {
        if (ftms) {
          const c = await this.listen(link, ftms, CONTROL_ID, CONTROL_POINT);
          this.control = {link, characteristic: c, fec: false};
          this.module._web_control_ready(0);
        } else if (fec) {
          this.control = {link, characteristic: await this.queue(link, () => fec.getCharacteristic(FEC_WRITE)), fec: true};
          this.module._web_control_ready(1);
        } else {
          throw new Error('it offers neither FTMS nor FE-C');
        }
        this.pump();
      } catch (error) {
        this.say(`Workouts can't set that trainer's resistance: ${error.message}`);
      }
    }

    async listen(link, service, id, which) {
      const c = await this.queue(link, () => service.getCharacteristic(id));
      c.addEventListener('characteristicvaluechanged', event => {
        if (link.role < 0 || this.roles[link.role] !== link.device.id) return;
        const view = event.target.value, m = this.module, n = view.byteLength, at = m._malloc(n || 1);
        m.HEAPU8.set(new Uint8Array(view.buffer, view.byteOffset, n), at);
        m._web_sensor_value(link.role, which, at, n);
        m._free(at);
        if (which === CONTROL_POINT) this.pump(); // the next command, after this response
      });
      await this.queue(link, () => c.startNotifications());
      return c;
    }

    // one operation at a time
    queue(link, operation) {
      link.waiting++;
      const done = link.chain.then(operation);
      link.chain = done.catch(() => {}).then(() => { link.waiting--; });
      return done;
    }

    // disconnected, not on purpose: again until it's back
    lost(link) {
      if (!link.wanted || link.role < 0) {
        if (link.state !== 'A') this.release(link);
        return;
      }
      this.module._web_sensor_reset(link.role);
      if (link.role === TRAINER) this.loseControl();
      this.retry(link);
    }

    retry(link) {
      link.state = 'W';
      this.status(link.role, CONNECTING, link.name);
      this.report();
      const wait = RETRY_SECONDS[Math.min(link.attempt++, RETRY_SECONDS.length - 1)];
      clearTimeout(link.timer);
      link.timer = setTimeout(() => { if (link.wanted) this.open(link); }, wait * 1000);
    }

    release(link) {
      link.wanted = false;
      link.state = 'A';
      clearTimeout(link.timer);
      const role = link.role;
      link.role = -1;
      if (role >= 0 && this.roles[role] === link.device.id) {
        this.roles[role] = null;
        this.module._web_sensor_reset(role);
        if (role === TRAINER) this.loseControl();
        this.status(role, SEARCHING, '');
      }
      if (link.device.gatt.connected) link.device.gatt.disconnect();
      this.remember();
      this.report();
    }

    loseControl() {
      this.control = null;
      this.module._web_control_reset();
    }

    // ---- remembered sensors (only where the browser keeps the permission)

    remember() {
      try {
        localStorage.setItem(REMEMBERED, JSON.stringify(this.roles.filter(Boolean)));
      } catch (error) { /* private window: not kept */ }
    }

    async restore() {
      if (!this.bluetooth.getDevices) return;
      try {
        const ids = JSON.parse(localStorage.getItem(REMEMBERED) || '[]');
        for (const device of await this.bluetooth.getDevices()) if (ids.includes(device.id)) this.connect(device);
      } catch (error) { /* none */ }
    }

    // ---- reports to the core

    text(string, call) {
      const at = this.module.stringToNewUTF8(string);
      try { return call(at); } finally { this.module._free(at); }
    }
    say(string) { this.text(string, at => this.module._web_sensor_message(at)); }
    status(role, state, name) { this.text(name, at => this.module._web_sensor_status(role, state, at)); }

    report() {
      const m = this.module, order = {C: 0, W: 1, A: 2};
      m._web_sensor_list();
      for (const link of [...this.links.values()].sort((a, b) => order[a.state] - order[b.state])) {
        this.text(link.device.id, id => this.text(link.name, name => m._web_sensor_listed(id, name,
          (link.kind || 'T').charCodeAt(0), link.state.charCodeAt(0), link.state === 'C' ? 4 : 0)));
      }
      m._web_sensor_list_end();
    }
  }

  window.TrainerBle = TrainerBle;
})();
