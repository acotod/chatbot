/**
 * Tab Manager - Manages unique tab ID and per-tab session isolation
 * Each tab gets a unique ID generated when the app first loads
 * This ensures requests from different tabs can be isolated
 */

const TAB_ID_SESSION_KEY = 'admin_tab_id_session';
let inMemoryTabId = '';

/**
 * Generate a unique ID for this tab
 */
function generateTabId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function readSessionTabId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return sessionStorage.getItem(TAB_ID_SESSION_KEY) ?? '';
  } catch {
    return inMemoryTabId;
  }
}

function writeSessionTabId(tabId: string): void {
  inMemoryTabId = tabId;
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(TAB_ID_SESSION_KEY, tabId);
  } catch {
    // Fallback to in-memory storage when sessionStorage is unavailable.
  }
}

/**
 * Get or create the tab ID for the current tab
 * Uses sessionStorage to ensure each tab gets its own ID
 */
export function getTabId(): string {
  if (typeof window === 'undefined') return '';

  // Prefer per-tab session storage, fallback to in-memory when blocked.
  const sessionTabId = readSessionTabId();
  if (sessionTabId) return sessionTabId;

  // Generate and store new tabId
  const newTabId = generateTabId();
  writeSessionTabId(newTabId);

  return newTabId;
}

/**
 * Clear tab session (on logout)
 */
export function clearTabSession(): void {
  if (typeof window === 'undefined') return;
  inMemoryTabId = '';
  try {
    sessionStorage.removeItem(TAB_ID_SESSION_KEY);
  } catch {
    // No-op when sessionStorage is unavailable.
  }
}

/**
 * Check if tab ID is valid and matches current tab
 */
export function isValidTabId(tabId: string): boolean {
  if (!tabId) return false;
  const currentTabId = getTabId();
  return tabId === currentTabId;
}
