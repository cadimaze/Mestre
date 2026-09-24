// ─────────────────────────────────────────────────────────────────────────────
// npm run pull — traz o que está no site (Firestore) para o repositório.
//
// Reescreve os data/*.json e atualiza o CAMPAIGN.md dentro das marcas AUTO.
// Nada é commitado: confira com `git diff` antes.
//
// Credenciais do Mestre: variáveis de ambiente MESTRE_EMAIL e MESTRE_SENHA, ou
// digitadas na hora. Nada é gravado em disco.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import { FIREBASE_CONFIG, CAMPAIGN_ID, MASTER_EMAIL } from './firebase-config.js';
import { aplicar } from './campaign-md.mjs';

// coleção do Firestore → arquivo em /data → tipo de bloco no CAMPAIGN.md
const COLECOES = [
  ['characters', 'characters', 'character'],
  ['locations',  'locations',  'location'],
  ['events',     'events',     'event'],
  ['factions',   'factions',   'faction'],
  ['relations',  'relations',  null],
  ['documents',  'documents',  null],
  ['items',      'items',      null],
];

// Campos internos que não pertencem ao repositório
const INTERNOS = new Set(['_syncHash', 'secretsVisibility']);

function limpar(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    if (INTERNOS.has(k)) continue;
    out[k] = obj[k];
  }
  return out;
}

async function credenciais() {
  let email = process.env.MESTRE_EMAIL;
  let senha = process.env.MESTRE_SENHA;
  if (email && senha) return { email, senha };
  const rl = readline.createInterface({ input: stdin, output: stdout });
  email = email || await rl.question(`E-mail do Mestre [${MASTER_EMAIL}]: `) || MASTER_EMAIL;
  senha = senha || await rl.question('Senha: ');
  rl.close();
  return { email, senha };
}

const conta = (arr, id) => arr.filter(x => x === id).length;

async function main() {
  const { email, senha } = await credenciais();
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(app);
  const db = getFirestore(app);

  process.stdout.write(`Entrando como ${email}... `);
  try {
    await signInWithEmailAndPassword(auth, email, senha);
  } catch (err) {
    console.error('\nNão consegui entrar:', err.code || err.message);
    await deleteApp(app);
    process.exitCode = 1;
    return;
  }
  if (email.toLowerCase() !== MASTER_EMAIL.toLowerCase()) {
    console.error('\nEsta conta não é a do Mestre — as regras do Firestore não deixam ler tudo.');
    await deleteApp(app);
    process.exitCode = 1;
    return;
  }
  console.log('ok');

  const porColecao = {};
  const resumoArquivos = [];

  for (const [col, arquivo, kind] of COLECOES) {
    const snap = await getDocs(collection(db, 'campaigns', CAMPAIGN_ID, col));
    const itens = snap.docs
      .map(d => limpar({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const caminho = `data/${arquivo}.json`;
    const antes = fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf8') : '';
    const antigos = antes ? JSON.parse(antes) : [];
    const depois = JSON.stringify(itens, null, 2) + '\n';

    const idsAntes = antigos.map(x => x.id);
    const idsDepois = itens.map(x => x.id);
    const novos = idsDepois.filter(i => !idsAntes.includes(i));
    const sumidos = idsAntes.filter(i => !idsDepois.includes(i));

    if (depois !== antes) fs.writeFileSync(caminho, depois);
    resumoArquivos.push({ arquivo, total: itens.length, novos, sumidos, mudou: depois !== antes });
    if (kind) porColecao[kind] = itens;
  }

  // CAMPAIGN.md — só dentro das marcas AUTO
  const mdAntes = fs.readFileSync('CAMPAIGN.md', 'utf8').split('\r\n').join('\n');
  const { md, resumo } = aplicar(mdAntes, porColecao);
  const mdMudou = md !== mdAntes;
  if (mdMudou) fs.writeFileSync('CAMPAIGN.md', md);

  // ── relatório ──
  console.log('');
  for (const r of resumoArquivos) {
    const extra = [
      r.novos.length ? `+${r.novos.length} novo(s): ${r.novos.join(', ')}` : '',
      r.sumidos.length ? `-${r.sumidos.length} removido(s): ${r.sumidos.join(', ')}` : '',
    ].filter(Boolean).join('  ');
    console.log(`  ${r.arquivo.padEnd(12)} ${String(r.total).padStart(3)} ${r.mudou ? '·' : ' '} ${extra}`);
  }

  const acoes = ['criado', 'atualizado', 'removido'];
  const linha = acoes.map(a => `${conta(resumo.map(r => r.acao), a)} ${a}(s)`).join(', ');
  console.log(`\n  CAMPAIGN.md  ${mdMudou ? linha : 'sem mudanças'}`);
  for (const r of resumo.filter(r => r.acao !== 'atualizado')) {
    console.log(`    ${r.acao.padEnd(10)} ${r.kind}:${r.id}`);
  }
  const ignorados = resumo.filter(r => r.acao === 'ignorado');
  if (ignorados.length) {
    console.log('\n  ATENÇÃO: faltam marcas <!-- AUTO-NEW:<tipo> --> no CAMPAIGN.md para:',
      ignorados.map(r => r.kind).join(', '));
  }

  console.log('\nRevise antes de commitar:  git diff');
  await deleteApp(app);
}

main().catch(err => { console.error(err); process.exit(1); });
