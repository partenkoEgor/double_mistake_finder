// Запуск: node test/findDoubleMistakes.test.js
'use strict';
var assert = require('assert');
var path = require('path');
var D = require(path.join(__dirname, '..', 'pay_mena_double_mistake_finder.user.js'));
var fixture = require('./fixtures/history_22961178.json');

var RETURN = '23739196863\r\n// Sir, please attach the approved transaction related to the payment from the ticket or set the right status.';
function row(date, status, admin, comment){
  return {dateEdit:date, nameExternalStatus:status, nameInternalStatus:'', commentSupport:comment || '', adminProcessedLogin:admin};
}
function approved(date){ return row(date, 'Approved (M)', 'Vodafone_Nivus_Main', '23739196863'); }
function ret(date, admin, comment){ return row(date, 'Sent for processing (M)', admin || 'pay_mena_614', comment == null ? RETURN : comment); }

var passed = 0;
function test(name, fn){ fn(); passed++; console.log('  ✓ ' + name); }

test('реальный тикет 22961178: 2 цикла (pay_mena_614, pay_mena_646)', function(){
  var r = D.analyzeHistory(fixture.data);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.isDouble, true);
  assert.deepStrictEqual(r.cycles.map(function(c){ return c.returnedBy; }), ['pay_mena_614', 'pay_mena_646']);
  assert.deepStrictEqual(r.cycles.map(function(c){ return c.approvedAt; }), ['2026-09-28 00:08:24', '2026-10-07 22:28:23']);
  assert.deepStrictEqual(r.cycles.map(function(c){ return c.returnedAt; }), ['2026-10-07 20:12:49', '2026-10-17 05:21:50']);
  assert.strictEqual(r.lastStatus, 'Approved (M) / Customer provided additional info');
});

test('возвраты от pay_cm_mena_* и с другим текстом не считаются', function(){
  var r = D.analyzeHistory(fixture.data);
  r.cycles.forEach(function(c){ assert.ok(/^pay_mena_\d+$/.test(c.returnedBy)); });
});

test('один цикл — не двойная ошибка', function(){
  var r = D.analyzeHistory([approved('2026-10-01 10:00:00'), ret('2026-10-01 12:00:00')]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.isDouble, false);
});

test('возврат без Approved перед ним не считается', function(){
  var r = D.analyzeHistory([ret('2026-10-01 09:00:00'), approved('2026-10-01 10:00:00'), ret('2026-10-01 12:00:00')]);
  assert.strictEqual(r.count, 1);
});

test('два возврата подряд на один Approved = 1 цикл', function(){
  var r = D.analyzeHistory([approved('2026-10-01 10:00:00'), ret('2026-10-01 12:00:00'), ret('2026-10-01 13:00:00', 'pay_mena_646')]);
  assert.strictEqual(r.count, 1);
});

test('3 цикла, порядок API не важен (новые сверху)', function(){
  var rows = [
    approved('2026-10-01 10:00:00'), ret('2026-10-01 12:00:00'),
    approved('2026-10-02 10:00:00'), ret('2026-10-02 12:00:00', 'pay_mena_646', RETURN + '.x2'),
    approved('2026-10-03 10:00:00'), ret('2026-10-03 12:00:00', 'pay_mena_692', 'Sir,please  attach the APPROVED transaction!')
  ].reverse();
  var r = D.analyzeHistory(rows);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.isDouble, true);
});

test('Sent for processing без нужного комментария не считается', function(){
  var r = D.analyzeHistory([
    approved('2026-10-01 10:00:00'), ret('2026-10-01 12:00:00', 'pay_mena_614', '23739196863'),
    approved('2026-10-02 10:00:00'), ret('2026-10-02 12:00:00')
  ]);
  assert.strictEqual(r.count, 1);
});

test('дубли записей из API схлопываются', function(){
  var a = approved('2026-10-01 10:00:00'), b = ret('2026-10-01 12:00:00');
  var r = D.analyzeHistory([a, b, a, b]);
  assert.strictEqual(r.count, 1);
});

test('пустая/битая история', function(){
  assert.strictEqual(D.analyzeHistory([]).count, 0);
  assert.strictEqual(D.analyzeHistory(null).count, 0);
});

// ── Режим In progress
function ipRow(date, status, admin, comment, extra){
  var r = row(date, status, admin, comment);
  Object.keys(extra || {}).forEach(function(k){ r[k] = extra[k]; });
  return r;
}

test('In progress: все 4 вида статуса распознаются, другие — нет', function(){
  ['In progress', 'In progress (M)', 'in progress', ' In Progress (M) '].forEach(function(s){ assert.ok(D.isInProgress(s), s); });
  ['Approved (M)', 'Sent for processing (M)', 'Closed', '', null].forEach(function(s){ assert.ok(!D.isInProgress(s), String(s)); });
});

test('In progress: берётся самая свежая строка истории, порядок API не важен', function(){
  var tk = {idUser:1726618961, nameAgent:'BankTransfer Agents', nameSubagent:'Vodafone Nivus', nameDepartment:'MENA 1x'};
  var rows = [
    ipRow('2026-11-01 10:00:00', 'Sent for processing (M)', 'pay_mena_614', 'sent', tk),
    ipRow('2026-11-02 09:00:00', 'In progress (M)', 'pay_mena_442', 'взял в работу', tk),
    ipRow('2026-11-02 11:30:00', 'In progress (M)', 'pay_mena_646', 'жду ответа банка', tk)
  ].reverse();
  var r = D.analyzeInProgress(rows);
  assert.strictEqual(r.isInProgress, true);
  assert.strictEqual(r.admin, 'pay_mena_646');
  assert.strictEqual(r.comment, 'жду ответа банка');
  assert.strictEqual(r.date, '2026-11-02 11:30:00');
  assert.strictEqual(r.userId, '1726618961');
  assert.strictEqual(r.agent, 'BankTransfer Agents');
  assert.strictEqual(r.subagent, 'Vodafone Nivus');
  assert.strictEqual(r.department, 'MENA 1x');
});

test('In progress: тикет уже вышел из In progress — isInProgress false', function(){
  var r = D.analyzeInProgress([
    row('2026-11-02 09:00:00', 'In progress', 'pay_mena_442', 'взял'),
    row('2026-11-02 10:00:00', 'Approved (M)', 'Vodafone_Nivus_Team_1', 'ok')
  ]);
  assert.strictEqual(r.isInProgress, false);
  assert.strictEqual(r.admin, 'Vodafone_Nivus_Team_1');
});

test('In progress: реальная история 22961178 сейчас в Approved (M)', function(){
  var r = D.analyzeInProgress(fixture.data);
  assert.strictEqual(r.isInProgress, false);
  assert.strictEqual(r.status, 'Approved (M)');
});

test('In progress: пустая история', function(){
  assert.strictEqual(D.analyzeInProgress([]), null);
  assert.strictEqual(D.analyzeInProgress(null), null);
});

console.log('\n' + passed + ' тестов пройдено');
