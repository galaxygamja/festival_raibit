'use strict';

// 기록 목록. 모든 측정 기록(0점 제외)을 { id, name, score, at } 로 남기고,
// 명예의 전당은 그중 상위 5개(점수 내림차순, 같은 점수면 먼저 세운 기록이 위)다.
// 관리자는 어떤 기록이든 이름·점수를 고치거나 지울 수 있다.

const HALL_SIZE = 5;
const TEMP_NAME = 'ㅇㅇㅇ';
const MAX_NAME_LENGTH = 20;
const MAX_SCORE = 9999;
const MAX_RECORDS = 20000;
const EPOCH = new Date(0).toISOString();

function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return s || TEMP_NAME;
}

function cleanScore(v) {
  if (v === null || v === '' || typeof v === 'boolean') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(MAX_SCORE, n));
}

/** 점수 내림차순, 같으면 먼저 세운 기록(at 오름차순)이 위. 새 배열을 돌려준다. */
function sortRecords(list) {
  return list.slice().sort((a, b) => b.score - a.score || a.at.localeCompare(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 명예의 전당: 0점을 뺀 상위 5개 */
function hallOf(records) {
  return sortRecords(records.filter((e) => e.score > 0)).slice(0, HALL_SIZE);
}

let seq = 0;
function makeEntry(score, date, name) {
  seq += 1;
  return {
    id: date.getTime().toString(36) + '-' + seq.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: cleanName(name),
    score,
    at: date.toISOString(),
  };
}

/**
 * 측정 결과 하나를 기록한다. 0점은 남기지 않는다.
 * rank = 명예의 전당 순위(1~5, 밖이면 null), place = 전체 기록 중 순위, total = 전체 기록 수
 */
function addResult(records, score, date = new Date(), name = null) {
  if (!(score > 0)) return { records, changed: false, rank: null, place: null, total: records.length };
  const entry = makeEntry(score, date, name);
  let next = records.concat([entry]);
  if (next.length > MAX_RECORDS) next = sortRecords(next).slice(0, MAX_RECORDS);
  const place = sortRecords(next).indexOf(entry) + 1;
  const rank = hallOf(next).indexOf(entry) + 1;
  return { records: next, changed: true, rank: rank || null, place: place || null, total: next.length, id: entry.id, name: entry.name };
}

/** edits: { [id]: { name?, score? } }. 없는 id·잘못된 점수는 무시. */
function editRecords(records, edits) {
  if (!edits || typeof edits !== 'object') return records;
  return records.map((e) => {
    if (!Object.prototype.hasOwnProperty.call(edits, e.id)) return e;
    const ed = edits[e.id];
    if (!ed || typeof ed !== 'object') return e;
    const next = { ...e };
    if ('name' in ed) next.name = cleanName(ed.name);
    if ('score' in ed) {
      const s = cleanScore(ed.score);
      if (s !== null) next.score = s;
    }
    return next;
  });
}

function deleteRecords(records, ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  return records.filter((e) => !set.has(e.id));
}

/** 파일에서 읽은 값이 이상해도 앱이 죽지 않게 정리 (v1 의 player 필드는 버린다) */
function normalizeRecords(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((e, i) => {
    if (!e || cleanScore(e.score) === null) return;
    let id = String(e.id || 'legacy-' + i);
    while (seen.has(id)) id += '-' + i;
    seen.add(id);
    out.push({
      id,
      name: cleanName(e.name),
      score: cleanScore(e.score),
      at: typeof e.at === 'string' ? e.at : EPOCH,
    });
  });
  return out.slice(-MAX_RECORDS);
}

/**
 * v2.0.x 의 두 파일(명예의 전당 5개 + 점수만 있는 전체 기록)을 하나의 기록 목록으로 합친다.
 * 전체 기록의 점수 중 명예의 전당에 같은 점수가 있으면 그 기록(이름 포함)으로 보고, 나머지는 임시 이름으로 만든다.
 */
function migrateRecords(hallRaw, historyRaw) {
  const hall = normalizeRecords(hallRaw);
  const left = new Map();
  hall.forEach((e) => left.set(e.score, (left.get(e.score) || 0) + 1));
  const out = hall.slice();
  (Array.isArray(historyRaw) ? historyRaw : []).forEach((v, i) => {
    const s = cleanScore(v);
    if (!s) return;
    if (left.get(s)) {
      left.set(s, left.get(s) - 1);
      return;
    }
    out.push({ id: 'history-' + i, name: TEMP_NAME, score: s, at: EPOCH });
  });
  return out.slice(-MAX_RECORDS);
}

module.exports = {
  HALL_SIZE, TEMP_NAME, MAX_RECORDS,
  cleanName, cleanScore, sortRecords, hallOf, addResult, editRecords, deleteRecords, normalizeRecords, migrateRecords,
};
