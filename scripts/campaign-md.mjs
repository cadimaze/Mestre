// ─────────────────────────────────────────────────────────────────────────────
// Atualização cirúrgica do CAMPAIGN.md a partir dos dados do site.
//
// O CAMPAIGN.md tem muita prosa escrita à mão que não existe no site (Raça,
// Navio, Idade, Relações, Conexões, NPCs que só vivem no documento). Por isso
// este módulo NÃO regenera seções inteiras: ele reescreve apenas as partes que
// o site é dono e deixa o resto do bloco exatamente como está.
//
// O site é dono de:  **Papel:**, **Status:**, Descrição Pública, Personalidade,
//                    Segredos
// Preservado sempre: qualquer outra linha `**Campo:**` e qualquer subseção
//                    `##### ...` que não esteja na lista acima.
//
// Cada entidade sincronizada fica entre marcas próprias:
//   <!-- AUTO:character:gangplank -->  ...  <!-- /AUTO:character:gangplank -->
// Entidades novas são acrescentadas ao container da coleção:
//   <!-- AUTO-NEW:character -->        ...  <!-- /AUTO-NEW:character -->
// Nada fora das marcas é tocado.
// ─────────────────────────────────────────────────────────────────────────────

export const OWNED_SUBSECTIONS = ['Descrição Pública', 'Personalidade', 'Segredos'];
const OWNED_META = ['Papel', 'Status'];

export const COLLECTIONS = {
  character: { label: 'Personagem', heading: '####',  titleOf: e => e.name.toUpperCase() },
  location:  { label: 'Local',      heading: '###',   titleOf: e => e.name },
  event:     { label: 'Evento',     heading: '###',   titleOf: e => e.name },
  faction:   { label: 'Facção',     heading: '###',   titleOf: e => e.name },
};

const startMark = (kind, id) => `<!-- AUTO:${kind}:${id} -->`;
const endMark   = (kind, id) => `<!-- /AUTO:${kind}:${id} -->`;
const newStart  = kind => `<!-- AUTO-NEW:${kind} -->`;
const newEnd    = kind => `<!-- /AUTO-NEW:${kind} -->`;

// ── leitura de um bloco existente ────────────────────────────────────────────

function splitBlock(texto) {
  const linhas = texto.split('\n');
  const heading = linhas[0];
  const resto = linhas.slice(1).join('\n');
  // metadados: linhas **Campo:** valor antes da primeira subseção
  const corte = resto.search(/^##### /m);
  const cabeca = corte === -1 ? resto : resto.slice(0, corte);
  const corpo  = corte === -1 ? ''    : resto.slice(corte);

  const meta = [];
  for (const l of cabeca.split('\n')) {
    const m = /^\*\*(.+?):\*\*\s*(.*)$/.exec(l.trim());
    if (m) meta.push({ campo: m[1], valor: m[2] });
  }

  const subs = [];
  const re = /^##### (.+)$/gm;
  let m, marcas = [];
  while ((m = re.exec(corpo))) marcas.push({ nome: m[1].trim(), i: m.index, fim: re.lastIndex });
  marcas.forEach((mk, k) => {
    const ate = k + 1 < marcas.length ? marcas[k + 1].i : corpo.length;
    subs.push({ nome: mk.nome, texto: corpo.slice(mk.fim, ate).replace(/^\n+|\n+$/g, '') });
  });
  // rodapé solto depois do último "-----" fica fora das subseções
  return { heading, meta, subs, semSubsecoes: corte === -1 ? cabeca.replace(/^\n+|\n+$/g, '') : '' };
}

// ── geração das partes que o site é dono ─────────────────────────────────────

function segredosTexto(e) {
  const lista = Array.isArray(e.secretsList) ? e.secretsList : [];
  if (!lista.length) return e.secrets ? String(e.secrets).trim() : '';
  return lista.map((s, i) => {
    // O site guarda os segredos como "Camada N — Título: corpo" num campo só
    // (locais/personagens) ou como {title, content} (documentos/itens).
    // Formato do documento: **🔒 Camada N** — *Título* / corpo
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
  if (e.role)   out.push({ campo: 'Papel',  valor: e.role });
  if (e.status) out.push({ campo: 'Status', valor: e.status });
  if (e.subtitle) out.push({ campo: 'Subtítulo', valor: e.subtitle });
  if (e.type)     out.push({ campo: 'Tipo',      valor: e.type });
  if (e.period)   out.push({ campo: 'Período',   valor: e.period });
  return out;
}

function subsDoSite(e) {
  const out = [];
  const desc = String(e.description || '').trim();
  if (desc) out.push({ nome: 'Descrição Pública', texto: desc });
  const pers = String(e.personality || '').trim();
  if (pers) out.push({ nome: 'Personalidade', texto: pers });
  const seg = segredosTexto(e);
  if (seg) out.push({ nome: 'Segredos', texto: seg });
  return out;
}

// ── montagem ─────────────────────────────────────────────────────────────────

function render(heading, meta, subs, extraSemSub) {
  const partes = [heading, ''];
  if (meta.length) {
    partes.push(meta.map(m => `**${m.campo}:** ${m.valor}`).join('\n'), '');
  }
  if (extraSemSub) partes.push(extraSemSub, '');
  for (const s of subs) partes.push(`##### ${s.nome}`, '', s.texto, '');
  partes.push('-----');
  return partes.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Bloco novo, para entidade que ainda não existe no documento. */
export function blocoNovo(kind, e) {
  const cfg = COLLECTIONS[kind];
  const heading = `${cfg.heading} ${cfg.titleOf(e)}`;
  return render(heading, metaDoSite(e), subsDoSite(e), '');
}

/** Atualiza um bloco existente preservando tudo que o site não controla. */
export function blocoAtualizado(kind, e, textoAtual) {
  const atual = splitBlock(textoAtual.replace(/\n*-----\s*$/, ''));
  const novoMeta = metaDoSite(e);
  const donos = new Set(OWNED_META.concat(novoMeta.map(m => m.campo)));

  // metadados: substitui os do site na posição original; mantém os demais.
  // O valor do documento é preservado quando apenas detalha o do site
  // ("Morto — abatido pelos jogadores") ou é a forma no feminino ("Viva"),
  // já que o site guarda um rótulo curto para os cartões.
  const semGenero = v => v.replace(/[ao]$/i, '');
  const detalha = (doMd, doSite) =>
    doMd.startsWith(doSite) && doMd.length > doSite.length
    || (semGenero(doMd) === semGenero(doSite) && doMd !== doSite);

  const meta = [];
  const usados = new Set();
  for (const m of atual.meta) {
    const sub = novoMeta.find(n => n.campo === m.campo);
    if (sub) {
      meta.push(detalha(m.valor, sub.valor) ? m : sub);
      usados.add(sub.campo);
    } else if (!OWNED_META.includes(m.campo)) meta.push(m);
  }
  for (const n of novoMeta) if (!usados.has(n.campo)) meta.push(n);

  // subseções: substitui as do site; mantém as outras na ordem original
  const novasSubs = subsDoSite(e);

  // As remissões "*→ Ver também: ...*" só existem no documento — o site não as
  // modela. Recupera as do bloco antigo e recoloca no fim de cada camada.
  const segAntigo = atual.subs.find(s => s.nome === 'Segredos');
  const segNovo = novasSubs.find(s => s.nome === 'Segredos');
  if (segAntigo && segNovo) {
    const camadas = t => t.split(/\n(?=\*\*🔒)/).map(p => p.trim()).filter(Boolean);
    // casa pelo número da camada (a contagem pode diferir entre os dois lados)
    const numero = c => (/Camada\s+(\d+)/.exec(c) || [])[1];
    const porNumero = new Map();
    camadas(segAntigo.texto).forEach((c, i) => {
      const r = (c.match(/^\*→ .*\*$/gm) || []).join('\n');
      if (r) porNumero.set(numero(c) || 'i' + i, r);
    });
    segNovo.texto = camadas(segNovo.texto).map((c, i) => {
      const r = porNumero.get(numero(c) || 'i' + i);
      return r && !c.includes(r) ? `${c}\n${r}` : c;
    }).join('\n\n');
  }
  const subs = [];
  const usadas = new Set();
  for (const s of atual.subs) {
    const sub = novasSubs.find(n => n.nome === s.nome)
      || (s.nome === 'Descrição' ? novasSubs.find(n => n.nome === 'Descrição Pública') : null);
    if (sub) { subs.push({ nome: s.nome, texto: sub.texto }); usadas.add(sub.nome); }
    else if (!OWNED_SUBSECTIONS.includes(s.nome)) subs.push(s);
    else usadas.add(s.nome);           // subseção do site que ficou vazia: some
  }
  for (const n of novasSubs) if (!usadas.has(n.nome)) subs.push(n);

  return render(atual.heading, meta, subs, atual.semSubsecoes);
}

// ── aplicação sobre o documento inteiro ──────────────────────────────────────

/**
 * @param {string} md            conteúdo atual do CAMPAIGN.md
 * @param {object} porColecao    { character: [...], location: [...], ... }
 * @returns {{md: string, resumo: object[]}}
 */
export function aplicar(md, porColecao) {
  const resumo = [];
  for (const [kind, entidades] of Object.entries(porColecao)) {
    if (!COLLECTIONS[kind]) continue;
    const vistos = new Set();

    // 1) atualiza / remove blocos marcados
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

    // 2) acrescenta os que ainda não têm bloco
    const novos = entidades.filter(e => !vistos.has(e.id));
    const ini = md.indexOf(newStart(kind));
    if (ini !== -1) {
      const fim = md.indexOf(newEnd(kind), ini);
      const dentro = md.slice(ini + newStart(kind).length, fim);
      const blocos = novos.map(e => {
        resumo.push({ kind, id: e.id, acao: 'criado' });
        return `${startMark(kind, e.id)}\n${blocoNovo(kind, e)}\n${endMark(kind, e.id)}`;
      });
      const conteudo = blocos.length ? '\n\n' + blocos.join('\n\n') + '\n\n' : '\n\n';
      if (dentro.trim() || blocos.length) md = md.slice(0, ini) + newStart(kind) + conteudo + md.slice(fim);
    } else if (novos.length) {
      resumo.push({ kind, id: '(container ausente)', acao: 'ignorado' });
    }
  }
  md = md.replace(/\n{4,}/g, '\n\n\n');
  return { md, resumo };
}
