import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SYNTH_SCRIPT } from "./synthesize.js";

const python = process.platform === "win32" ? "python" : "python3";

function hasNumpy(): boolean {
  try {
    execFileSync(python, ["-c", "import numpy"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The Linux unit-test job installs numpy, so a missing numpy there fails instead of skipping.
const numpyRequired = Boolean(process.env.CI) && process.platform === "linux";
const runnable = hasNumpy();

const FILTER = SYNTH_SCRIPT.slice(
  SYNTH_SCRIPT.indexOf("def remove_model_tones"),
  SYNTH_SCRIPT.indexOf("samples, sample_rate = synthesize_text(text)"),
);

// Speech-like noise in bursts with pauses, plus lines at 2, 3 and 4 times sample_rate / 10 that follow
// the speech envelope as Kokoro's do. Reports each line's height over its surroundings, the level the
// pauses carry near each line, and how much the speech band and the loudness moved.
const HARNESS = `
import json
import numpy as np
${FILTER}
rate = 24000
rng = np.random.default_rng(7)
t = np.arange(rate * 4) / rate
envelope = np.where((t % 1.5) < 1.0, 1.0, 0.0)
shape = 1.0 / (1.0 + np.fft.rfftfreq(len(t), 1.0 / rate) / 1500.0)
speech = np.fft.irfft(np.fft.rfft(rng.standard_normal(len(t))) * shape, len(t))
speech *= 0.2 / np.std(speech)
lines = [4800.0, 7200.0, 9600.0]
tones = sum(0.006 * np.sin(2 * np.pi * f * t + i) for i, f in enumerate(lines))
clip = (speech + tones) * envelope + rng.standard_normal(len(t)) * 1e-5
clean = remove_model_tones(clip, rate)

def excess(x, f0):
    power = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    near = (freqs > f0 - 1.0) & (freqs < f0 + 1.0)
    around = (np.abs(freqs - f0) > 5.0) & (np.abs(freqs - f0) < 60.0)
    return float(10 * np.log10(power[near].max() / np.median(power[around])))

def pause_level(x, f0):
    seg = x[(t >= 1.15) & (t < 1.45)]
    power = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2 / len(seg)
    freqs = np.fft.rfftfreq(len(seg), 1.0 / rate)
    return float(10 * np.log10(power[np.abs(freqs - f0) < 20.0].mean()))

def band(x, lo, hi):
    power = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    return float(10 * np.log10(power[(freqs >= lo) & (freqs < hi)].sum()))

def speech_level(x):
    power = np.abs(np.fft.rfft(x)) ** 2 / len(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    return float(10 * np.log10(power[(freqs >= 100) & (freqs < 3000)].mean()))

print(json.dumps({
    "samples": [len(clip), len(clean)],
    "before": [excess(clip, f) for f in lines],
    "after": [excess(clean, f) for f in lines],
    "pauseBelowSpeech": [pause_level(clean, f) - speech_level(clip) for f in lines],
    "speechBandDelta": band(clean, 100, 3000) - band(clip, 100, 3000),
    "loudnessDelta": float(20 * np.log10(np.sqrt(np.mean(clean ** 2)) / np.sqrt(np.mean(clip ** 2)))),
}))
`;

describe("Kokoro tone lines", () => {
  it("runs the line filter before the clip is written", () => {
    const filtered = SYNTH_SCRIPT.indexOf("samples = remove_model_tones(samples, sample_rate)");
    expect(filtered).toBeGreaterThan(-1);
    expect(filtered).toBeLessThan(SYNTH_SCRIPT.indexOf("sf.write(output_path"));
  });

  it.skipIf(!runnable && !numpyRequired)(
    "takes steady lines at 4800, 7200 and 9600 Hz out of a clip without touching the rest",
    () => {
      const result = JSON.parse(
        execFileSync(python, ["-c", HARNESS], { encoding: "utf-8" }),
      ) as Record<string, number[] | number>;

      expect(result.samples).toEqual([96000, 96000]);
      for (const height of result.before as number[]) expect(height).toBeGreaterThan(10);
      for (const height of result.after as number[]) expect(height).toBeLessThan(0);
      // The cut's ringing must stay inaudible in the pauses beside it.
      for (const level of result.pauseBelowSpeech as number[]) expect(level).toBeLessThan(-60);
      expect(Math.abs(result.speechBandDelta as number)).toBeLessThan(0.01);
      expect(Math.abs(result.loudnessDelta as number)).toBeLessThan(0.1);
    },
    30_000,
  );
});
