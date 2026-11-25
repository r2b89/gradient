/*
 * The trainer app's page half (trainer_web.c is the core's): window.GradientTrainer.start({canvas, base, demo, ...}) loads
 * trainer.js (WebAssembly), opens the core and runs it in the canvas: frames on change, touches, keys, the ☰ menu, files
 * and the browser's storage. See README.md.
 *   demo      the made-up ride (no Bluetooth), kept in memory only; else Web Bluetooth, kept in IndexedDB
 *   arcade    the demo with the arcade mode on (../c/arcade.h; arcade-music.js is its music)
 *   onMenu    ☰ or a long press: the page shows its menu (run(command), see COMMANDS)
 *   onToast   a line for the rider; onStatus: the sensors' state as a line
 */
(function () {
  const COMMANDS = {nextPage: 0, previousPage: 1, scan: 2, newRide: 3, nextStep: 4, harder: 5, easier: 6, stop: 7, view3d: 8,
    camera: 9, pacer: 10, pacerHarder: 11, pacerEasier: 12, arcade: 13, chaser: 14}; // trainer_core.h's trainer_command
  const DOWN = 0, UP = 1, CANCEL = 2, MOVE = 3;
  const SAVE_MS = 10000, LONG_PRESS_MS = 650, FLING_PX = 60, SLOW_PX = 10;

  const script = src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} can't be loaded`));
    document.head.appendChild(s);
  });

  async function start({canvas, base = '', demo = false, arcade = false, onMenu = () => {}, onToast = () => {}, onStatus = () => {}, onProgress = () => {}}) {
    await script(`${base}trainer.js`);
    let audio = null, music = null, dirty = true, closed = false, next = 0, frame = 0, timer = 0;
    const lines = [];

    const module = await window.createTrainer({
      locateFile: file => base + file,
      print: text => console.log(text),
      printErr: text => { lines.push(text); console.log(text); },
      setStatus: onProgress,
      onWake: () => wake(),
      onMessage: text => onToast(text),
      onMenu: () => onMenu(),
      onAdd: () => chooseFiles(),
      onShare: path => download(path),
      onBeep: () => beep(),
      onArcade: (phase, fear, event, moving) => arcadeMusic(phase, fear, event, !!moving)
    });
    if (!demo) module.ble = new window.TrainerBle(module, navigator.bluetooth);
    const text = (string, call) => {
      const at = module.stringToNewUTF8(string);
      try { return call(at); } finally { module._free(at); }
    };
    const words = at => (at ? module.UTF8ToString(at) : null);

    // ---- storage: /gradient, the browser's (IndexedDB), or memory for the demo
    const FS = module.FS, folder = '/gradient';
    FS.mkdir(folder);
    if (!demo) {
      FS.mount(module.IDBFS, {}, folder);
      await new Promise((resolve, reject) => FS.syncfs(true, e => (e ? reject(e) : resolve())));
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } else {
      FS.writeFile(`${folder}/trainer.conf`, 'ftp = 250\nweight = 72\nbike_weight = 8\nmax_hr = 185\ncamera = chase\npacer = 80\n');
    }
    let saving = null, again = false;
    const store = () => {
      if (demo) return Promise.resolve();
      if (saving) { again = true; return saving; }
      saving = new Promise(resolve => FS.syncfs(false, error => {
        saving = null;
        if (error) onToast("The browser can't save: your ride and settings may be lost when the page closes.");
        if (again) { again = false; store().then(resolve); } else resolve();
      }));
      return saving;
    };

    // ---- the core
    if (!text('#' + canvas.id, at => module._web_graphics(at))) throw new Error('This browser has no WebGL 2, which draws the app.');
    const args = demo ? `--simulate ${arcade ? '--arcade ' : ''}--workout /examples/routes/alpe-dhuez.csv` : '';
    const reason = text(args, a => text(folder, f => words(module._web_open(a, f))));
    if (reason) throw new Error(reason);
    if (demo) module._web_show_page(8); // the 3D road

    // ---- frames: when the core says (30 a second on the road, else once a second)
    const size = {width: 0, height: 0, density: 1};
    function resize() {
      const box = canvas.getBoundingClientRect();
      size.density = Math.min(window.devicePixelRatio || 1, 3);
      size.width = box.width;
      size.height = box.height;
      canvas.width = Math.max(1, Math.round(box.width * size.density));
      canvas.height = Math.max(1, Math.round(box.height * size.density));
      dirty = true;
      wake();
    }
    function step() {
      if (closed) return;
      const wait = module._web_update();
      next = performance.now() + Math.max(0, wait * 1000);
      const status = words(module._web_status());
      if (status !== null) onStatus(status);
      if (!document.hidden && (dirty || module._web_needs_draw())) {
        module._web_draw(canvas.width, canvas.height, size.density);
        dirty = false;
      }
      plan();
    }
    function plan() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (closed || document.hidden) return; // hidden: the worker's ticks
      const wait = next - performance.now();
      if (wait > 60) timer = setTimeout(step, wait);
      else frame = requestAnimationFrame(now => (performance.now() >= next - 4 ? step() : plan()));
    }
    // the sensors' news, a touch: soon (several at once make one step)
    function wake() {
      next = Math.min(next, performance.now());
      plan();
    }
    // a hidden tab's timers are held back to one a minute, a worker's messages aren't: the ride's seconds go on
    const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 500)'])));
    ticker.onmessage = () => { if (document.hidden && performance.now() >= next - 4) step(); };

    // ---- touches: to the display; a fling turns the page, a long press opens the menu (as the phone apps)
    let press = null;
    const at = event => {
      const box = canvas.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    const touch = (phase, [x, y]) => {
      module._web_touch(phase, x, y, size.width, size.height);
      dirty = true;
      wake();
    };
    const cancel = event => {
      if (!press) return;
      clearTimeout(press.hold);
      press = null;
      touch(CANCEL, at(event));
    };
    canvas.addEventListener('pointerdown', event => {
      if (press || event.button > 0) return;
      canvas.setPointerCapture(event.pointerId);
      const point = at(event);
      press = {id: event.pointerId, from: point, time: performance.now(), hold: setTimeout(() => { cancel(event); onMenu(); }, LONG_PRESS_MS)};
      touch(DOWN, point);
    });
    canvas.addEventListener('pointermove', event => {
      if (!press || event.pointerId !== press.id) return;
      const point = at(event);
      if (Math.hypot(point[0] - press.from[0], point[1] - press.from[1]) > SLOW_PX) clearTimeout(press.hold);
      touch(MOVE, point);
    });
    canvas.addEventListener('pointerup', event => {
      if (!press || event.pointerId !== press.id) return;
      const point = at(event), dx = point[0] - press.from[0], dy = point[1] - press.from[1];
      if (Math.abs(dx) >= FLING_PX && Math.abs(dx) > 1.5 * Math.abs(dy) && performance.now() - press.time < 500) {
        cancel(event);
        run(dx < 0 ? 'nextPage' : 'previousPage');
        return;
      }
      clearTimeout(press.hold);
      press = null;
      touch(UP, point);
      store();
    });
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      module._web_scroll(event.deltaY * 0.5);
      dirty = true;
      wake();
    }, {passive: false});

    // ---- keys, as the desktop's
    const KEYS = {Tab: 'nextPage', ArrowRight: 'nextPage', ArrowDown: 'nextPage', ArrowLeft: 'previousPage', ArrowUp: 'previousPage',
      s: 'scan', r: 'newRide', n: 'nextStep', v: 'view3d', c: 'camera', p: 'pacer', a: 'arcade', ']': 'pacerHarder', '[': 'pacerEasier',
      '=': 'harder', '+': 'harder', '-': 'easier'};
    window.addEventListener('keydown', event => {
      if (closed || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button, input, dialog[open]')) return;
      const command = KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (event.key.toLowerCase() === 'm') onMenu();
      else if (command) run(command);
      else return;
      event.preventDefault();
    });
    function run(command) {
      module._web_command(COMMANDS[command]);
      dirty = true;
      wake();
      store();
    }

    // ---- files: workouts and routes in (one is ridden, several are listed), rides out
    async function takeFiles(files) {
      let added = 0, failed = null;
      for (const file of files) {
        const path = `/tmp/${file.name.replace(/[/\\]/g, '_')}`;
        FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
        const why = text(path, p => words(files.length === 1 ? module._web_open_file(p) : module._web_add_file(p)));
        FS.unlink(path);
        if (why) failed = `${file.name}: ${why}`;
        else added++;
      }
      if (failed) onToast(failed);
      else if (files.length > 1) onToast(`Added ${added} workouts`);
      dirty = true;
      wake();
      store();
    }
    function chooseFiles() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.multiple = true;
      input.onchange = () => takeFiles([...input.files]);
      input.click();
    }
    window.addEventListener('dragover', event => event.preventDefault());
    window.addEventListener('drop', event => {
      event.preventDefault();
      if (event.dataTransfer.files.length) takeFiles([...event.dataTransfer.files]);
    });
    function download(path) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([FS.readFile(path)], {type: 'application/octet-stream'}));
      link.download = path.split('/').pop();
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    }
    const rides = () => {
      const path = words(module._web_rides_folder());
      try {
        return FS.readdir(path).filter(name => /\.fit$/i.test(name)).sort().map(name => `${path}/${name}`);
      } catch (error) {
        return [];
      }
    };

    // ---- sound and the screen: the page was opened with a tap, so both are allowed
    const sound = () => (audio = audio || new AudioContext());
    const MUTED = 'gradient-arcade-muted';
    let muted = false;
    try { muted = localStorage.getItem(MUTED) === '1'; } catch (error) { /* not kept */ }
    function arcadeMusic(phase, fear, event, moving) {
      if (!window.ArcadeMusic || (!music && !phase)) return;
      try {
        if (!music) {
          music = new window.ArcadeMusic(sound());
          music.muted = muted;
        }
        music.set({phase, fear, event, moving});
      } catch (error) { /* silent */ }
    }
    function muteArcade() {
      muted = !muted;
      try { localStorage.setItem(MUTED, muted ? '1' : '0'); } catch (error) { /* not kept */ }
      if (music) music.mute(muted);
      return muted;
    }
    // a browser that wants a tap before any sound
    for (const kind of ['pointerdown', 'keydown']) window.addEventListener(kind, () => { if (audio && audio.state === 'suspended') audio.resume(); });
    function beep() {
      try {
        sound();
        const tone = audio.createOscillator(), volume = audio.createGain();
        tone.frequency.value = 880;
        volume.gain.setValueAtTime(0.25, audio.currentTime);
        volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
        tone.connect(volume).connect(audio.destination);
        tone.start();
        tone.stop(audio.currentTime + 0.2);
      } catch (error) { /* silent */ }
    }
    let lock = null;
    const stayAwake = async () => {
      if (!navigator.wakeLock || document.hidden) return;
      try { lock = await navigator.wakeLock.request('screen'); } catch (error) { lock = null; }
    };
    stayAwake();

    // ---- the page hidden, shown, closed
    const saver = setInterval(store, SAVE_MS);
    document.addEventListener('visibilitychange', () => {
      if (closed) return;
      if (document.hidden) {
        module._web_save_ride();
        store();
      } else {
        stayAwake();
        dirty = true;
        wake();
      }
    });
    window.addEventListener('pagehide', () => { if (!closed) { module._web_save_ride(); store(); } });
    const ask = event => { if (!demo && !closed) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', ask);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      module._web_save_ride();
      store();
      onToast('The browser took the graphics away. Your ride is saved: reload the page to go on.');
    });
    new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize);
    resize();
    step();

    return {
      module, run, chooseFiles, rides, download, takeFiles,
      muteArcade, arcadeMuted: () => muted, music: () => music,
      // the rides with the arcade mode so far, the last one first
      arcadeRides() {
        try {
          return FS.readFile(`${folder}/arcade.csv`, {encoding: 'utf8'}).trim().split('\n').slice(1).reverse().map(line => {
            const [date, ride, ...n] = line.split(',');
            const [seconds, withYou, longest, caught, lost, shaken] = n.map(Number);
            return {date, ride, seconds, withYou, longest, caught, lost, shaken};
          });
        } catch (error) {
          return [];
        }
      },
      connect: () => module.ble && module.ble.scan(),
      async close() {
        module._web_arcade_end();
        module._web_save_ride();
        await store();
        closed = true;
        if (music) music.set({phase: 0});
        clearInterval(saver);
        ticker.terminate();
        if (lock) lock.release().catch(() => {});
      }
    };
  }

  window.GradientTrainer = {start, COMMANDS};
})();
