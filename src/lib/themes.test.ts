import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_THEME_PAIRS,
  DARK_THEMES,
  LIGHT_THEMES,
  THEMES,
  findAutoThemePair,
  normalizeDarkTheme,
  normalizeLightTheme,
  normalizeThemeMode,
  resolveEffectiveIsDark,
  resolveThemeId,
} from './themes';

test('normalizeThemeMode validates auto, dark, and light modes', () => {
  assert.equal(normalizeThemeMode(null), 'auto');
  assert.equal(normalizeThemeMode('unknown'), 'auto');
  assert.equal(normalizeThemeMode('auto'), 'auto');
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('light'), 'light');
});

test('normalizeDarkTheme and normalizeLightTheme enforce dark/light palette separation', () => {
  assert.equal(normalizeDarkTheme('nordic'), 'nord');
  assert.equal(normalizeDarkTheme('dracula-pro'), 'dracula-pro');
  assert.equal(normalizeDarkTheme('daylight'), 'obsidian');
  assert.equal(normalizeLightTheme('daylight'), 'daylight');
  assert.equal(normalizeLightTheme('catppuccin-latte'), 'daylight');
  assert.equal(normalizeLightTheme('tokyo-night'), 'daylight');
});

test('resolveThemeId follows mode (auto/dark/light) and picks the matching palette', () => {
  assert.equal(resolveEffectiveIsDark('auto', true), true);
  assert.equal(resolveEffectiveIsDark('auto', false), false);
  assert.equal(resolveEffectiveIsDark('dark', false), true);
  assert.equal(resolveEffectiveIsDark('light', true), false);

  assert.equal(resolveThemeId('auto', true, 'tokyo-night', 'daylight'), 'tokyo-night');
  assert.equal(resolveThemeId('auto', false, 'tokyo-night', 'daylight'), 'daylight');
  assert.equal(resolveThemeId('dark', false, 'dracula-pro', 'daylight'), 'dracula-pro');
  assert.equal(resolveThemeId('light', true, 'dracula-pro', 'daylight'), 'daylight');
});

test('DARK_THEMES and LIGHT_THEMES keep only Daylight Slate as the sole light theme', () => {
  assert.equal(DARK_THEMES.length + LIGHT_THEMES.length, Object.keys(THEMES).length);
  assert.equal('amber' in THEMES, false);
  assert.equal('catppuccin-latte' in THEMES, false);
  assert.equal('dracula-light' in THEMES, false);
  assert.equal('nord-light' in THEMES, false);
  assert.equal('tokyo-night-day' in THEMES, false);
  assert.equal(normalizeDarkTheme('amber'), 'obsidian');
  assert.ok(THEMES['catppuccin-mocha'].isDark);
  assert.ok(THEMES['dracula-pro'].isDark);
  assert.ok(THEMES['nord'].isDark);
  assert.ok(THEMES['tokyo-night'].isDark);
  assert.deepEqual(
    LIGHT_THEMES.map((t) => t.id),
    ['daylight']
  );
  assert.equal(THEMES.daylight.label, 'Daylight Slate');
  assert.equal(THEMES.daylight.isDark, false);
});

test('AUTO_THEME_PAIRS pairs every dark theme with Daylight Slate', () => {
  assert.equal(AUTO_THEME_PAIRS.length, 5);
  assert.equal(DARK_THEMES.length, 5);
  assert.equal(LIGHT_THEMES.length, 1);
  for (const pair of AUTO_THEME_PAIRS) {
    assert.equal(THEMES[pair.darkThemeId].isDark, true);
    assert.equal(pair.lightThemeId, 'daylight');
    assert.equal(findAutoThemePair(pair.darkThemeId).id, pair.id);
  }
});
