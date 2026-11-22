export type ThemeMode = 'auto' | 'dark' | 'light';

export type ThemeId =
  | 'obsidian'
  | 'catppuccin-mocha'
  | 'dracula-pro'
  | 'nord'
  | 'tokyo-night'
  | 'daylight'
  | 'catppuccin-latte'
  | 'dracula-light'
  | 'nord-light'
  | 'tokyo-night-day';

export interface ThemePalette {
  id: ThemeId;
  label: string;
  isDark: boolean;
  rxColor: string;
  txColor: string;
  rxFillTop: string;
  rxFillBottom: string;
  txFillTop: string;
  txFillBottom: string;
  gridColor: string;
  axisTextColor: string;
  nodeFill: string;
  nodeBorder: string;
  ribbonColors: string[];
}

export interface AutoThemePair {
  id: string;
  label: string;
  darkThemeId: ThemeId;
  lightThemeId: ThemeId;
}

export const THEMES: Record<ThemeId, ThemePalette> = {
  obsidian: {
    id: 'obsidian',
    label: 'Obsidian',
    isDark: true,
    rxColor: '#38BDF8',
    txColor: '#34D399',
    rxFillTop: 'rgba(56, 189, 248, 0.22)',
    rxFillBottom: 'rgba(56, 189, 248, 0.01)',
    txFillTop: 'rgba(52, 211, 153, 0.16)',
    txFillBottom: 'rgba(52, 211, 153, 0.01)',
    gridColor: 'rgba(148, 163, 184, 0.12)',
    axisTextColor: '#94A3B8',
    nodeFill: '#111827',
    nodeBorder: '#334155',
    ribbonColors: ['#38BDF8', '#34D399', '#818CF8', '#F59E0B', '#FB7185', '#2DD4BF'],
  },
  'catppuccin-mocha': {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    isDark: true,
    rxColor: '#89B4FA',
    txColor: '#A6E3A1',
    rxFillTop: 'rgba(137, 180, 250, 0.24)',
    rxFillBottom: 'rgba(137, 180, 250, 0.01)',
    txFillTop: 'rgba(166, 227, 161, 0.18)',
    txFillBottom: 'rgba(166, 227, 161, 0.01)',
    gridColor: 'rgba(147, 153, 178, 0.15)',
    axisTextColor: '#9399B2',
    nodeFill: '#1E1E2E',
    nodeBorder: '#45475A',
    ribbonColors: ['#89B4FA', '#A6E3A1', '#CBA6F7', '#FAB387', '#F38BA8', '#94E2D5'],
  },
  'dracula-pro': {
    id: 'dracula-pro',
    label: 'Dracula Pro',
    isDark: true,
    rxColor: '#80FFEA',
    txColor: '#8AFF80',
    rxFillTop: 'rgba(128, 255, 234, 0.22)',
    rxFillBottom: 'rgba(128, 255, 234, 0.01)',
    txFillTop: 'rgba(138, 255, 128, 0.16)',
    txFillBottom: 'rgba(138, 255, 128, 0.01)',
    gridColor: 'rgba(154, 146, 199, 0.16)',
    axisTextColor: '#9A92C7',
    nodeFill: '#22212C',
    nodeBorder: '#454158',
    ribbonColors: ['#80FFEA', '#8AFF80', '#9580FF', '#FF80BF', '#FFCA80', '#FFFF80'],
  },
  nord: {
    id: 'nord',
    label: 'Nord',
    isDark: true,
    rxColor: '#88C0D0',
    txColor: '#A3BE8C',
    rxFillTop: 'rgba(136, 192, 208, 0.24)',
    rxFillBottom: 'rgba(136, 192, 208, 0.01)',
    txFillTop: 'rgba(163, 190, 140, 0.18)',
    txFillBottom: 'rgba(163, 190, 140, 0.01)',
    gridColor: 'rgba(216, 222, 233, 0.12)',
    axisTextColor: '#9AA7BC',
    nodeFill: '#2E3440',
    nodeBorder: '#4C566A',
    ribbonColors: ['#88C0D0', '#A3BE8C', '#81A1C1', '#EBCB8B', '#B48EAD', '#8FBCBB'],
  },
  'tokyo-night': {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    isDark: true,
    rxColor: '#7AA2F7',
    txColor: '#9ECE6A',
    rxFillTop: 'rgba(122, 162, 247, 0.24)',
    rxFillBottom: 'rgba(122, 162, 247, 0.01)',
    txFillTop: 'rgba(158, 206, 106, 0.18)',
    txFillBottom: 'rgba(158, 206, 106, 0.01)',
    gridColor: 'rgba(124, 134, 173, 0.16)',
    axisTextColor: '#7C86AD',
    nodeFill: '#1A1B26',
    nodeBorder: '#3B4261',
    ribbonColors: ['#7AA2F7', '#9ECE6A', '#BB9AF7', '#E0AF68', '#F7768E', '#7DCFFF'],
  },
  daylight: {
    id: 'daylight',
    label: 'Daylight Slate',
    isDark: false,
    rxColor: '#0284C7',
    txColor: '#059669',
    rxFillTop: 'rgba(2, 132, 199, 0.18)',
    rxFillBottom: 'rgba(2, 132, 199, 0.01)',
    txFillTop: 'rgba(5, 150, 105, 0.14)',
    txFillBottom: 'rgba(5, 150, 105, 0.01)',
    gridColor: 'rgba(100, 116, 139, 0.16)',
    axisTextColor: '#475569',
    nodeFill: '#FFFFFF',
    nodeBorder: '#CBD5E1',
    ribbonColors: ['#0284C7', '#059669', '#4F46E5', '#D97706', '#E11D48', '#0D9488'],
  },
  'catppuccin-latte': {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    isDark: false,
    rxColor: '#1E66F5',
    txColor: '#40A02B',
    rxFillTop: 'rgba(30, 102, 245, 0.18)',
    rxFillBottom: 'rgba(30, 102, 245, 0.01)',
    txFillTop: 'rgba(64, 160, 43, 0.14)',
    txFillBottom: 'rgba(64, 160, 43, 0.01)',
    gridColor: 'rgba(108, 111, 133, 0.16)',
    axisTextColor: '#6C6F85',
    nodeFill: '#FFFFFF',
    nodeBorder: '#CCD0DA',
    ribbonColors: ['#1E66F5', '#40A02B', '#8839EF', '#FE640B', '#D20F39', '#179299'],
  },
  'dracula-light': {
    id: 'dracula-light',
    label: 'Alucard Light',
    isDark: false,
    rxColor: '#036A96',
    txColor: '#14710A',
    rxFillTop: 'rgba(3, 106, 150, 0.18)',
    rxFillBottom: 'rgba(3, 106, 150, 0.01)',
    txFillTop: 'rgba(20, 113, 10, 0.14)',
    txFillBottom: 'rgba(20, 113, 10, 0.01)',
    gridColor: 'rgba(108, 102, 75, 0.16)',
    axisTextColor: '#6C664B',
    nodeFill: '#FFFBEB',
    nodeBorder: '#D8D2C0',
    ribbonColors: ['#036A96', '#14710A', '#644AC9', '#A3144D', '#A34D14', '#846E15'],
  },
  'nord-light': {
    id: 'nord-light',
    label: 'Nord Snow',
    isDark: false,
    rxColor: '#2E6F95',
    txColor: '#4F7A42',
    rxFillTop: 'rgba(46, 111, 149, 0.18)',
    rxFillBottom: 'rgba(46, 111, 149, 0.01)',
    txFillTop: 'rgba(79, 122, 66, 0.14)',
    txFillBottom: 'rgba(79, 122, 66, 0.01)',
    gridColor: 'rgba(76, 86, 106, 0.15)',
    axisTextColor: '#4C566A',
    nodeFill: '#FFFFFF',
    nodeBorder: '#D8DEE9',
    ribbonColors: ['#2E6F95', '#4F7A42', '#5E81AC', '#B4693E', '#8C5B83', '#3E8285'],
  },
  'tokyo-night-day': {
    id: 'tokyo-night-day',
    label: 'Tokyo Night Day',
    isDark: false,
    rxColor: '#2E7DE9',
    txColor: '#485E30',
    rxFillTop: 'rgba(46, 125, 233, 0.18)',
    rxFillBottom: 'rgba(46, 125, 233, 0.01)',
    txFillTop: 'rgba(72, 94, 48, 0.14)',
    txFillBottom: 'rgba(72, 94, 48, 0.01)',
    gridColor: 'rgba(97, 114, 176, 0.16)',
    axisTextColor: '#6172B0',
    nodeFill: '#F4F5F9',
    nodeBorder: '#C4C8DA',
    ribbonColors: ['#2E7DE9', '#485E30', '#7847BD', '#8C6C3E', '#C64343', '#007197'],
  },
};

export const DARK_THEMES = Object.values(THEMES).filter((t) => t.isDark);
export const LIGHT_THEMES = Object.values(THEMES).filter((t) => !t.isDark);

export const AUTO_THEME_PAIRS: AutoThemePair[] = [
  {
    id: 'obsidian-daylight',
    label: 'Obsidian / Daylight',
    darkThemeId: 'obsidian',
    lightThemeId: 'daylight',
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin (Mocha / Latte)',
    darkThemeId: 'catppuccin-mocha',
    lightThemeId: 'catppuccin-latte',
  },
  {
    id: 'dracula',
    label: 'Dracula (Pro / Alucard)',
    darkThemeId: 'dracula-pro',
    lightThemeId: 'dracula-light',
  },
  {
    id: 'nord',
    label: 'Nord (Night / Snow)',
    darkThemeId: 'nord',
    lightThemeId: 'nord-light',
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night (Night / Day)',
    darkThemeId: 'tokyo-night',
    lightThemeId: 'tokyo-night-day',
  },
];

export function findAutoThemePair(themeId: ThemeId): AutoThemePair {
  return (
    AUTO_THEME_PAIRS.find(
      (pair) => pair.darkThemeId === themeId || pair.lightThemeId === themeId
    ) || AUTO_THEME_PAIRS[0]
  );
}

export function normalizeThemeMode(raw: string | null | undefined): ThemeMode {
  if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  return 'auto';
}

export function normalizeDarkTheme(raw: string | null | undefined): ThemeId {
  if (raw === 'nordic') return 'nord';
  if (raw && raw in THEMES && THEMES[raw as ThemeId].isDark) {
    return raw as ThemeId;
  }
  return 'obsidian';
}

export function normalizeLightTheme(raw: string | null | undefined): ThemeId {
  if (raw && raw in THEMES && !THEMES[raw as ThemeId].isDark) {
    return raw as ThemeId;
  }
  return 'daylight';
}

export function resolveEffectiveIsDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return systemPrefersDark;
}

export function resolveThemeId(
  mode: ThemeMode,
  systemPrefersDark: boolean,
  darkTheme: ThemeId = 'obsidian',
  lightTheme: ThemeId = 'daylight'
): ThemeId {
  const isDark = resolveEffectiveIsDark(mode, systemPrefersDark);
  return isDark ? normalizeDarkTheme(darkTheme) : normalizeLightTheme(lightTheme);
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemeToDocument(themeId: ThemeId) {
  const theme = THEMES[themeId] || THEMES.obsidian;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  if (theme.isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}
