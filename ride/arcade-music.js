/*
 * The arcade mode's music (../c/arcade.h), made as it plays in the way of an 8-bit console's sound chip: two pulse voices,
 * a triangle in 16 steps, noise from a shift register. Original tunes, in E minor:
 *   lurking   a bouncing tune that isn't quite at ease, then a rest with only a soft pulse (an hour of it must be bearable)
 *   hunting   a bass on semitones and an alarm on the tritone, faster the nearer she is
 *   with you  the scary part: a heartbeat, a drone with the tritone against it, a siren that climbs, and her voice as
 *             blips, talking without a pause
 * and a sting for each event: seen by the road, the hunt, caught, away.
 *   const music = new ArcadeMusic(audioContext); music.set({phase, fear, event, moving}) each second; music.mute(on)
 * Works on an OfflineAudioContext too (music.render(seconds)), for its test.
 */
(function () {
  const OFF = 0, LURK = 1, HUNT = 2, WITH = 3;
  const GLIMPSE = 1, HUNTED = 2, CAUGHT = 3, LOST = 4, SHAKEN = 5;
  const NAMES = {C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2};
  const hz = note => 440 * 2 ** ((NAMES[note[0]] + (note[1] === '#' ? 1 : 0) + (note[note.length - 1] - 4) * 12) / 12);

  // the lurking tune: eight bars of eighths (- rests), the bass under them
  const TUNE = ('E5 - G5 - B5 - A5 G5 | E5 - - C5 - E5 G5 - | A4 - C5 - E5 - D5 C5 | B4 - D#5 - F#5 - - - | ' +
                'E5 - G5 - B5 - C6 B5 | A5 - - G5 - E5 C5 - | F5 - E5 - C5 - A4 - | B4 - - A#4 B4 - - -').replace(/\|/g, '').split(/\s+/);
  const CHORDS = [['E3', 'G3', 'B3'], ['C3', 'E3', 'G3'], ['A3', 'C4', 'E4'], ['B3', 'D#4', 'F#4'], ['E3', 'G3', 'B3'], ['C3', 'E3', 'G3'], ['F3', 'A3', 'C4'], ['B3', 'D#4', 'F#4']];
  const BASS = ['E2', 'C2', 'A2', 'B2', 'E2', 'C2', 'F2', 'B2'];
  const HUNT_BASS = ['E2', 'E2', 'F2', 'E2', 'G2', 'F2', 'E2', 'D#2'];
  const ALARM = ['B4', 'F5', 'B4', 'F5', 'C5', 'F#5', 'C5', 'F#5'];

  class ArcadeMusic {
    constructor(context) {
      this.context = context;
      this.phase = OFF;
      this.fear = 0;
      this.moving = true;
      this.muted = false;
      this.step = 0;       // sixteenths in the phase
      this.next = 0;       // when the next sixteenth is
      this.seed = 20261125;
      this.master = context.createGain();
      this.master.gain.value = 0;
      const limit = context.createDynamicsCompressor();
      limit.threshold.value = -10;
      limit.ratio.value = 12;
      limit.attack.value = 0.002;
      limit.release.value = 0.12;
      this.master.connect(limit).connect(context.destination);
      this.waves = {};
      for (const duty of [0.125, 0.25, 0.5]) this.waves[duty] = this.pulse(duty);
      this.waves.triangle = this.steps();
      this.noises = [this.noise(1), this.noise(5)];
      this.timer = null;
    }

    random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
    pulse(duty) {
      const n = 48, real = new Float32Array(n), imag = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        real[k] = 2 * Math.sin(2 * Math.PI * k * duty) / (Math.PI * k);
        imag[k] = 2 * (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k);
      }
      return this.context.createPeriodicWave(real, imag);
    }
    // the chip's triangle: 16 levels down and up
    steps() {
      const n = 32, real = new Float32Array(n), imag = new Float32Array(n), size = 512;
      for (let k = 1; k < n; k++) {
        for (let i = 0; i < size; i++) {
          const t = i / size, v = Math.round((t < 0.5 ? 4 * t - 1 : 3 - 4 * t) * 7.5) / 7.5;
          real[k] += 2 * v * Math.cos(2 * Math.PI * k * t) / size;
          imag[k] += 2 * v * Math.sin(2 * Math.PI * k * t) / size;
        }
      }
      return this.context.createPeriodicWave(real, imag);
    }
    // a second of a 15-bit shift register's bits, each held `period` samples
    noise(period) {
      const rate = this.context.sampleRate, buffer = this.context.createBuffer(1, rate, rate), data = buffer.getChannelData(0);
      let bits = 1, value = 1;
      for (let i = 0; i < rate; i++) {
        if (i % period === 0) {
          const bit = (bits ^ (bits >> 1)) & 1;
          bits = (bits >> 1) | (bit << 14);
          value = bits & 1 ? 1 : -1;
        }
        data[i] = value;
      }
      return buffer;
    }

    tone(at, length, from, {wave = 0.25, volume = 0.12, to = 0, decay = 0} = {}) {
      const c = this.context, o = c.createOscillator(), g = c.createGain();
      o.setPeriodicWave(this.waves[wave]);
      o.frequency.setValueAtTime(from, at);
      if (to) o.frequency.exponentialRampToValueAtTime(to, at + length);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(volume, at + 0.004);
      g.gain.linearRampToValueAtTime(decay ? volume * decay : volume, at + Math.max(0.005, length - 0.012));
      g.gain.linearRampToValueAtTime(0, at + length);
      o.connect(g).connect(this.master);
      o.start(at);
      o.stop(at + length + 0.01);
      o.onended = () => g.disconnect();
    }
    hit(at, length, volume, coarse = 0) {
      const c = this.context, s = c.createBufferSource(), g = c.createGain();
      s.buffer = this.noises[coarse];
      s.loop = true;
      g.gain.setValueAtTime(volume, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + length);
      s.connect(g).connect(this.master);
      s.start(at, this.random() * 0.5);
      s.stop(at + length);
      s.onended = () => g.disconnect();
    }
    kick(at, volume = 0.5) { this.tone(at, 0.13, 150, {wave: 'triangle', volume, to: 38, decay: 0.2}); }

    // ---- a sixteenth of each part; returns its length
    lurk(at, n) {
      const length = 60 / 124 / 4, bar = Math.floor(n / 16), k = n % 16, round = bar % 24;
      if (round >= 16) { // a rest: the pulse alone, and now and then a drop
        if (k === 0 || k === 10) this.tone(at, length * 2, hz('E2'), {wave: 'triangle', volume: 0.12, decay: 0.3});
        if (k === 6 && round % 3 === 0) this.tone(at, length * 3, hz('A#5'), {wave: 0.125, volume: 0.022, decay: 0.1});
        return length;
      }
      const at8 = round % 8, chord = CHORDS[at8];
      if (k % 2 === 0) {
        const note = TUNE[at8 * 8 + k / 2];
        if (note !== '-' && (round >= 8 || k < 8)) this.tone(at, length * 1.8, hz(note), {wave: 0.25, volume: 0.064, decay: 0.5});
        this.tone(at, length * 1.6, hz(BASS[at8]) * (k % 4 === 2 ? 2 : 1), {wave: 'triangle', volume: 0.15});
      }
      this.tone(at, length * 0.8, hz(chord[[0, 1, 2, 1][k % 4]]) * 2, {wave: 0.125, volume: 0.021});
      if (k % 8 === 0) this.kick(at, 0.3);
      if (k % 8 === 4) this.hit(at, 0.1, 0.07);
      if (k % 4 === 2) this.hit(at, 0.03, 0.03);
      return length;
    }
    hunt(at, n) {
      const fear = this.fear, length = 60 / (128 + 52 * fear) / 4, k = n % 16, bar = Math.floor(n / 16);
      if (k % 2 === 0) this.tone(at, length * 1.5, hz(HUNT_BASS[(k / 2 + (bar % 4 === 3 ? 4 : 0)) % 8]), {wave: 'triangle', volume: 0.3});
      const set = bar % 2 ? ['F4', 'G#4', 'B4'] : ['E4', 'G4', 'A#4'];
      this.tone(at, length * 0.75, hz(set[k % 3]) * (fear > 0.5 && k % 4 === 3 ? 2 : 1), {wave: 0.125, volume: 0.04 + 0.04 * fear});
      if (k % 4 === 0 && bar % 2) this.tone(at, length * 3, hz(ALARM[(k / 4 + bar) % 8]), {wave: 0.5, volume: 0.05 + 0.06 * fear, decay: 0.3});
      if (k % 4 === 0) this.kick(at, 0.42);
      if (k % 8 === 4) this.hit(at, 0.14, 0.18);
      if (k % 2 === 1) this.hit(at, 0.03, 0.05 + 0.05 * fear);
      if (bar % 4 === 3 && k >= 12) this.hit(at, 0.07, 0.14);
      return length;
    }
    withYou(at, n) {
      const length = 60 / 104 / 4, k = n % 16, bar = Math.floor(n / 16);
      if (k === 0 || k === 8) { this.kick(at, 0.62); this.kick(at + length * 1.35, 0.45); } // the heart
      if (k === 0) { // the drone, and the tritone against it, beating
        const bars = length * 16;
        this.tone(at, bars, hz('E2'), {wave: 0.5, volume: 0.105});
        this.tone(at, bars, hz('E2') * 1.012, {wave: 0.5, volume: 0.09});
        this.tone(at, bars, hz('A#2') * (bar % 2 ? 1.06 : 1), {wave: 0.25, volume: 0.09});
      }
      if (k === 0 && bar % 2 === 0) { // the siren, a semitone higher each time
        const base = hz('A#4') * 2 ** ((Math.floor(bar / 2) % 6) / 12);
        this.tone(at, length * 14, base, {wave: 0.125, volume: 0.09, to: base * 1.5});
        this.tone(at + length * 14, length * 16, base * 1.5, {wave: 0.125, volume: 0.09, to: base * 0.94});
      }
      // her voice: blips in phrases of words, up at the end (a question nobody can answer)
      const phrase = n % 24, high = phrase > 17 ? 1.3 : 1;
      if (phrase < 20 && phrase % 7 !== 6) {
        const pitch = 560 * high * 2 ** ((Math.floor(this.random() * 7) - 3) / 12);
        this.tone(at, length * 0.45, pitch, {wave: 0.25, volume: 0.112, to: pitch * (phrase === 19 ? 1.5 : 0.94)});
        if (this.random() < 0.5) this.tone(at + length * 0.5, length * 0.4, pitch * 1.12, {wave: 0.25, volume: 0.09});
      }
      if (bar % 4 === 3) this.tone(at, length * 0.8, hz('E6') * 2 ** (-k / 12), {wave: 0.125, volume: 0.075}); // scurrying down
      if (k % 4 === 2) this.hit(at, 0.05, 0.1, 1);
      if (k === 12 && bar % 2) this.hit(at, 0.5, 0.2, 1);
      return length;
    }

    sting(event, at) {
      if (event === GLIMPSE) {
        this.tone(at, 0.5, hz('E6'), {wave: 0.125, volume: 0.07, decay: 0.1});
        this.tone(at + 0.22, 0.9, hz('A#5'), {wave: 0.125, volume: 0.08, decay: 0.05});
      } else if (event === HUNTED) {
        ['E4', 'F4', 'A#4', 'B4', 'E5', 'F5'].forEach((note, i) => this.tone(at + i * 0.07, 0.5 - i * 0.04, hz(note), {wave: 0.5, volume: 0.06, decay: 0.3}));
        this.hit(at + 0.4, 0.5, 0.2, 1);
      } else if (event === CAUGHT) { // the shriek
        for (const [f, to] of [[620, 1900], [660, 2050], [930, 2500]]) this.tone(at, 0.55, f, {wave: 0.25, volume: 0.13, to});
        for (const note of ['E3', 'F3', 'A#3', 'B3']) this.tone(at + 0.5, 1.1, hz(note), {wave: 0.5, volume: 0.08, decay: 0.1});
        this.hit(at, 0.7, 0.34);
        this.hit(at + 0.5, 1.0, 0.3, 1);
        this.kick(at + 0.5, 0.8);
      } else if (event === LOST || event === SHAKEN) { // away: the major at last
        ['E4', 'G#4', 'B4', 'E5', 'G#5', 'B5', 'E6'].forEach((note, i) => {
          this.tone(at + i * 0.075, i === 6 ? 0.8 : 0.16, hz(note), {wave: 0.25, volume: 0.11, decay: i === 6 ? 0.1 : 0.6});
          this.tone(at + i * 0.075, i === 6 ? 0.8 : 0.16, hz(note) / 2, {wave: 'triangle', volume: 0.2, decay: 0.3});
        });
      }
    }

    // the sixteenths due until `until`
    fill(until) {
      while (this.next < until && this.phase !== OFF && this.moving) {
        const at = this.next, n = this.step++;
        this.next += this.phase === WITH ? this.withYou(at, n) : this.phase === HUNT ? this.hunt(at, n) : this.lurk(at, n);
      }
    }
    // the game a second on
    set({phase, fear = 0, event = 0, moving = true}, now = this.context.currentTime) {
      const sounding = phase !== OFF && moving && !this.muted;
      this.fear = fear;
      if (phase !== this.phase || moving !== this.moving) {
        const strike = event === CAUGHT ? 0.9 : event ? 0.55 : 0; // the sting first
        this.phase = phase;
        this.moving = moving;
        this.step = 0;
        this.next = now + 0.05 + strike;
      }
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(sounding ? 0.75 : 0, now, sounding ? 0.05 : 0.3);
      if (event && sounding) this.sting(event, now + 0.03);
      if (this.timer === null && typeof setInterval === 'function' && !this.offline) this.timer = setInterval(() => this.pump(), 80);
      if (phase === OFF && this.timer !== null) { clearInterval(this.timer); this.timer = null; }
      this.pump();
    }
    // soon enough ahead: a hidden tab's timers come once a second
    pump() {
      if (this.offline) return;
      const now = this.context.currentTime, ahead = typeof document !== 'undefined' && document.hidden ? 2.2 : 0.25;
      if (this.context.state === 'suspended') return;
      if (this.next < now) this.next = now + 0.02; // after a stall
      this.fill(now + ahead);
    }
    mute(on) {
      this.muted = on;
      this.set({phase: this.phase, fear: this.fear, moving: this.moving});
    }
  }

  window.ArcadeMusic = ArcadeMusic;
})();
