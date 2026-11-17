export type Oklch = { l: number; c: number; h: number };
type Triple = [number, number, number];
const multiply = (matrix: number[][], vector: number[]): Triple =>
  matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0)) as Triple;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const gamma = (value: number) => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);

// CSS Color 4's D65 conversion matrices. Chroma reduction keeps generated companions
// inside sRGB without changing their hue or lightness.
function linearRgb({ l, c, h }: Oklch): Triple {
  const radians = (h * Math.PI) / 180;
  const lms = multiply(
    [
      [1, 0.3963377773761749, 0.2158037573099136],
      [1, -0.1055613458156586, -0.0638541728258133],
      [1, -0.0894841775298119, -1.2914855480194092],
    ],
    [l, c * Math.cos(radians), c * Math.sin(radians)],
  ).map((value) => value ** 3);
  const xyz = multiply(
    [
      [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
      [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
      [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
    ],
    lms,
  );
  return multiply(
    [
      [12831 / 3959, -329 / 214, -1974 / 3959],
      [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
      [705 / 12673, -2585 / 12673, 705 / 667],
    ],
    xyz,
  );
}
export function parsePaletteColor(value: string): Oklch | null {
  const match = value.match(/^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([\d.-]+)\s*\)$/);
  if (match) return { l: Number(match[1]) / (match[2] ? 100 : 1), c: Number(match[3]), h: Number(match[4]) };
  if (!/^#[\da-f]{6}$/i.test(value)) return null;
  const rgb = [1, 3, 5].map((offset) => linear(parseInt(value.slice(offset, offset + 2), 16) / 255));
  const lms = multiply(
    [
      [0.4122214708, 0.5363325363, 0.0514459929],
      [0.2119034982, 0.6806995451, 0.1073969566],
      [0.0883024619, 0.2817188376, 0.6299787005],
    ],
    rgb,
  ).map((value) => Math.cbrt(value));
  const [l, a, b] = multiply(
    [
      [0.2104542553, 0.793617785, -0.0040720468],
      [1.9779984951, -2.428592205, 0.4505937099],
      [0.0259040371, 0.7827717662, -0.808675766],
    ],
    lms,
  );
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}
export function paletteHex(color: Oklch): string {
  const inGamut = (rgb: number[]) => rgb.every((value) => value >= -0.000001 && value <= 1.000001);
  const encode = (rgb: number[]) =>
    `#${rgb
      .map((value) =>
        Math.round(gamma(clamp(value)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  const original = linearRgb(color);
  if (inGamut(original)) return encode(original);
  let low = 0,
    high = color.c;
  for (let i = 0; i < 20; i++) {
    const middle = (low + high) / 2;
    if (inGamut(linearRgb({ ...color, c: middle }))) low = middle;
    else high = middle;
  }
  return encode(linearRgb({ ...color, c: low }));
}
export function paletteContrast(first: string, second: string): number {
  const luminance = (value: string) => {
    const parsed = parsePaletteColor(value);
    if (!parsed) return 0;
    const hex = value.startsWith('#') ? value : paletteHex(parsed);
    const rgb = [1, 3, 5].map((offset) => linear(parseInt(hex.slice(offset, offset + 2), 16) / 255));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function paletteContent(fill: string, preferred?: string): string {
  if (preferred && parsePaletteColor(preferred) && paletteContrast(fill, preferred) >= 4.5) return preferred;
  return paletteContrast(fill, '#ffffff') >= paletteContrast(fill, '#000000') ? '#ffffff' : '#000000';
}
export function paletteInk(color: string, surfaces: string[], light: boolean): string {
  const parsed = parsePaletteColor(color);
  if (!parsed) return color;
  for (let i = 0; i <= 100; i++) {
    const result = i ? paletteHex({ ...parsed, l: clamp(parsed.l + ((light ? -1 : 1) * i) / 100) }) : color;
    if (surfaces.every((surface) => paletteContrast(result, surface) >= 4.5)) return result;
  }
  return light ? '#000000' : '#ffffff';
}
