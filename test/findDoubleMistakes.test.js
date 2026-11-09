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

test('Ticket type для Double mistakes — из последней строки истории, где он есть', function(){
  var a = approved('2026-10-01 10:00:00'); a.requestTypeName = 'BT M';
  var r = D.analyzeHistory([a, ret('2026-10-01 12:00:00')]);
  assert.strictEqual(r.ticketType, 'BT M');
  assert.strictEqual(D.analyzeHistory([approved('2026-10-01 10:00:00')]).ticketType, '');
});

console.log('\n' + passed + ' тестов пройдено');
