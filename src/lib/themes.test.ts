import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEMES,
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
  assert.equal(normalizeLightTheme('catppuccin-latte'), 'catppuccin-latte');
  assert.equal(normalizeLightTheme('tokyo-night'), 'daylight');
});

test('resolveThemeId follows mode (auto/dark/light) and picks the matching palette', () => {
  assert.equal(resolveEffectiveIsDark('auto', true), true);
  assert.equal(resolveEffectiveIsDark('auto', false), false);
  assert.equal(resolveEffectiveIsDark('dark', false), true);
  assert.equal(resolveEffectiveIsDark('light', true), false);

  assert.equal(resolveThemeId('auto', true, 'tokyo-night', 'catppuccin-latte'), 'tokyo-night');
  assert.equal(resolveThemeId('auto', false, 'tokyo-night', 'catppuccin-latte'), 'catppuccin-latte');
  assert.equal(resolveThemeId('dark', false, 'dracula-pro', 'daylight'), 'dracula-pro');
  assert.equal(resolveThemeId('light', true, 'dracula-pro', 'catppuccin-latte'), 'catppuccin-latte');
});

test('DARK_THEMES and LIGHT_THEMES cover every theme in THEMES', () => {
  assert.equal(DARK_THEMES.length + LIGHT_THEMES.length, Object.keys(THEMES).length);
  assert.ok(THEMES['catppuccin-mocha'].isDark);
  assert.ok(THEMES['dracula-pro'].isDark);
  assert.ok(THEMES['nord'].isDark);
  assert.ok(THEMES['tokyo-night'].isDark);
  assert.equal(THEMES['catppuccin-latte'].isDark, false);
});
