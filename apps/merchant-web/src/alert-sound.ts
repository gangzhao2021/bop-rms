import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { playKitchenChime } from "./alert-chime.js";

/** Whether this device's screen (`key`) was left with sound on. */
export function storedAlertSound(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "on";
  } catch {
    return false;
  }
}
export function storeAlertSound(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? "on" : "off");
  } catch {
    // Private browsing: the choice holds until this page reloads.
  }
}

/**
 * WP-2423 Q33, merchant-outage-recovery M42: a screen remembers per device that staff wanted sound
 * (`bop.kitchen.sound`, `bop.orders.sound`). Browsers allow audio only after a tap, so after a
 * reload or a page change the sound comes back at the next tap anywhere on the screen
 * (`soundResumes` says so until then).
 */
export function useRememberedAlertSound(key: string): {
  readonly soundOn: boolean;
  readonly soundResumes: boolean;
  readonly toggle: () => void;
  readonly audio: MutableRefObject<AudioContext | null>;
} {
  const [soundOn, setSoundOn] = useState(false);
  const [soundResumes, setSoundResumes] = useState(() => storedAlertSound(key));
  const audio = useRef<AudioContext | null>(null);
  const startAudio = () => {
    // Created inside the operator's tap so the browser allows it to play later.
    try {
      const Audio = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      audio.current ??= Audio ? new Audio() : null;
      void audio.current?.resume().catch(() => undefined);
    } catch {
      audio.current = null;
    }
  };
  const toggle = () => {
    setSoundResumes(false);
    setSoundOn((value) => {
      const next = !value;
      storeAlertSound(key, next);
      if (next) {
        startAudio();
        if (audio.current) playKitchenChime(audio.current);
      }
      return next;
    });
  };
  useEffect(() => {
    if (!soundResumes || typeof document === "undefined") return;
    const resume = () => {
      startAudio();
      setSoundResumes(false);
      setSoundOn(true);
    };
    document.addEventListener("pointerdown", resume, { once: true, capture: true });
    document.addEventListener("keydown", resume, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", resume, { capture: true });
      document.removeEventListener("keydown", resume, { capture: true });
    };
  }, [soundResumes]);
  return { soundOn, soundResumes, toggle, audio };
}
