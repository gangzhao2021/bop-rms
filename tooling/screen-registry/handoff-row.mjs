export function parseHandoffCells(cells) {
  if (cells.length === 6) return cells;
  if (cells.length === 4) {
    const [screen, fields, actions, phase] = cells;
    return [screen, fields, "—", actions, "Customer access follows Section 88.6", phase];
  }
  if (cells.length === 3) {
    const [screen, fields, placement] = cells;
    return [
      screen,
      fields,
      "inherits parent Screen",
      "inherits parent Screen",
      placement,
      placement,
    ];
  }
  throw new Error(`unsupported Screen Registry table shape: ${cells.length} columns`);
}

export function phaseFor(text) {
  if (/Future Trigger/i.test(text)) return ["future_trigger", "future_trigger_disabled"];
  if (/Phase-specific/i.test(text)) return ["phase_specific", "phase_capability"];
  if (/Phase 1A/i.test(text)) return ["phase_1a", "phase_capability"];
  if (/Later Phase 1/i.test(text)) return ["later_phase_1", "phase_capability"];
  if (/Phase 0\+/i.test(text)) return ["phase_0_plus", "phase_capability"];
  if (/Phase 1–3|Phase 1-3|Phase 2–3|Phase 2-3/i.test(text))
    return ["cross_phase", "phase_capability"];
  const match = text.match(/Phase\s+([0-9])/i);
  return match
    ? [`phase_${match[1]}`, "phase_capability"]
    : ["inherited", "inherited_feature_gate"];
}

export function workPackages(text) {
  const result = [];
  // A WP prefix starts a list; omitted prefixes are allowed only after its separators.
  const lists = text.matchAll(
    /WP-\d{4}(?:[–-]\d{4})?(?:\s*[、,，]\s*(?:WP-)?\d{4}(?:[–-]\d{4})?)*/g,
  );
  for (const [list] of lists) {
    for (const match of list.matchAll(/(?:WP-)?(\d{4})(?:[–-](\d{4}))?/g)) {
      const first = Number(match[1]);
      const last = Number(match[2] ?? match[1]);
      if (last < first || last - first > 50)
        throw new Error(`invalid Work Package range: ${match[0]}`);
      for (let number = first; number <= last; number += 1)
        result.push(`WP-${String(number).padStart(4, "0")}`);
    }
  }
  return [...new Set(result)].sort();
}
