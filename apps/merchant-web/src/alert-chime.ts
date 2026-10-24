/** Two short tones from the Web Audio API; silent where audio is unavailable or not yet allowed. */
export function playKitchenChime(context?: AudioContext): void {
  try {
    const Audio =
      (
        globalThis as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }
      ).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const audio = context ?? (Audio ? new Audio() : null);
    if (!audio) return;
    const start = audio.currentTime;
    for (const [frequency, offset] of [
      [880, 0],
      [1175, 0.18],
    ] as const) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.18);
    }
  } catch {
    // Audio is a courtesy; no screen depends on it.
  }
}
