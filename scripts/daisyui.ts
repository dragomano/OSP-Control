import type { Plugin } from 'vite';

// Default keeps literal fallbacks; every other palette replaces colors only.
// Original selectors, dimensions, media queries and container queries stay intact.
export function paletteColors(code: string): string {
  return code.replace(
    /([\w-]+)(\s*:\s*)([^;{}]+)(?=;)/g,
    (declaration, property: string, colon: string, value: string) => {
      if (
        property.startsWith('--k-') ||
        property.startsWith('--lt-') ||
        !/^(?:color|background(?:-color|-image)?|border(?:-[\w-]+)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|--dark-[\w-]+)$/.test(
          property,
        )
      )
        return declaration;
      const foreground = /^(?:color|fill|stroke|caret-color)$/.test(property);
      const border = /border|outline|shadow/.test(property);
      return `${property}${colon}${value.replace(/#[\da-f]{3,8}\b/gi, (hex) => {
        let raw = hex.slice(1);
        if (raw.length === 3 || raw.length === 4) raw = [...raw].map((digit) => digit + digit).join('');
        if (raw.length !== 6 && raw.length !== 8) return hex;
        const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(raw.slice(offset, offset + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let tone = 'neutral';
        if (max - min > 0.13) {
          const hue =
            max === r
              ? ((g - b) / (max - min) + 6) % 6
              : max === g
                ? (b - r) / (max - min) + 2
                : (r - g) / (max - min) + 4;
          tone =
            hue < 0.45 || hue > 5.5
              ? 'error'
              : hue < 1.35
                ? 'warning'
                : hue < 3.3
                  ? 'success'
                  : hue < 4.4
                    ? 'info'
                    : 'secondary';
        }
        const alpha = raw.length === 8 ? Number.parseInt(raw.slice(6), 16) / 255 : 1;
        const role = foreground ? 'ink' : border ? 'line' : 'fill';
        const strength = foreground && max > 0.35 && max < 0.78 ? '-muted' : '';
        return alpha < 1
          ? `var(--ui-${property.includes('shadow') ? 'shadow-' : ''}alpha-${Math.round(alpha * 100)}, ${hex})`
          : `var(--ui-${tone}-${role}${strength}, ${hex})`;
      })}`;
    },
  );
}

export function daisyUIStyles(): Plugin {
  return {
    name: 'osp-palette-colors',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.includes('/src/') || !file.endsWith('.css') || /\/(?:ui|demo)\//.test(file)) return;
      return { code: paletteColors(code), map: null };
    },
  };
}
