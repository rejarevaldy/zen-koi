// bb has no plugin API to place UI next to the chat input or to paint it, so
// these helpers find the composer that shares a banner's `[data-app-composer]`
// shell in bb's markup. Callers treat null as "markup not recognized" and fall
// back to bb's own banner placement. Same approach as charpeni's Gone Fishing.

const SHELL_SELECTOR = "[data-app-composer]";

/** The chat input's outer box. */
export function findComposerSurface(from: Element): HTMLElement | null {
  return from.closest(SHELL_SELECTOR)?.querySelector<HTMLElement>("form[data-promptbox]") ?? null;
}

/**
 * Inserts an empty element right above the chat input, below bb's card stack
 * (queued messages, background commands, changed files). The caller owns it
 * and must remove it.
 */
export function insertComposerSlot(from: Element, pluginId: string): HTMLElement | null {
  const anchor = from
    .closest(SHELL_SELECTOR)
    ?.querySelector<HTMLElement>(":scope > [data-follow-up-composer-anchor]");
  if (!anchor) return null;
  const slot = document.createElement("div");
  slot.dataset.zenKoiSlot = "";
  // bb scopes plugin CSS to these attributes.
  slot.dataset.bbPluginRoot = "";
  slot.dataset.bbPlugin = pluginId;
  // The shell spaces its children apart; the slot sits flush on the chat input.
  slot.style.marginBlockEnd = "0";
  anchor.before(slot);
  return slot;
}

/**
 * Squares the chat input's top corners so the pond above joins it into one
 * box. Returns a function that restores them.
 */
export function squareComposerTop(from: Element): (() => void) | null {
  const surface = findComposerSurface(from);
  if (!surface) return null;
  const { borderTopLeftRadius, borderTopRightRadius } = surface.style;
  surface.style.borderTopLeftRadius = "0";
  surface.style.borderTopRightRadius = "0";
  return () => {
    surface.style.borderTopLeftRadius = borderTopLeftRadius;
    surface.style.borderTopRightRadius = borderTopRightRadius;
  };
}
