import type { NavTab } from '../components/Sidebar';

export type DevicesSubTab = 'list' | 'map';

export interface AppRouteState {
  tab: NavTab;
  devicesSubTab: DevicesSubTab;
  query: string;
}

export const TAB_DISPLAY_NAMES: Record<NavTab, string> = {
  overview: 'Home',
  flows: 'Connections',
  hosts: 'Devices',
  alerts: 'Alerts',
  setup: 'Agent',
  settings: 'Settings',
};

/**
 * Parses a browser URL pathname + search string into the corresponding OrbiFlow route state.
 */
export function parseRouteFromLocation(pathname: string, search = ''): AppRouteState {
  const cleanPath = (pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
  const params = new URLSearchParams(search || '');
  const query = params.get('q')?.trim() || '';

  if (cleanPath === '/' || cleanPath === '/home' || cleanPath === '/overview') {
    return { tab: 'overview', devicesSubTab: 'list', query: '' };
  }
  if (cleanPath === '/connections' || cleanPath === '/flows') {
    return { tab: 'flows', devicesSubTab: 'list', query };
  }
  if (
    cleanPath === '/devices/network-map' ||
    cleanPath === '/devices/map' ||
    cleanPath === '/network-map' ||
    cleanPath === '/traffic-map'
  ) {
    return { tab: 'hosts', devicesSubTab: 'map', query: '' };
  }
  if (cleanPath === '/devices' || cleanPath === '/devices/list' || cleanPath === '/hosts') {
    return { tab: 'hosts', devicesSubTab: 'list', query: '' };
  }
  if (cleanPath === '/alerts') {
    return { tab: 'alerts', devicesSubTab: 'list', query: '' };
  }
  if (cleanPath === '/agent' || cleanPath === '/setup') {
    return { tab: 'setup', devicesSubTab: 'list', query: '' };
  }
  if (cleanPath === '/settings') {
    return { tab: 'settings', devicesSubTab: 'list', query: '' };
  }

  return { tab: 'overview', devicesSubTab: 'list', query: '' };
}

/**
 * Builds the canonical URL path (and optional query string) for a given OrbiFlow tab/sub-tab.
 */
export function buildRouteUrl(
  tab: NavTab,
  devicesSubTab: DevicesSubTab = 'list',
  query = ''
): string {
  switch (tab) {
    case 'overview':
      return '/';
    case 'flows': {
      const trimmed = query.trim();
      return trimmed ? `/connections?q=${encodeURIComponent(trimmed)}` : '/connections';
    }
    case 'hosts':
      return devicesSubTab === 'map' ? '/devices/network-map' : '/devices';
    case 'alerts':
      return '/alerts';
    case 'setup':
      return '/agent';
    case 'settings':
      return '/settings';
    default:
      return '/';
  }
}

/**
 * Computes the browser tab document title matching the active view (e.g. "Home - OrbiFlow").
 */
export function getDocumentTitle(
  tab: NavTab,
  devicesSubTab: DevicesSubTab = 'list'
): string {
  if (tab === 'hosts' && devicesSubTab === 'map') {
    return 'Network Map - OrbiFlow';
  }
  const label = TAB_DISPLAY_NAMES[tab] || 'Home';
  return `${label} - OrbiFlow`;
}
