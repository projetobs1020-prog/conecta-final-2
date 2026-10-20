import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessGroup, classCatalog, groupRole, normalizeForModeration, reviewSignals, StorageAdapter } from '../data.js';

test('normaliza acentos, pontuação e variantes simples de grafia', () => {
  assert.equal(normalizeForModeration('Ameaça!!!'), 'ameaca');
  assert.equal(normalizeForModeration('v0u te matarr'), 'vou te matar');
});

test('sinaliza uma frase de ameaça para revisão humana', () => {
  const result = reviewSignals('Vou te matar.');
  assert.equal(result.status, 'review');
  assert.equal(result.signals[0].code, 'threat');
  assert.equal(result.blockPreview, false);
});

test('sinaliza insultos graves e incentivo à violência para revisão humana', () => {
  assert.equal(reviewSignals('filho da puta').signals[0].code, 'severe-insult');
  assert.equal(reviewSignals('Vamos atacar').signals[0].code, 'violence');
});

test('retém localmente texto que corresponde ao sinal de risco urgente', () => {
  const result = reviewSignals('Enviar fotos íntimas de uma criança');
  assert.equal(result.status, 'review');
  assert.equal(result.blockPreview, true);
  assert.equal(result.signals[0].priority, 'urgent');
});

test('marca contexto histórico para análise contextual sem sinalizar menção neutra', () => {
  const result = reviewSignals('A aula de história discute nazismo e contexto histórico.');
  assert.equal(result.educationalContext, true);
  assert.equal(result.status, 'clear');
});

test('separa modalidades técnicas e turmas regulares', () => {
  assert.equal(classCatalog.regular.length, 18);
  assert.equal(classCatalog.technical.some(item => classCatalog.regular.some(regular => regular.id === item.id)), false);
});

test('aplica controle demonstrativo de acesso a grupos privados e função do membro', () => {
  const group = { visibility: 'private', members: [{ userId: 'member-1', role: 'owner' }] };
  assert.equal(canAccessGroup(group, 'member-1'), true);
  assert.equal(canAccessGroup(group, 'member-2'), false);
  assert.equal(groupRole(group, 'member-1'), 'owner');
});

test('recusa SVG e restringe as prévias a formatos raster conhecidos', async () => {
  await assert.rejects(StorageAdapter.image({ type: 'image/svg+xml', size: 32 }), /PNG, JPEG, WebP ou GIF/);
});
