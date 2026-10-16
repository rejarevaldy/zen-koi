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
 * Squares the chat input's top corners and removes its top border and its drop
 * shadow, so the pond above runs straight into it as one box. The border goes
 * entirely: the form clips its children to the padding box, so a transparent
 * border would still show the form's background as a line. The shadow's blur
 * would darken the pond's last row. Returns a function that restores them.
 */
export function squareComposerTop(from: Element): (() => void) | null {
  const surface = findComposerSurface(from);
  if (!surface) return null;
  const { borderTopLeftRadius, borderTopRightRadius, borderTopWidth, boxShadow } = surface.style;
  surface.style.borderTopLeftRadius = "0";
  surface.style.borderTopRightRadius = "0";
  surface.style.borderTopWidth = "0";
  surface.style.boxShadow = "none";
  return () => {
    surface.style.borderTopLeftRadius = borderTopLeftRadius;
    surface.style.borderTopRightRadius = borderTopRightRadius;
    surface.style.borderTopWidth = borderTopWidth;
    surface.style.boxShadow = boxShadow;
  };
}

/** The chat input's border color, so the pond's own border matches it. */
export function composerBorderColor(from: Element): string | null {
  const surface = findComposerSurface(from);
  return surface ? getComputedStyle(surface).borderLeftColor : null;
}
