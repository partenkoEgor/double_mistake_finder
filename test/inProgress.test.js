// Запуск: node test/inProgress.test.js
'use strict';
var assert = require('assert');
var path = require('path');
var D = require(path.join(__dirname, '..', 'pay_mena_in_progress_finder.user.js'));
var fixture = require('./fixtures/history_22961178.json');

function row(date, status, admin, comment){
  return {dateEdit:date, nameExternalStatus:status, nameInternalStatus:'', commentSupport:comment || '', adminProcessedLogin:admin};
}

var passed = 0;
function test(name, fn){ fn(); passed++; console.log('  ✓ ' + name); }

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
  var tk = {idUser:1726618961, nameAgent:'BankTransfer Agents', nameSubagent:'Vodafone Nivus', nameDepartment:'MENA 1x', requestTypeName:'BT M'};
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
  assert.strictEqual(r.ticketType, 'BT M');
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

test('In progress: лист по Inside comment и Admin username', function(){
  var g = D.inProgressGroup;
  // «waiting for» важнее логина, регистр и знаки не важны
  assert.strictEqual(g('pay_mena_442', 'Waiting for bank confirmation'), 'waiting');
  assert.strictEqual(g('pay_cm_mena_140', '23739196863 // WAITING FOR response'), 'waiting');
  assert.strictEqual(g('', 'waiting   for PS'), 'waiting');
  assert.strictEqual(g('pay_mena_442', 'waiting, for'), 'waiting');
  // без «waiting for» — по логину
  assert.strictEqual(g('pay_mena_442', 'взял в работу'), 'pay_mena');
  assert.strictEqual(g('PAY_MENA_7', ''), 'pay_mena');
  assert.strictEqual(g('pay_support_mena_12', 'waiting'), 'pay_support_mena');
  assert.strictEqual(g('pay_cm_mena_140', ''), 'pay_cm_mena');
  assert.strictEqual(g('pay_mena_antifraud_59', 'проверка'), 'pay_mena_antifraud');
  assert.strictEqual(g('PAY_MENA_ANTIFRAUD_7', ''), 'pay_mena_antifraud');
  assert.strictEqual(g('pay_mena_antifraud_59', 'Waiting for docs'), 'waiting');
  assert.strictEqual(g('pay_mena_antifraud_', ''), 'other');
  // остальные
  assert.strictEqual(g('Vodafone_Nivus_Team_1', ''), 'other');
  assert.strictEqual(g('pay_mena_', ''), 'other');
  assert.strictEqual(g('pay_mena_12a', ''), 'other');
  assert.strictEqual(g('', ''), 'other');
  assert.strictEqual(g(null, null), 'other');
});

test('In progress: дата создания для списка ID — самая ранняя строка истории', function(){
  var r = D.analyzeInProgress([
    row('2026-10-05 12:00:00', 'In progress (M)', 'pay_mena_646', 'пересохранил'),
    row('2026-10-01 08:00:00', 'New', '', 'создан'),
    row('2026-10-04 11:00:00', 'In progress (M)', 'pay_mena_614', 'взял')
  ]);
  assert.strictEqual(r.firstDate, '2026-10-01 08:00:00');
  assert.strictEqual(r.date, '2026-10-05 12:00:00');
  assert.strictEqual(r.admin, 'pay_mena_646');
});

console.log('\n' + passed + ' тестов пройдено');
