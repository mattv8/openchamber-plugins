// The host keeps one popover per document; a hover opening would replace an open action menu.
// The owner frame records whether its menu popover is open so hover previews can stand aside.
let openMenuId: string | null = null;

export const markMenuOpen = (id: string): void => { openMenuId = id; };
/** Clears only the matching opening, so a late close of an older menu cannot unblock a newer one. */
export const markMenuClosed = (id: string): void => { if (openMenuId === id) openMenuId = null; };
export const isMenuOpen = (): boolean => openMenuId !== null;
