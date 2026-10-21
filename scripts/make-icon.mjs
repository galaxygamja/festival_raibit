// 앱 아이콘(src/assets/icon.png, 1024px) 생성: node scripts/make-icon.mjs (ImageMagick `magick` 필요)
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/assets/icon.png');
const SIZE = 1024, K = 26; // 픽셀 1칸 = 26px

const PALETTE = {
  O: '#3A120B', // 외곽선
  X: '#7A2E1C', // 주름
  D: '#B5532F', // 그림자
  M: '#E3854F', // 기본 피부
  L: '#F6AE74', // 밝은 면
  H: '#FFDDB0', // 하이라이트
  W: '#FFD27A', // 소매 밝은 면
  S: '#FFB21E', // 소매
  s: '#C97A10', // 소매 그림자
};
const RAINBOW = ['#2F7BFF', '#5A5CFF', '#9B45F0', '#DA3BB8', '#F93D63', '#FF5E2A', '#FF9A1A', '#FFD61F'];

// 굽힌 팔: 왼쪽 소매 → 이두근 → 팔꿈치(오른쪽 아래) → 팔뚝 → 주먹(위)
const ART = `
.................OO.OO
..............OOOHHOLLOOO
.............OHLXLLXLMXMMO
.............OLLXLLXMMXMDO
.............OLLXLMXMMXDDO
.............OXXXXXXXMXDDO
.............OHHLLLLLOMDDO
......OOOO...OLLLLLMMOMDDO
.....OHHLLO..OXXXXXXXMDDDO
....OHHHLLLO.ODDLMMMMDDDDO
OOOOOHLLLLLLOOOOLMMMDDOOOO
OWSOLLLLLLLLO..OLLMMDDDO
OWSOLLLLLLLLMOLLLMMMMDDDO
OWSOLLLLLLLMMMXLLMMMMDDDDO
OWSOLLLLLLMMMMDXLMMMMDDDDO
OWSOMLLLLLLDDDMMXMMMMDDDDDO
OSsOMLLDDDDMMMMDDXMMMDDDDDO
OSsOMDDMMMMMMMMDDDXMDDDDDDO
OSsOXDDDDDDDDDDDDDDDDDDDDDO
OssOOOOOXDDDDDDDDDDDDDDDDO
OOOO....OOOXXDDDDDDDDDDDO
...........OOOOOOOOOOOO
`.trim().split('\n');
const W = Math.max(...ART.map((r) => r.length)), H = ART.length + 2;
const px = Array.from({ length: H }, () => Array(W).fill(null));
ART.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== '.') px[y][x] = PALETTE[ch]; }));
// 하단 무지개 게이지: 8칸, 칸 폭 2, 간격 1
const g0 = Math.floor((W - 23) / 2);
RAINBOW.forEach((c, i) => { px[H - 1][g0 + i * 3] = px[H - 1][g0 + i * 3 + 1] = c; });

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const body = Buffer.alloc(W * H * 4);
px.flat().forEach((c, i) => { if (c) body.set([...hex(c), 255], i * 4); });
const tmp = mkdtempSync(join(tmpdir(), 'icon-'));
const pam = join(tmp, 'art.pam');
writeFileSync(pam, Buffer.concat([
  Buffer.from(`P7\nWIDTH ${W}\nHEIGHT ${H}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`), body]));
// 픽셀 그림을 정수 배율로 키워 1024 캔버스 가운데에 놓는다
const art = [pam, '-filter', 'point', '-resize', `${W * K}x${H * K}`,
  '-background', 'none', '-gravity', 'center', '-extent', `${SIZE}x${SIZE}`, '+gravity'];

// 타일: 애플 아이콘 그리드(824px, 여백 100px), 둥근 모서리, 호박색 테두리
const rr = 'roundrectangle 100,100 923,923 185,185';
mkdirSync(dirname(OUT), { recursive: true });
execFileSync('magick', [
  '-size', `${SIZE}x${SIZE}`, 'radial-gradient:#2B1511-#140A09',
  '(', '-size', `${SIZE}x${SIZE}`, 'xc:black', '-fill', 'white', '-draw', rr, ')',
  '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', '-compose', 'over',
  '-fill', 'none', '-stroke', '#FFB21E66', '-strokewidth', '6', '-draw', rr,
  '(', ...art, '-alpha', 'extract', '-background', '#FFB21E', '-alpha', 'shape',
  '-blur', '0x48', '-channel', 'A', '-evaluate', 'multiply', '0.4', '+channel', ')', '-composite',
  '(', ...art, ')', '-composite',
  '-strip', `PNG32:${OUT}`,
]);
rmSync(tmp, { recursive: true });
console.log(`wrote ${OUT}`);
