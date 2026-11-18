import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK_THEMES,
  LIGHT_THEMES,
  THEMES,
  normalizeThemeSetting,
  resolveThemeId,
} from './themes';

test('normalizeThemeSetting defaults to auto, migrates legacy nordic, and validates known themes', () => {
  assert.equal(normalizeThemeSetting(null), 'auto');
  assert.equal(normalizeThemeSetting(undefined), 'auto');
  assert.equal(normalizeThemeSetting('unknown-theme'), 'auto');
  assert.equal(normalizeThemeSetting('auto'), 'auto');
  assert.equal(normalizeThemeSetting('nordic'), 'nord');
  assert.equal(normalizeThemeSetting('catppuccin-mocha'), 'catppuccin-mocha');
  assert.equal(normalizeThemeSetting('dracula-pro'), 'dracula-pro');
  assert.equal(normalizeThemeSetting('tokyo-night'), 'tokyo-night');
});

test('resolveThemeId switches between dark and light themes in auto mode', () => {
  assert.equal(resolveThemeId('auto', true), 'obsidian');
  assert.equal(resolveThemeId('auto', false), 'daylight');
  assert.equal(resolveThemeId('auto', true, 'tokyo-night', 'catppuccin-latte'), 'tokyo-night');
  assert.equal(resolveThemeId('auto', false, 'tokyo-night', 'catppuccin-latte'), 'catppuccin-latte');
});

test('resolveThemeId preserves explicit theme selection regardless of system color scheme', () => {
  assert.equal(resolveThemeId('dracula-pro', false), 'dracula-pro');
  assert.equal(resolveThemeId('catppuccin-latte', true), 'catppuccin-latte');
  assert.equal(resolveThemeId('nord', false), 'nord');
});

test('DARK_THEMES and LIGHT_THEMES cover every theme in THEMES', () => {
  assert.equal(DARK_THEMES.length + LIGHT_THEMES.length, Object.keys(THEMES).length);
  assert.ok(THEMES['catppuccin-mocha'].isDark);
  assert.ok(THEMES['dracula-pro'].isDark);
  assert.ok(THEMES['nord'].isDark);
  assert.ok(THEMES['tokyo-night'].isDark);
  assert.equal(THEMES['catppuccin-latte'].isDark, false);
});
