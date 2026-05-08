/**
 * Tab Manager - Manages unique tab ID and per-tab session isolation
 * Each tab gets a unique ID generated when the app first loads
 * This ensures requests from different tabs can be isolated
 */

const TAB_ID_KEY = 'admin_tab_id';
const TAB_ID_SESSION_KEY = 'admin_tab_id_session';

/**
 * Generate a unique ID for this tab
 */
function generateTabId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get or create the tab ID for the current tab
 * Uses sessionStorage to ensure each tab gets its own ID
 */
export function getTabId(): string {
  if (typeof window === 'undefined') return '';
  
  // First check sessionStorage (per-tab storage)
  const sessionTabId = sessionStorage.getItem(TAB_ID_SESSION_KEY);
  if (sessionTabId) return sessionTabId;
  
  // Generate and store new tabId
  const newTabId = generateTabId();
  sessionStorage.setItem(TAB_ID_SESSION_KEY, newTabId);
  
  return newTabId;
}

/**
 * Clear tab session (on logout)
 */
export function clearTabSession(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(TAB_ID_SESSION_KEY);
}

/**
 * Check if tab ID is valid and matches current tab
 */
export function isValidTabId(tabId: string): boolean {
  if (!tabId) return false;
  const currentTabId = getTabId();
  return tabId === currentTabId;
}
