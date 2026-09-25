// Testa syncCampaignContent() fora do navegador, com dublês no lugar do
// Firestore. Existe porque o sync só roda logado como Mestre, e dois bugs
// passaram por falta de teste: uma variável indefinida no bloco de facções e
// uma assinatura instável que reenviava tudo a cada rodada.
//
//   npm run test:sync
//
import fs from 'node:fs';

const src = fs.readFileSync('scripts/app.js', 'utf8');
const ini = src.indexOf('async function syncCampaignContent() {');
let i = src.indexOf('{', ini), d = 0, fim = i;
for (; fim < src.length; fim++) {
  if (src[fim] === '{') d++;
  else if (src[fim] === '}') { d--; if (d === 0) { fim++; break; } }
}
const fonte = src.slice(ini, fim);

// arquivos em memória, para poder "editar" um e ver o efeito
const arquivos = {};
for (const k of ['characters', 'locations', 'events', 'factions', 'documents', 'items', 'relations']) {
  arquivos[`data/${k}.json`] = JSON.parse(fs.readFileSync(`data/${k}.json`, 'utf8'));
}
const clone = o => JSON.parse(JSON.stringify(o));
const STATE = { data: {
  characters: [], locations: [], events: [], factions: [], documents: [], items: [], relations: [],
} };

let escritos = [];
const writeBatch = () => ({ set: (ref, dados) => escritos.push({ ref, dados }), commit: async () => {} });
const doc = (_db, base, col, id) => `${base}/${col}/${id}`;
const HIDDEN_VIS = { mode: 'hidden', playerIds: [] };
const CAMPAIGN_ID = 'mares-e-mares';
const db = {}, document = { getElementById: () => null };
const fetchCampaignJson = async p => clone(arquivos[p]);

const fn = new Function('STATE', 'writeBatch', 'doc', 'db', 'HIDDEN_VIS', 'CAMPAIGN_ID', 'document', 'fetchCampaignJson', 'console',
  `${fonte}; return syncCampaignContent;`)(STATE, writeBatch, doc, db, HIDDEN_VIS, CAMPAIGN_ID, document, fetchCampaignJson, console);

const aplicarNoFirestore = () => {
  for (const e of escritos) {
    const [, , col, id] = e.ref.split('/');
    const lista = STATE.data[col];
    const alvo = lista.find(x => x.id === id);
    if (alvo) Object.assign(alvo, e.dados); else lista.push({ id, ...e.dados });
  }
};

console.log('— 1a sincronização —');
await fn();
const porColecao = {};
for (const e of escritos) { const c = e.ref.split('/')[2]; porColecao[c] = (porColecao[c] || 0) + 1; }
console.log(' ', JSON.stringify(porColecao));
aplicarNoFirestore();

escritos = [];
console.log('— 2a, nada mudou nos arquivos —');
await fn();
console.log('  enviados:', escritos.length, escritos.length === 0 ? 'OK (edições do site preservadas)' : '<-- PROBLEMA');

escritos = [];
arquivos['data/characters.json'].find(c => c.id === 'orwin').description += ' Frase nova.';
console.log('— 3a, um personagem editado no arquivo —');
await fn();
console.log('  enviados:', escritos.length, '->', escritos.map(e => e.ref.split('/').pop()).join(', '));
aplicarNoFirestore();

escritos = [];
console.log('— 4a, depois de aplicar: não pode reenviar —');
await fn();
console.log('  enviados:', escritos.length, escritos.length === 0 ? 'OK' : '<-- PROBLEMA');
console.log('\nrelações no Firestore simulado:', STATE.data.relations.length);
console.log('  ids das 4 novas:', STATE.data.relations.filter(r => ['orwin', 'vargan-drell'].includes(r.sourceId)).map(r => r.id));

console.log('');
console.log('ok — trava de sobrescrita funcionando');
