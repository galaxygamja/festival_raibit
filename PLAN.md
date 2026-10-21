# 계획: SpikerBox 근전도 + 1인 기록 모드 (v2.0.0)

작성 2026-10-20. 구현 전 계획이다. 작업은 **7장의 5개 Phase** 순서로 진행하고, 각 Phase 안의 체크박스(11단계)를 끝날 때마다 체크한다. 결정이 바뀌면 이 문서를 먼저 고친다.

**작업자에게**: 한 번에 한 Phase만 한다. Phase를 시작하기 전에 CLAUDE.md, 이 문서의 1~6장, 해당 Phase 절을 읽는다. Phase가 끝나면 `npm test`가 통과해야 하고, 사용자에게 결과를 보고한 뒤 커밋한다(커밋은 사용자 확인 후). **백엔드(Phase 1~3)를 먼저 끝내고 화면 디자인(Phase 4)은 나중에** 한다.

## 0. 배경 — 무엇이 바뀌나

| | 지금 (v1.2.0) | 바꿀 것 (v2.0.0) |
|---|---|---|
| 근전도 입력 | 아두이노가 `P1 <정수>` / `P2 <정수>` 텍스트 줄을 9600 baud로 보냄 | **SpikerBox**가 보내는 바이너리 원시 파형(수 kHz)을 앱이 직접 해석 |
| START | 같은 아두이노가 `START` 줄을 보냄 | **별도 아두이노**(START 버튼 전용)가 `START` 줄을 보냄 |
| 플레이어 | 2명 대결, 승패 판정 | **1명**, 펀치머신처럼 기록 세우기 (승패 없음) |
| 화면 | 위 WINNER 배너 · 아래 P1 / 명예의 전당 / P2 | 위 배너 가운데 **현재 점수** · 아래 P1 / 명예의 전당 (가운데 정렬) |

아두이노로 근전도를 직접 읽던 방식은 원시값이 1 또는 1023만 나와(포화) 쓸 수 없어서 버렸다.

```
근전도 센서 → SpikerBox ──USB(바이너리, 222222/500000 baud)──┐
                                                               ├→ 노트북 (이 앱)
START 버튼  → 아두이노  ──USB(텍스트, 9600 baud)──────────────┘
```

START가 들어온 순간부터 5초(0.1초 × 50칸) 동안 SpikerBox 신호의 세기를 재고, 50칸 중 최댓값이 기록이 된다.

## 1. SpikerBox 프로토콜 (Spike Recorder에서 확인한 내용)

참고 코드: https://github.com/dohye0508/Spike-Recorder (= `BackyardBrains/Spike-Recorder` 포크, README 번역 외 변경 없음)
`src/engine/ArduinoSerial.cpp`의 해당 부분을 JS로 옮긴다. C++ 코드를 빌드하거나 합치지 않는다.

### 1.1 연결
- baud: `222222`을 먼저 시도하고 응답이 없으면 `500000`. (Pro 계열 CDC 장치는 baud와 무관하게 동작)
- 열고 나서 `b:;\n`을 보내면 기기가 자기 종류를 알려준다(1.3의 `HWT`).
- Backyard Brains 자체 USB 장치는 USB VID `2E73`. 아두이노 기반 SpikerShield는 아두이노 VID를 쓴다.
- Spike Recorder가 같은 포트를 열고 있으면 우리 앱은 열 수 없다. **행사 중에는 Spike Recorder를 끈다.**

### 1.2 샘플 프레임
- 샘플 1개 = 2바이트. 각 바이트는 아래 7비트만 데이터.
- **프레임 첫 바이트만 최상위 비트(0x80)가 1**, 프레임 안의 나머지 바이트는 모두 0x80 비트가 0.
- 값 = `((b0 & 0x7F) << 7) | (b1 & 0x7F)` (0~16383)
- 프레임 1개 = 채널 수 × 2바이트. 채널 1, 채널 2 … 순서.
- 깨진 프레임: 프레임 중간에 0x80 비트가 켜진 바이트가 나오면 지금까지 모은 프레임은 버리고 그 바이트부터 새 프레임으로 본다.
- 중심값(신호 0): 10비트 기기는 512, 14비트 기기(HUMANSB, UNIBOX 등)는 8192. 우리는 구간마다 평균을 빼므로(2장) 중심값을 몰라도 된다.

### 1.3 기기 메시지 (이스케이프 구간)
- 시작 `FF FF 01 01 80 FF`, 끝 `FF FF 01 01 81 FF`. 그 사이는 ASCII 텍스트 `종류:값;` 반복. (`FF FF`는 정상 프레임에서 나올 수 없다. 프레임 시작 바이트 다음 바이트는 항상 0x80 비트가 0이기 때문)
- Spike Recorder는 메시지 버퍼가 넘치면 이스케이프를 강제로 끝낸다. 우리는 64바이트를 넘으면 버리고 끝낸다.
- 예: `HWT:MUSCLESS;` → 기기 종류. 알려진 값(Spike Recorder 기준):

| HWT | 기기 | 샘플레이트 | 채널 | `conf` 명령 필요 |
|---|---|---|---|---|
| `MUSCLESS` | Muscle SpikerShield (아두이노 기반) | 10000 / 채널 수 | 설정값 | 예 |
| `MUSCUSB1` | Muscle SpikerBox (USB) | 10000 / 채널 수 | 설정값 | 예 |
| `MSBPCDC` | Muscle SpikerBox Pro | 10000 | 2 | 아니오 |
| `HUMANSB` | Human SpikerBox | 5000 | 2 | 아니오 |
| `UNIBOX` | (Uni box) | 42661 | 2 | 아니오 |

- `conf` 명령 형식: `conf s:<샘플레이트>;c:<채널수>;\n` (예: 1채널 `conf s:10000;c:1;\n`, 2채널 `conf s:5000;c:2;\n`)
- 이스케이프 구간의 바이트는 샘플로 해석하지 않는다.

### 1.4 FFT
Spike Recorder의 FFT는 **화면 표시용**(0~50 Hz, 뇌파 알파파 확인)이다. 기기가 FFT를 보내지 않는다. 근전도 세기에는 쓰지 않는다.

## 2. 신호 → 점수

1. SpikerBox 프레임에서 **설정한 채널**(기본 1)의 값만 꺼낸다.
2. 메인 프로세스가 **100 ms마다** 그 사이에 들어온 샘플을 한 구간으로 묶는다(샘플 개수가 아니라 시간 기준이라 샘플레이트를 몰라도 된다).
3. 구간의 **AC RMS** = `sqrt(mean(x²) − mean(x)²)` (= 표준편차). 구간 평균을 빼는 것이므로 기기마다 다른 중심값과 전극 드리프트가 함께 없어진다. 근전도 성분(20~450 Hz)은 100 ms 안에 여러 주기가 들어가서 그대로 남는다.
4. **세기** = `max(0, RMS − 휴식RMS)`. 휴식RMS는 관리자 화면의 "영점 잡기"로 3초간 RMS 평균을 재서 설정에 저장한다(기본 0).
5. 세기를 `game.sample('p1', 세기, now)`로 넣는다. 보정계수 곱하기와 0~9999 자르기는 기존 `toScore`가 한다.
6. 구간에 샘플이 하나도 없으면(SpikerBox 끊김) 그 구간은 건너뛴다. 50칸이 안 차면 기존 8초 제한으로 끝난다.

보정계수 기본값은 실제 기기로 쥐어 보고 정한다(그전까지 1.0).

## 3. 시리얼 포트 구분

포트 이름으로 구분하지 않는다(지금 원칙 유지). **열어서 무엇이 오는지**로 역할을 정한다.

1. 새 USB 포트 발견 → 설정 `portRoles[path]`가 있으면 그 역할로 바로 연다.
2. 없으면 **SpikerBox 탐색**: 222222 baud로 열고 `b:;\n` 전송, 1초 동안 받은 바이트를 파서에 넣는다. `HWT` 메시지가 왔거나 정상 프레임이 20개 이상이면 SpikerBox. 아니면 닫고 500000 baud로 한 번 더.
3. 둘 다 아니면 **9600 baud 텍스트 포트**로 다시 연다. `START` 줄이면 게임 시작, `ALIVE` 줄이면 연결 표시만 갱신.
4. 역할이 정해진 포트는 끊길 때까지 다시 탐색하지 않는다. 끊기면 잊고, 다음 검색 때 처음부터.
5. SpikerBox로 정해졌는데 HWT를 아직 모르면 2초마다 `b:;\n`를 다시 보낸다(최대 5번). HWT가 `MUSCLESS`/`MUSCUSB1`이면 `conf` 명령을 보낸다(채널 수 = 설정 채널이 2면 2, 아니면 1).

- START 아두이노는 버튼을 누를 때만 줄을 보내므로 연결 여부를 알 수 없다. 그래서 스케치에서 **1초마다 `ALIVE`**를 보내게 한다.
- 탐색 중 START 아두이노에 222222 baud로 `b:;`가 가도 깨진 바이트일 뿐 해가 없다(스케치는 입력을 읽지 않는다).

## 4. 게임 · 저장 규칙 변경

- 플레이어는 `p1` 하나. `p2`, `winner`, `draw` 제거.
- 측정 종료: p1이 50칸을 채우거나 8초 제한.
- 결과에는 최종 기록(최댓값)과, 명예의 전당에 들어갔으면 **순위(1~5)**가 함께 나온다. 5위 밖이어도 **전체 기록 중 몇 위인지(`place`/`total`)**를 한 번 보여 준다. 이를 위해 userData에 `score-history.json`(`{scores:[...]}`, 0점 제외, 최대 20000개)에 모든 측정 점수를 쌓는다. 동점이면 먼저 세운 기록이 위.
- 명예의 전당: 기존 규칙 유지(상위 5개, 0점 제외, 동점이면 먼저 세운 기록이 위, 새 기록 이름 `ㅇㅇㅇ`). 새 기록에는 `player` 필드를 넣지 않는다. v1 파일의 `player` 필드는 읽을 때 버린다.
- 설정 v2 형식:

```js
{
  calibration: 1.0,                 // 숫자 하나 (0.001~1000). v1의 {p1, p2}면 p1 값을 가져온다
  emg: { channel: 1, restRms: 0 },  // channel: 1|2, restRms: 0 이상
  portRoles: {},                    // { [path]: 'spikerbox' | 'start' }. 없는 path는 자동 판별
  fullscreen: true,
}
```

## 5. 화면 (Phase 4에서 할 일)

### 5.1 관중 화면

```
지금                                         바꾼 뒤
┌──────────── WINNER / PLAYER 1 ───────────┐  ┌──────── 측정 중 / 최종 기록 ────────┐
└──────────────────────────────────────────┘  │              [ 0 1 2 3 ]             │  ← 점수(7-segment)
┌P1 패널┐ ┌─명예의 전당─┐ ┌P2 패널┐            └─────────────────────────────────────┘
│ 미터  │ │             │ │  미터 │                 ┌P1 패널┐ ┌─명예의 전당─┐
│ 숫자  │ │             │ │  숫자 │                 │ 미터  │ │             │
└───────┘ └─────────────┘ └───────┘                 └───────┘ └─────────────┘
                                                     (P2 자리를 없애고 두 칸을 가운데로)
```

- **P2 패널 삭제.** P1 패널(폭 420)과 명예의 전당(지금 실제 폭 408 = 1328 − 420×2 − 40×2)은 크기를 그대로 두고 가로 가운데 정렬한다. 명예의 전당은 `flex-grow` 대신 고정 폭 408px로 바꾼다.
- **배너**(폭 980, `nowrap` 유지): "WINNER"와 승자 글자를 없애고, P1 패널에 있던 7-segment 숫자를 배너 가운데로 옮긴다. 크기는 `Seg.display(Seg.pad(v), 110, color)` 정도로 하고 배너 높이 안에 맞춘다.
  - 윗줄 작은 글씨: 대기 `START 버튼을 누르세요` / 측정 `5초 동안 힘껏 쥐세요` / 결과 `최종 기록`, 명예의 전당에 들어갔으면 `명예의 전당 n위!`
  - 숫자: 측정 중에는 현재 힘, 그 밖에는 최댓값(지금 `targetOf` 규칙 그대로, 애니메이션 유지).
- **P1 패널**: 레벨 미터, `PLAYER 1`, 측정 중 `측정 n / 50 · 최고 x` + 진행 막대, 대기 중 `레벨 n / 15`.

### 5.2 관리자 화면
- 경기 제어: 상태 문구 `측정 중` / `기록 n점 · 다음 도전 대기` / `대기 중 · START 대기`. 버튼 문구 "새 경기 시작" → "측정 시작".
- 연결 카드 제목 "아두이노 연결" → "장치 연결". 행 2개:
  - **SpikerBox**: 포트, HWT, 채널 수, 초당 프레임 수, 연결 여부, 현재 RMS 막대.
  - **START 버튼**: 포트, 마지막 `START` 시각, 연결 여부.
  - 열린 포트마다 역할 드롭다운(자동 / SpikerBox / START).
- 보정 설정: 보정계수 1개, 채널(1/2), **영점 잡기** 버튼 + 현재 휴식RMS.
- 명예의 전당 표: "기록한 선수" 열 삭제, 날짜·시각은 이름 옆 작은 글씨로.

## 6. START 아두이노 스케치

`arduino/start_button/start_button.ino` (새 파일)
- 9600 baud, 버튼 핀 2번 `INPUT_PULLUP`(버튼 반대쪽은 GND). 핀 번호는 맨 위 상수.
- 누르는 순간(HIGH→LOW)만, 30 ms 디바운스 후 `START\n` 한 번. 누르고 있어도 반복하지 않음.
- `millis()` 기준 1초마다 `ALIVE\n`. `delay()`로 루프를 막지 않는다.
- 팀에 기존 START 스케치가 있으면 출력 형식만 이에 맞춘다.

---

## 7. 작업 Phase

| Phase | 내용 | 체크리스트 | 버전 | 화면 |
|---|---|---|---|---|
| 1 | SpikerBox 파서 + 신호 처리 (순수 모듈) | 1, 2 | 그대로 | 변화 없음 |
| 2 | 게임·명예의 전당·설정 1인화 | 3 | `2.0.0-beta.1` | 최소 수정 |
| 3 | 시리얼·시뮬레이터·main 연결 + START 스케치 | 4, 5, 6, 9 | `2.0.0-beta.2` | 최소 수정 |
| 4 | 화면 디자인 | 7, 8 | `2.0.0-beta.3` | 개편 |
| 5 | 마무리 · 하드웨어 테스트 | 10, 11 | `2.0.0` | – |

**두 채팅으로 나눠 진행할 때**
- **채팅 A (백엔드)**: Phase 1 → 2 → 3 → 5. **채팅 B (화면)**: Phase 4.
- B는 **Phase 2가 커밋된 뒤에** 시작해서 A의 Phase 3와 동시에 진행한다. Phase 2 전에는 게임 상태 모양이 아직 v1이라 화면을 만들 근거가 없다.
- B는 반드시 **별도 worktree/브랜치**에서 작업한다. A는 `main`(또는 A의 브랜치)에서 작업한다.
- 파일 소유:
  - A: `src/main/**`, `src/preload.js`, `test/**`, `arduino/**`.
  - B: `src/renderer/**`(`app.js`, `index.html`, `styles.css`, `segments.js`).
  - `package.json` 버전, PLAN.md 체크박스: A만 고친다. B는 PLAN.md 체크를 보고만 하고, 버전은 합칠 때 정한다.
- 동시 진행 중에는 **A가 Phase 3의 "관리자 화면 최소 수정"을 하지 않는다.** 연결 카드, 영점 잡기, 채널 선택은 B가 아래 계약대로 만든다.
- 둘은 아래 **payload 계약**만 믿고 작업한다. 계약을 바꿔야 하면 PLAN.md를 먼저 고치고 사용자에게 알린다.
- 합치기: A의 Phase 3가 끝난 뒤 B 브랜치를 합친다. `src/renderer/**`에서 충돌이 나면 B 쪽을 택한다. 합친 뒤 `npm run sim`으로 연결 카드와 영점 잡기를 실제 payload로 확인한다.
- B는 Phase 3가 합쳐지기 전까지 `ports`와 `emg`가 아직 v1 모양이거나 없을 수 있다. 렌더러는 이 값들이 없어도 죽지 않게 짠다(없으면 "연결 끊김"과 0으로 표시).

**payload 계약 (v2, main → renderer `state`)**

```js
{
  game: { phase: 'idle'|'measuring'|'result', samplesNeeded: 50, p1: { score, current, samples } },
  result: { score, rank, place, total } | null, // rank: 명예의 전당 1~5 또는 null. place: 전체 기록 중 순위(5위 밖도, 0점이면 null), total: 전체 기록 수. START 때 null
  hall: [{ id, name, score, at }],     // player 필드 없음
  ports: {
    spikerbox: { connected, path, hwt, name, channels, baud, fps },
    start:     { connected, path, lastStartAt },
    open: [{ path, role: 'probing'|'spikerbox'|'start', fixed }],
  },
  emg: { rms, strength, restRms, zeroing },
  settings: { calibration, emg: { channel, restRms }, portRoles, fullscreen },
  sim, platform, fullscreen, saveError, dataDir,
}
// window.api 추가: zeroEmg(), setPortRole(path, role)  ('auto' | 'spikerbox' | 'start')
// window.api 기존: getState, onState, start, stop, saveNames, reconnect, saveSettings({calibration, emg}), setSim, simKey, toggleFullscreen, quit
// simKey: 's', 'a', 'release' 만 사용
```

**공통 규칙**
- 코드 스타일은 주변 코드를 따른다: `'use strict'`, CommonJS, 한국어 주석은 짧게, 렌더러는 ES5 스타일(`var`, `function`).
- 테스트는 `test/game.test.js` 한 파일에 `test('설명', () => {...})`로 추가한다. 새 모듈은 Electron과 `serialport` 없이 `require` 가능해야 한다.
- Phase 2·3에서 화면은 **앱이 죽지 않고 동작이 보일 정도로만** 고친다. 모양은 Phase 4에서 다듬는다.

### Phase 1 — SpikerBox 파서 + 신호 처리

새 파일 2개. 기존 코드는 건드리지 않는다. Electron 없이 테스트로만 검증한다.

- [x] **1. `src/main/spikerbox.js`**

```js
const ESC_START = [0xFF, 0xFF, 0x01, 0x01, 0x80, 0xFF];
const ESC_END   = [0xFF, 0xFF, 0x01, 0x01, 0x81, 0xFF];
const DEVICES = { MUSCLESS: { name: 'Muscle SpikerShield', needsConf: true }, MUSCUSB1: {...}, MSBPCDC: {...}, HUMANSB: {...}, UNIBOX: {...} }; // 1.3 표

class SpikerBoxParser {
  constructor({ channels = 'auto' } = {})  // 'auto' 또는 1~6
  push(buf)        // Buffer | Uint8Array | number[] → { frames: number[][], messages: {type, value}[] }
                   // frames[i] = [ch1, ch2, ...] 원시값 0~16383
  get channels()   // 확정된 채널 수, 'auto'에서 아직 모르면 null
  reset()
}
function parseMessageText(text)   // 'HWT:MUSCLESS;EVNT:3;' → [{type:'HWT', value:'MUSCLESS'}, {type:'EVNT', value:'3'}]
function encodeFrames(frames)     // number[][] → Buffer  (시뮬레이터·테스트용, 파서의 역)
function encodeMessage(text)      // 'HWT:MUSCLESS;' → ESC_START + ASCII + ESC_END 를 담은 Buffer
module.exports = { SpikerBoxParser, parseMessageText, encodeFrames, encodeMessage, DEVICES, ESC_START, ESC_END };
```

구현 규칙:
- 바이트 하나씩 처리하는 상태 기계. 청크 경계(프레임이나 이스케이프가 두 번의 `push`에 걸침)에서도 같은 결과가 나와야 한다.
- 이스케이프 감지: `ESC_START`의 앞부분과 일치하는 바이트는 판정이 날 때까지 **보류**한다(최대 5바이트). 6바이트가 다 맞으면 이스케이프 모드로 들어간다. 중간에 어긋나면 보류한 바이트를 순서대로 프레임 처리기에 흘려보낸다. 이스케이프 모드에서는 `ESC_END`가 나올 때까지 텍스트를 모으고, 64바이트를 넘으면 버리고 이스케이프를 끝낸다.
- 프레임 처리: 0x80 비트가 켜진 바이트면 모으던 프레임을 버리고 새 프레임을 시작한다. 프레임 밖에서 0x80이 꺼진 바이트는 버린다. 2바이트씩 값을 만들고, 채널 수만큼 모이면 `frames`에 넣는다.
- `channels: 'auto'`: 처음 프레임 시작 바이트 사이의 간격(바이트 수 / 2)을 30번 세어 가장 많이 나온 값으로 확정한다. 확정 전에는 frames를 내보내지 않는다(버려도 됨). 1~6 범위 밖이면 계속 센다.

- [x] **2. `src/main/emg.js`**

```js
class EmgWindow {
  add(values)       // number[] (선택 채널의 원시값들)
  take()            // 지금까지 모은 것으로 { rms, count } 를 돌려주고 비움. count === 0 이면 null
}
function strengthOf(rms, restRms)   // max(0, rms - restRms)
class RestMeter {                   // 영점 잡기
  constructor(durationMs = 3000)
  start(now)
  add(rms, now)     // 구간 RMS를 넣음. 끝나면 true
  get running()
  result()          // 모은 RMS 평균 (없으면 0)
}
module.exports = { EmgWindow, strengthOf, RestMeter };
```

- RMS는 2장 3번 식. 합과 제곱합만 누적한다(배열에 쌓지 않음). 수치 오차로 음수가 나오면 0으로 둔다.

**테스트 (Phase 1)**
- 1채널 프레임 3개를 `encodeFrames` → `push` → 같은 값 3개. 2채널도 같은 방식.
- 같은 바이트열을 1바이트씩 나눠 `push`해도 결과가 같다.
- 프레임 중간에 0x80 바이트를 끼우면 그 프레임만 빠지고 다음 프레임은 정상.
- `encodeMessage('HWT:MUSCLESS;')`를 프레임 사이에 끼우면 messages에 `{type:'HWT', value:'MUSCLESS'}`가 나오고 frames는 그대로. 이스케이프를 청크 중간에서 잘라도 같다.
- `channels:'auto'`로 2채널 프레임 40개를 넣으면 `channels === 2`이고 값이 맞다.
- `parseMessageText`: 여러 메시지, 빈 문자열, `:` 없는 조각은 무시.
- EmgWindow: 상수 512만 넣으면 rms 0. `512 + A·sin`을 한 주기 이상 넣으면 rms ≈ A/√2(오차 1% 이내). 비어 있으면 `take()`가 null. `take()` 뒤에는 비어 있다.
- `strengthOf(100, 30) === 70`, `strengthOf(10, 30) === 0`.
- RestMeter: 3초 동안 넣은 RMS의 평균. 3초 전에는 `add`가 false.

**완료 기준**: `npm test` 통과. `npm run sim`은 v1 그대로 동작한다.

### Phase 2 — 게임 · 명예의 전당 · 설정 1인화

- [x] **3. `game.js`, `hall.js`, `store.js`, 화면 최소 수정**

`game.js`
- `p2`, `winner` 제거. `start`, `stop`, `sample('p1', raw, now)`, `tick`는 그대로 두되 p1만 본다. 종료 조건은 `p1.samples >= 50` 또는 8초.
- `onResult({ score })`를 호출한다.
- `snapshot()` → `{ phase, samplesNeeded, p1: {score, current, samples} }`.
- 보정계수: `getSettings().calibration`(숫자).

`hall.js`
- `applyResult(hall, score, date)` → `{ hall, changed, rank }`. rank는 들어갔으면 1~5, 아니면 `null`.
- `makeEntry(score, date)`는 `player` 없이 `{id, name, score, at}`.
- `normalizeHall`은 `player`를 버린다.

`store.js`
- `DEFAULT_SETTINGS`와 `normalizeSettings`를 4장의 v2 형식으로 바꾼다. `calibration`이 객체면 `.p1`을 쓴다. `emg.channel`은 1 또는 2만 허용(그 밖은 1). `restRms`는 0~100000. `portRoles`는 값이 `'spikerbox'|'start'`인 항목만 남긴다.

`main.js`
- `lastResult = { score, rank }`를 두고 `start` 때 `null`로 비운다. `onResult`에서 `hall.applyResult`의 rank를 담는다. payload에 `result: lastResult`를 추가한다.
- `settings:save`의 calibration 병합을 숫자 기준으로 바꾼다(`emg`는 객체 병합).

화면 최소 수정(`app.js`, `index.html`)
- `g.p2`와 `winner`를 쓰는 곳 정리: P2 패널을 그리지 않고, 배너 큰 글씨는 결과면 `최종 기록`, 측정 중 `측정 중`, 대기 `START 버튼을 누르세요`.
- 관리자: `cal-p2` 입력 삭제, `cal-p1` → `cal`. 저장 시 `{ calibration: 숫자 }`. 상태 문구에서 승패 제거. 명예의 전당 표의 `d.player` 표시는 빈 칸으로.
- `sim.js`: `L`, `T` 키 제거, p1만 보냄(바이트 스트림 시뮬레이션은 Phase 3).

**테스트 (Phase 2)**: 기존 P1/P2/DRAW 테스트를 1인 기준으로 고친다.
- 50칸 → RESULT, 현재 값과 최댓값이 따로 유지, 50칸 넘는 값 무시, 8초 타임아웃, 측정 중 START 무시, stop.
- `applyResult` rank: 빈 전당 → 1, 5개 꽉 찼고 5위보다 낮음 → null, 동점이면 기존 기록 아래.
- v1 설정 `{calibration:{p1:2,p2:3}}` → `calibration === 2`, `emg`/`portRoles` 기본값.
- v1 전당 파일(`player` 있음)을 읽어도 정상, 저장하면 `player` 없음.

**완료 기준**: `npm test` 통과. `npm run sim -- --windowed`에서 S → A 누르기 → 5초 뒤 결과, 명예의 전당 갱신, 관리자 화면이 열리고 보정 저장 동작. 버전 `2.0.0-beta.1`.

### Phase 3 — 시리얼 · 시뮬레이터 · main 연결 + START 스케치

- [x] **4. `src/main/serial.js` 역할 판별**

```js
class SerialManager extends EventEmitter {
  constructor({ getSettings })
  // 이벤트
  //   'start'                        START 줄
  //   'emg', values: number[]        SpikerBox 선택 채널의 원시값 묶음 (데이터가 올 때마다)
  //   'device', info                 HWT를 알게 됐을 때 {path, hwt, name}
  start(); stopAll(); reconnect();
  feedSpikerBox(path, buf)            // 시뮬레이터가 실제 포트 대신 바이트를 넣는 입구
  status(now) → {
    spikerbox: { connected, path, hwt, name, channels, baud, fps },  // connected = 1초 안에 프레임 수신
    start:     { connected, path, lastStartAt },                    // connected = 3초 안에 START/ALIVE 수신
    open: [{ path, role: 'probing'|'spikerbox'|'start', fixed: bool }],
  }
}
function parseLine(line)  // 'START' → {type:'start'}, 'ALIVE' → {type:'alive'}, 나머지 null (대소문자·\r·공백 무시)
function classifyProbe({ messages, frameCount })  // HWT 메시지가 있거나 frameCount >= 20 → true
```

- 포트마다 `SpikerBoxParser`를 하나씩 둔다. 선택 채널(`settings.emg.channel`)이 프레임 채널 수보다 크면 채널 1을 쓴다.
- 탐색 순서와 HWT 재요청, `conf` 전송은 3장 그대로 따른다. 포트를 닫고 다시 열 때는 `close` 콜백 뒤에 연다.
- 기존 원칙 유지: USB가 아닌 포트는 건너뛰기, 2초마다 재검색, 끊기면 잊기, 열기 실패면 다음 검색 때 다시.
- 9600 텍스트 포트는 기존 `ReadlineParser` 방식. `P1`/`P2` 줄 지원은 없앤다.

- [x] **5. `src/main/sim.js` 가짜 SpikerBox**
- 켜지면 `serial.feedSpikerBox('시뮬레이션', encodeMessage('HWT:MUSCLESS;'))`를 한 번 보낸다.
- 10 ms마다 1채널 샘플 100개(=10 kHz)를 만들어 `encodeFrames`로 보낸다. 값 = `512 + 진폭·(사인 80 Hz + 잡음)`, 0~1023으로 자름.
- 진폭은 `A` 키를 누르는 동안 서서히 올라가고(목표 ≈ 400), 떼면 서서히 내려간다(쉬는 잡음 ≈ 5). 지금 `tick`의 따라가기 방식을 그대로 쓴다.
- `S` 키는 지금처럼 main에서 `game.start`.

- [x] **6. `main.js` · `preload.js` 연결**
- `const emgWin = new EmgWindow()`. `serial.on('emg', v => emgWin.add(v))`.
- 100 ms 타이머: `w = emgWin.take()`. 있으면 `live = { rms: w.rms, strength: strengthOf(w.rms, settings.emg.restRms) }`, 영점 측정 중이면 `rest.add(w.rms, now)`(끝나면 `settings.emg.restRms = rest.result()` 저장), 그리고 `game.sample('p1', live.strength, now())`. 측정 중이 아닐 때는 game이 무시하므로 항상 불러도 된다.
- `serial.on('start', ...)`는 그대로.
- IPC 추가: `emg:zero`(RestMeter 시작), `serial:setRole(path, role)`(`role`이 `'auto'`면 삭제 → 저장 → 그 포트 다시 열기).
- payload 추가: `emg: { rms, strength, restRms, zeroing }`. `ports`는 새 `status()` 형식.
- `preload.js`: `zeroEmg()`, `setPortRole(path, role)`.
- 관리자 화면 최소 수정: 연결 카드에 SpikerBox / START 두 줄(연결 여부와 포트, HWT), "영점 잡기" 버튼, 채널 선택. 모양은 Phase 4. **(두 채팅 진행 시 채팅 B가 Phase 4에서 만든다. 채팅 A는 하지 않았다.)**

- [x] **9. START 스케치** — 6장 그대로 `arduino/start_button/start_button.ino` 작성.

**테스트 (Phase 3)**
- `parseLine`: `START`, ` start\r`, `ALIVE`, `P1 100`(→ null), 빈 줄.
- `classifyProbe`: HWT만 있음 → true, 프레임 25개 → true, 프레임 5개 → false.
- 시뮬레이터 바이트를 직접 파서 + EmgWindow에 넣으면(타이머 없이 `tick` 호출) `A`를 누른 상태의 RMS가 뗀 상태보다 10배 이상 크다.

**완료 기준**: `npm test` 통과. `npm run sim -- --windowed`에서 관리자 화면에 SpikerBox `시뮬레이션 · MUSCLESS` 연결됨, A를 누르면 RMS가 오르고, 영점 잡기 후 쉬는 상태의 세기가 0 근처, S → 5초 측정 → 결과 정상. 실제 포트가 없어도 오류 없이 돈다. 버전 `2.0.0-beta.2`.

### Phase 4 — 화면 디자인

- [x] **7. 관중 화면** — 5.1 그대로.
- [x] **8. 관리자 화면** — 5.2 그대로.

- 디자인 언어(색, Do Hyeon 글꼴, 패널 배경 `#1C0F0D`, 테두리 `#3A2420`, 앰버 `#FFB21E`, 7-segment)는 그대로 쓴다.
- 애니메이션 루프는 `p1` 하나만 다룬다. 배너 숫자 칸 id는 `score-digits`.
- `renderAdminRows`가 입력 중인 이름을 지키는 동작을 유지한다.

**완료 기준**: 1440×900 창과 그보다 작은 창에서 글자가 넘치거나 줄바꿈되지 않는다(특히 배너). 대기 / 측정 / 결과(전당 진입·미진입) 네 상태를 시뮬레이션으로 모두 확인. 버전 `2.0.0-beta.3`.

### Phase 5 — 마무리 · 하드웨어 테스트

- [x] **10. 마무리**
  - `package.json`: version `2.0.0`, description `raibitScoreboard - 근전도 기록 측정`.
  - README: 하드웨어 구성(SpikerBox + START 아두이노), 영점 잡기·보정 방법, 시뮬레이션 키(S/A).
  - CLAUDE.md: "(v2)" 표시와 "Current status" 절 정리, v1 설명 삭제.
  - `design/`은 초기 스펙으로 그대로 둔다.
- [ ] **11. 하드웨어 테스트**(현장, 사용자와 함께)
  - 완료(2026-10-21, 사용자 확인): 행사 노트북에서 자동 보정 후 실제 점수 확인. 아래 나머지(macOS baud, START 버튼, Windows exe)는 아직.
  - SpikerBox 연결 → 관리자 화면의 HWT·채널·fps 확인 → 1장 표와 다르면 이 문서 고치기.
  - macOS에서 222222 baud가 열리는지(10장). 안 되면 230400으로 시도하는 코드 추가.
  - 영점 잡기 → 여러 사람이 힘껏 쥐어 보고 최고 점수가 9999에 닿지 않게 보정계수 기본값 결정.
  - START 버튼 → 측정 시작 확인. Windows exe 빌드 후 실제 Windows에서 실행.

## 8. 확인이 필요한 것 (열린 질문)

1. **SpikerBox 정확한 모델**: baud, 채널 수, `conf` 명령 필요 여부가 달라진다. 모르면 자동 탐색에 맡기고 첫 연결 때 관리자 화면의 HWT로 확인.
2. **근전도 센서를 꽂는 채널**: 기본 채널 1로 가정.
3. **START 아두이노 스케치가 이미 있는지**: 있으면 출력 형식만 맞추고, 없으면 6장대로 새로 작성.
4. **결과 화면의 "명예의 전당 n위!" 표시**: 계획에는 넣어 둠.

## 9. 위험 요소

- **macOS의 비표준 baud(222222)**: node `serialport`가 macOS에서 임의 baud를 여는지 실제 기기로 확인 필요. 안 되면 230400으로 시도.
- **탐색이 START 아두이노를 늦게 잡음**: 탐색에 최대 2초 + 재열기가 걸린다. `portRoles`로 고정하면 바로 열린다.
- 실제 EMG 하드웨어, 실제 Windows exe, 전체화면 전환은 여전히 미검증.
