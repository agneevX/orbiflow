export type ThemeId = 'obsidian' | 'amber' | 'nordic' | 'daylight';

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
  amber: {
    id: 'amber',
    label: 'Midnight Amber',
    isDark: true,
    rxColor: '#F59E0B',
    txColor: '#2DD4BF',
    rxFillTop: 'rgba(245, 158, 11, 0.22)',
    rxFillBottom: 'rgba(245, 158, 11, 0.01)',
    txFillTop: 'rgba(45, 212, 191, 0.16)',
    txFillBottom: 'rgba(45, 212, 191, 0.01)',
    gridColor: 'rgba(168, 162, 158, 0.14)',
    axisTextColor: '#A8A29E',
    nodeFill: '#1A1815',
    nodeBorder: '#44403C',
    ribbonColors: ['#F59E0B', '#2DD4BF', '#FB923C', '#A3E635', '#FACC15', '#38BDF8'],
  },
  nordic: {
    id: 'nordic',
    label: 'Nordic Frost',
    isDark: true,
    rxColor: '#60A5FA',
    txColor: '#4ADE80',
    rxFillTop: 'rgba(96, 165, 250, 0.22)',
    rxFillBottom: 'rgba(96, 165, 250, 0.01)',
    txFillTop: 'rgba(74, 222, 128, 0.16)',
    txFillBottom: 'rgba(74, 222, 128, 0.01)',
    gridColor: 'rgba(148, 163, 184, 0.14)',
    axisTextColor: '#94A3B8',
    nodeFill: '#131F36',
    nodeBorder: '#2E4770',
    ribbonColors: ['#60A5FA', '#4ADE80', '#38BDF8', '#A78BFA', '#2DD4BF', '#FBBF24'],
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
};

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
