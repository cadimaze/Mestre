// ─────────────────────────────────────────────────────────────────────────────
// Atualização cirúrgica do CAMPAIGN.md a partir dos dados do site.
//
// O documento tem muita prosa que não existe no site (Raça, Navio, Idade,
// Relações, Conexões, Métodos, notas do Mestre, NPCs que só vivem aqui). Por
// isso este módulo NÃO regenera seções inteiras: reescreve apenas as subseções
// que o site é dono e deixa todo o resto exatamente como está.
//
// Cada entidade fica entre marcas próprias:
//   <!-- AUTO:character:gangplank -->  ...  <!-- /AUTO:character:gangplank -->
// Entidades novas entram no container da coleção:
//   <!-- AUTO-NEW:character -->        ...  <!-- /AUTO-NEW:character -->
// Nada fora das marcas é tocado.
// ─────────────────────────────────────────────────────────────────────────────

// Personagens são `#### NOME` com subseções `#####`; locais, eventos e facções
// são `### N.N NOME` com subseções `####`.
export const COLLECTIONS = {
  character: { heading: '####', sub: '#####', titleOf: e => e.name.toUpperCase(),
               possui: ['Descrição Pública', 'Personalidade', 'Segredos'] },
  location:  { heading: '###',  sub: '####',  titleOf: e => e.name,
               possui: ['Descrição', 'Pontos de Interesse', 'Segredos'] },
  event:     { heading: '###',  sub: '####',  titleOf: e => e.name,
               possui: ['Descrição', 'Segredos'] },
  // Facções guardam o segredo num blockquote, não numa subseção, e o site tem
  // um campo único — então aqui o site só é dono da Descrição.
  faction:   { heading: '###',  sub: '####',  titleOf: e => e.name,
               possui: ['Descrição'] },
};

const OWNED_META = ['Papel', 'Status'];
const startMark = (kind, id) => `<!-- AUTO:${kind}:${id} -->`;
const endMark   = (kind, id) => `<!-- /AUTO:${kind}:${id} -->`;
const newStart  = kind => `<!-- AUTO-NEW:${kind} -->`;
const newEnd    = kind => `<!-- /AUTO-NEW:${kind} -->`;

// ── leitura de um bloco existente ────────────────────────────────────────────

function splitBlock(texto, sub) {
  const linhas = texto.split('\n');
  const heading = linhas[0];
  const resto = linhas.slice(1).join('\n');

  const reSub = new RegExp('^' + sub + ' (.+)$', 'gm');
  const marcas = [...resto.matchAll(reSub)].map(m => ({ nome: m[1].trim(), i: m.index, fim: m.index + m[0].length }));
  const corte = marcas.length ? marcas[0].i : resto.length;
  const cabeca = resto.slice(0, corte);

  // metadados (**Campo:** valor) e o que mais vier antes da primeira subseção
  const meta = [];
  const soltas = [];
  for (const l of cabeca.split('\n')) {
    const m = /^\*\*(.+?):\*\*\s*(.*)$/.exec(l.trim());
    if (m) meta.push({ campo: m[1], valor: m[2] });
    else soltas.push(l);
  }

  const subs = marcas.map((mk, k) => ({
    nome: mk.nome,
    texto: resto.slice(mk.fim, k + 1 < marcas.length ? marcas[k + 1].i : resto.length)
      .replace(/\n*-----\s*$/, '').replace(/^\n+|\n+$/g, ''),
  }));

  return { heading, meta, subs, antes: soltas.join('\n').replace(/^\n+|\n+$/g, '') };
}

// ── o que o site é dono ──────────────────────────────────────────────────────

function segredosTexto(e) {
  const lista = Array.isArray(e.secretsList) ? e.secretsList : [];
  if (!lista.length) return '';
  return lista.map((s, i) => {
    if (s.title) {
      const t = /^(Camada[^—]*)—\s*(.+)$/.exec(String(s.title).trim());
      const cab = t ? `**🔒 ${t[1].trim()}** — *${t[2].trim()}*` : `**🔒 ${String(s.title).trim()}**`;
      return `${cab}\n${String(s.content || '').trim()}`;
    }
    const txt = String(s.text || '').trim();
    const m = /^(Camada[^—:]*)—\s*([^:]+):\s*([\s\S]*)$/.exec(txt);
    if (m) return `**🔒 ${m[1].trim()}** — *${m[2].trim()}*\n${m[3].trim()}`;
    return `**🔒 Camada ${i + 1}**\n${txt}`;
  }).join('\n\n');
}

function metaDoSite(e) {
  const out = [];
  if (e.role)     out.push({ campo: 'Papel',     valor: e.role });
  if (e.status)   out.push({ campo: 'Status',    valor: e.status });
  if (e.type)     out.push({ campo: 'Tipo',      valor: e.type });
  if (e.period)   out.push({ campo: 'Período',   valor: e.period });
  return out;
}

function subsDoSite(kind, e) {
  const possui = COLLECTIONS[kind].possui;
  const out = [];
  const add = (nome, texto) => { if (possui.includes(nome) && texto) out.push({ nome, texto }); };

  const desc = String(e.description || '').trim();
  add(kind === 'character' ? 'Descrição Pública' : 'Descrição', desc);
  add('Personalidade', String(e.personality || '').trim());
  if (Array.isArray(e.pointsOfInterest) && e.pointsOfInterest.length) {
    // o site guarda "Nome — descrição"; o documento usa "- **Nome** — descrição"
    add('Pontos de Interesse', e.pointsOfInterest.map(p => {
      const t = String(p).trim().replace(/^-\s*/, '');
      const m = /^(.+?)\s+—\s+([\s\S]*)$/.exec(t);
      return m ? `- **${m[1].replace(/\*\*/g, '')}** — ${m[2]}` : `- ${t}`;
    }).join('\n'));
  }
  add('Segredos', segredosTexto(e));
  return out;
}

// ── montagem ─────────────────────────────────────────────────────────────────

function render(heading, meta, antes, subs, sub) {
  const partes = [heading, ''];
  if (meta.length) partes.push(meta.map(m => `**${m.campo}:** ${m.valor}`).join('\n'), '');
  if (antes) partes.push(antes, '');
  for (const s of subs) partes.push(`${sub} ${s.nome}`, '', s.texto, '');
  partes.push('-----');
  return partes.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function blocoNovo(kind, e) {
  const cfg = COLLECTIONS[kind];
  return render(`${cfg.heading} ${cfg.titleOf(e)}`, metaDoSite(e), '', subsDoSite(kind, e), cfg.sub);
}

export function blocoAtualizado(kind, e, textoAtual) {
  const cfg = COLLECTIONS[kind];
  const atual = splitBlock(textoAtual.replace(/\n*-----\s*$/, ''), cfg.sub);
  const novoMeta = metaDoSite(e);

  // O valor do documento fica quando apenas detalha o do site ("Morto —
  // abatido pelos jogadores") ou é a forma no feminino ("Viva"), já que o site
  // guarda um rótulo curto para os cartões.
  const semGenero = v => v.replace(/[ao]$/i, '');
  const detalha = (doMd, doSite) =>
    (doMd.startsWith(doSite) && doMd.length > doSite.length)
    || (semGenero(doMd) === semGenero(doSite) && doMd !== doSite);

  const meta = [];
  const usados = new Set();
  for (const m of atual.meta) {
    const sub = novoMeta.find(n => n.campo === m.campo);
    if (sub) { meta.push(detalha(m.valor, sub.valor) ? m : sub); usados.add(sub.campo); }
    else if (!OWNED_META.includes(m.campo)) meta.push(m);
  }
  for (const n of novoMeta) if (!usados.has(n.campo)) meta.push(n);

  const novasSubs = subsDoSite(kind, e);

  // As remissões "*→ Ver também: ...*" só existem no documento — recupera as do
  // bloco antigo e recoloca no fim da camada correspondente.
  const segAntigo = atual.subs.find(s => s.nome === 'Segredos');
  const segNovo = novasSubs.find(s => s.nome === 'Segredos');
  if (segAntigo && segNovo) {
    const camadas = t => t.split(/\n(?=\*\*🔒)/).map(p => p.trim()).filter(Boolean);
    const numero = c => (/Camada\s+(\d+)/.exec(c) || [])[1];
    const extras = new Map();
    camadas(segAntigo.texto).forEach((c, i) => {
      const r = (c.match(/^(\*→ .*\*|> \*\*\[.*)$/gm) || []).join('\n');
      if (r) extras.set(numero(c) || 'i' + i, r);
    });
    segNovo.texto = camadas(segNovo.texto).map((c, i) => {
      const r = extras.get(numero(c) || 'i' + i);
      return r && !c.includes(r) ? `${c}\n${r}` : c;
    }).join('\n\n');
  }

  // subseções: troca as do site, mantém as demais na ordem original.
  // Blocos antigos podem usar "Descrição" onde a convenção dos personagens é
  // "Descrição Pública" — trata como a mesma coisa e mantém o título existente,
  // senão o documento ficaria com as duas.
  const apelido = nome => (kind === 'character' && nome === 'Descrição') ? 'Descrição Pública' : nome;
  const subs = [];
  const usadas = new Set();
  for (const s of atual.subs) {
    const novo = novasSubs.find(n => n.nome === s.nome || n.nome === apelido(s.nome));
    if (novo) { subs.push({ nome: s.nome, texto: novo.texto }); usadas.add(novo.nome); }
    else subs.push(s);
  }
  for (const n of novasSubs) if (!usadas.has(n.nome)) subs.push(n);

  return render(atual.heading, meta, atual.antes, subs, cfg.sub);
}

// ── aplicação sobre o documento inteiro ──────────────────────────────────────

export function aplicar(md, porColecao) {
  const resumo = [];
  for (const [kind, entidades] of Object.entries(porColecao)) {
    if (!COLLECTIONS[kind]) continue;
    const vistos = new Set();

    const re = new RegExp(
      `[ \\t]*<!-- AUTO:${kind}:([a-z0-9-]+) -->\\n([\\s\\S]*?)\\n[ \\t]*<!-- /AUTO:${kind}:\\1 -->`, 'g');
    md = md.replace(re, (todo, id, corpo) => {
      const e = entidades.find(x => x.id === id);
      if (!e) { resumo.push({ kind, id, acao: 'removido' }); return ''; }
      vistos.add(id);
      const novo = blocoAtualizado(kind, e, corpo);
      if (novo.trim() !== corpo.trim()) resumo.push({ kind, id, acao: 'atualizado' });
      return `${startMark(kind, id)}\n${novo}\n${endMark(kind, id)}`;
    });

    const novos = entidades.filter(e => !vistos.has(e.id));
    const ini = md.indexOf(newStart(kind));
    if (ini !== -1 && novos.length) {
      // ACRESCENTA ao container: reescrevê-lo por inteiro apagaria os blocos
      // criados em execuções anteriores, que passam a morar aqui dentro.
      const fim = md.indexOf(newEnd(kind), ini);
      const dentro = md.slice(ini + newStart(kind).length, fim).replace(/\s+$/, '');
      const blocos = novos.map(e => {
        resumo.push({ kind, id: e.id, acao: 'criado' });
        return `${startMark(kind, e.id)}\n${blocoNovo(kind, e)}\n${endMark(kind, e.id)}`;
      });
      md = md.slice(0, ini) + newStart(kind) + dentro + '\n\n' + blocos.join('\n\n') + '\n\n' + md.slice(fim);
    } else if (ini === -1 && novos.length) {
      resumo.push({ kind, id: '(container ausente)', acao: 'ignorado' });
    }
  }
  return { md: md.replace(/\n{4,}/g, '\n\n\n'), resumo };
}
