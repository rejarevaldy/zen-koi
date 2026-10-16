// The pond's sound, made on the fly with Web Audio: moving water, a wind chime
// in the miyako-bushi scale, the odd knock of a shishi-odoshi, rain when it
// rains, and small sounds for food, the poi, and the bowl. Nothing plays until
// the player turns sound on, and it fades out whenever no pond is in view.

type Holder = symbol;

// Miyako-bushi: D, E flat, G, A, B flat.
const CHIME_NOTES = [587.33, 622.25, 783.99, 880, 932.33, 1174.66];

class Ambience {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #rainGain: GainNode | null = null;
  #enabled = false;
  #volume = 0.5;
  #rain = false;
  #holders = new Set<Holder>();
  #timers: ReturnType<typeof setTimeout>[] = [];
  #playing = false;

  /** Applies the player's choice. Call it from a click so the browser lets audio start. */
  configure(enabled: boolean, volume: number) {
    this.#enabled = enabled;
    this.#volume = Math.max(0, Math.min(1, volume));
    if (enabled) this.#ensure();
    this.#update();
  }

  setRain(rain: boolean) {
    this.#rain = rain;
    const context = this.#context;
    if (context && this.#rainGain) {
      this.#rainGain.gain.setTargetAtTime(rain ? 0.11 : 0, context.currentTime, 0.8);
    }
  }

  /** A pond in view holds the sound on; the returned function lets it go. */
  hold(): () => void {
    const holder: Holder = Symbol("pond");
    this.#holders.add(holder);
    this.#update();
    return () => {
      this.#holders.delete(holder);
      this.#update();
    };
  }

  plop() {
    this.#blip(520, 170, 0.13, 0.1);
  }

  dip() {
    this.#noiseBurst(700, 0.22, 0.06);
    this.#blip(330, 160, 0.16, 0.05);
  }

  splash() {
    this.#noiseBurst(1_100, 0.35, 0.12);
    this.#blip(600, 220, 0.12, 0.08);
  }

  tear() {
    this.#noiseBurst(3_200, 0.14, 0.07, "highpass");
  }

  #ensure() {
    if (this.#context) {
      void this.#context.resume();
      return;
    }
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    this.#context = context;
    const master = context.createGain();
    master.gain.value = 0;
    master.connect(context.destination);
    this.#master = master;

    // Water: brown noise through a low-pass whose cutoff drifts like lapping water.
    const water = context.createBufferSource();
    water.buffer = brownNoise(context, 6);
    water.loop = true;
    const low = context.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 520;
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 220;
    lfo.connect(lfoDepth).connect(low.frequency);
    const waterGain = context.createGain();
    waterGain.gain.value = 0.5;
    water.connect(low).connect(waterGain).connect(master);
    water.start();
    lfo.start();

    // Rain: brighter noise, faded in only while it rains.
    const rain = context.createBufferSource();
    rain.buffer = whiteNoise(context, 3);
    rain.loop = true;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 1_400;
    const soft = context.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = 6_500;
    const rainGain = context.createGain();
    rainGain.gain.value = this.#rain ? 0.11 : 0;
    rain.connect(high).connect(soft).connect(rainGain).connect(master);
    rain.start();
    this.#rainGain = rainGain;

    // Browsers keep a context suspended until a gesture; resume on the next one.
    const resume = () => void context.resume();
    document.addEventListener("pointerdown", resume, { once: true, capture: true });
  }

  #update() {
    const playing = this.#enabled && this.#holders.size > 0;
    const context = this.#context;
    const master = this.#master;
    if (context && master) {
      master.gain.setTargetAtTime(playing ? this.#volume * 0.5 : 0, context.currentTime, 0.6);
    }
    if (playing === this.#playing) return;
    this.#playing = playing;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    if (playing) {
      this.#schedule(() => this.#chime(), 6_000, 18_000);
      this.#schedule(() => this.#knock(), 25_000, 50_000);
    }
  }

  #schedule(play: () => void, min: number, max: number) {
    const next = () => {
      const timer = setTimeout(
        () => {
          if (!this.#playing) return;
          play();
          next();
        },
        min + Math.random() * (max - min),
      );
      this.#timers.push(timer);
    };
    next();
  }

  /** One bell of a wind chime, sometimes two in a row. */
  #chime() {
    const notes = Math.random() < 0.35 ? 2 : 1;
    for (let index = 0; index < notes; index++) {
      const note = CHIME_NOTES[Math.floor(Math.random() * CHIME_NOTES.length)]!;
      this.#bell(note, index * 0.32, 0.045);
    }
  }

  /** The shishi-odoshi tipping over: a hollow bamboo knock. */
  #knock() {
    const context = this.#context;
    const master = this.#master;
    if (!context || !master) return;
    const start = context.currentTime;
    for (const [frequency, level] of [
      [820, 0.11],
      [1_340, 0.05],
    ] as const) {
      const tone = context.createOscillator();
      tone.type = "triangle";
      tone.frequency.setValueAtTime(frequency, start);
      tone.frequency.exponentialRampToValueAtTime(frequency * 0.82, start + 0.09);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(level, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      tone.connect(gain).connect(master);
      tone.start(start);
      tone.stop(start + 0.2);
    }
  }

  #bell(frequency: number, delay: number, level: number) {
    const context = this.#context;
    const master = this.#master;
    if (!context || !master) return;
    const start = context.currentTime + delay;
    for (const [ratio, share] of [
      [1, 1],
      [2.76, 0.3],
      [5.4, 0.12],
    ] as const) {
      const tone = context.createOscillator();
      tone.frequency.value = frequency * ratio;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(level * share, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 3.2 / ratio);
      tone.connect(gain).connect(master);
      tone.start(start);
      tone.stop(start + 3.4);
    }
  }

  #blip(from: number, to: number, seconds: number, level: number) {
    const context = this.#context;
    const master = this.#master;
    if (!context || !master || !this.#playing) return;
    const start = context.currentTime;
    const tone = context.createOscillator();
    tone.frequency.setValueAtTime(from, start);
    tone.frequency.exponentialRampToValueAtTime(to, start + seconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    tone.connect(gain).connect(master);
    tone.start(start);
    tone.stop(start + seconds + 0.02);
  }

  #noiseBurst(frequency: number, seconds: number, level: number, type: BiquadFilterType = "bandpass") {
    const context = this.#context;
    const master = this.#master;
    if (!context || !master || !this.#playing) return;
    const start = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = whiteNoise(context, seconds + 0.05);
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    source.connect(filter).connect(gain).connect(master);
    source.start(start);
  }
}

function whiteNoise(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
  return buffer;
}

function brownNoise(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < data.length; index++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.5;
  }
  return buffer;
}

/** One soundscape for the whole window, shared by every pond. */
export const ambience = new Ambience();
