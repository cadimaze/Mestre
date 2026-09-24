---
name: project-mares-e-mares
description: "Site estático de gerenciamento da campanha D&D \"Mares e Marés\" — estrutura, fluxo de dados JSON→Firestore, lore central e convenções"
metadata: 
  node_type: memory
  type: project
  originSessionId: adaa1359-acbb-48e8-9be7-84cd52271212
  modified: 2026-08-30T22:10:46.113Z
---

Site de campanha D&D 5e, 100% estático (HTML/CSS/JS vanilla + D3.js CDN + Firebase/Firestore), em `c:\Users\guica\OneDrive\Desktop\GitHub\Mestre`.

**Why:** Ferramenta pessoal do Mestre para organizar e visualizar Pelágos durante planejamento e jogo, com login de jogadores e controle de visibilidade por segredo.

**How to apply:** Pedidos de atualização de conteúdo se resolvem editando os JSONs em `/data` — nunca hardcodar no HTML/JS. A fonte de verdade de lore é `CAMPAIGN.md`; `ROTEIRO.md` é o esboço linear dos arcos.

## Estrutura
- `index.html` — SPA com abas: Painel, Personagens, Locais, Eventos, Facções, Relações, Acervo, Jogadores (mestre), Roteiro (mestre), Curiosidades (mestre), Meu Personagem (jogador)
- `scripts/app.js` — toda a lógica (modais, grafo D3, busca, segredos, roteiro inline)
- `/data`: `characters.json` (18) · `locations.json` (10) · `events.json` (3) · `factions.json` (6) · `relations.json` (71) · `documents.json` (14) · `items.json` (vazio, mas ligado ao pipeline)
- `curiosities.json` fica na **raiz** — é o único JSON lido em runtime por todos os usuários, por isso é publicado.

## Fluxo de dados — o ponto que mais confunde
`/data/**` fica **fora do deploy** (`firebase.json` → `ignore`) porque os JSONs carregam `secrets`/`secretsList` em texto puro; publicá-los furaria as regras do Firestore. Como o rewrite `**` devolve o `index.html` para esses caminhos, `seedCampaign()` e `syncCampaignContent()` **só funcionam rodando o repositório localmente** (`npx serve .`). O `app.js` tem `fetchCampaignJson()` + `DATA_LOCAL_ONLY_MSG` para explicar isso, e o botão "Sincronizar Dados" fica oculto fora do localhost.

## Sincronização nos dois sentidos (set/2026)
- **Arquivo → site:** botão "Sincronizar Dados" (só no localhost). Agora grava `_syncHash` por registro: se o JSON não mudou desde o último sync, o registro **não** é tocado — o que o Mestre editou pelo site sobrevive. Se o JSON mudou, ele vence.
- **Site → arquivo:** `npm run pull` (`scripts/pull.mjs`) entra como Mestre, reescreve os `data/*.json` e atualiza o `CAMPAIGN.md`. Não commita nada.
- O `CAMPAIGN.md` tem marcas `<!-- AUTO:<tipo>:<id> -->` por entidade e containers `<!-- AUTO-NEW:<tipo> -->`. `scripts/campaign-md.mjs` reescreve **só** Papel, Status, Descrição Pública, Personalidade e Segredos; preserva metadados extras (Raça, Navio, Idade), subseções não modeladas (Relações, Conexões), remissões `*→ Ver também*` e valores de Status mais detalhados/no feminino. Fora das marcas nada é tocado — Orwin e Vargan seguem manuais.

Seed e sync cobrem characters/locations/events/factions/relations/documents/items. Visibilidade é semeada só na primeira vez — o que o Mestre ajusta pela UI tem precedência sobre o JSON.

## Decisões do Mestre já tomadas
- **Sistema de rolagem de dados removido** (set/2026) — saíram os Dados de Navegação (Combate Naval, Pilotagem, Ações e Conserto), o toast de rolagem d20 com vantagem/desvantagem e o campo `navigation` da ficha. Valores antigos de `navigation` seguem gravados nos docs de `users`, ignorados. As perícias/proficiências (`profStateToMod`) não fazem parte disso e continuam.
- **Aba Navio removida** (set/2026) — a coleção `ships` e o doc `ship/main` ficaram no Firestore, mas nada no site os lê.
- **NPCs foram descartados** — a aba foi removida e todo o código, CSS, rules e arquivos de NPC saíram do repo. NPCs de importância baixa são criados direto na mesa; só personagens importantes entram no site. Não reintroduzir.
- **Segredos ficam ocultos por default** — `docVisible()` e `isItemVisible()` retornam `false` quando não há `visibility`.

## Lore central (spoilers totais)
- **O Peso / Thurvael** = entidade primordial selada sob o oceano por Himmel Varek (sacrifício voluntário). É um *personagem*, não facção.
- **A Maré Alta (O Abraço das Águas Eternas)** não foi acidente — foi ritual deliberado de Himmel
- **Selavin Doss** = magista élfico que invocou O Peso; vivo dentro do selo, usa Soren como fresta
- **Família Talion** são elfos ocultos por um cristal no núcleo de Reva
- **Soren Mael** = cartógrafo errante, veículo inconsciente de Selavin/O Peso
- **Cade Varek** vai trair os jogadores (plantar sinais sutis)
- **A Corrente** = marinha imperial de Velmarch (NÃO organização sombria)
- **Taliyah** = rainha (esposa de Aldric XIV), NÃO princesa/filha
- Escolha impossível final: destruir o império liberta O Peso

## Convenções de IDs
- Locais: `pelagos`, `kaldera`, `velmyr`, `marvosa`, `reva`, `ancoradouro-de-latao`, `aethon`, `mosteiro-costa-afogada`, `ondra`, `kesvar`
- Facções: `velmarch`, `a-corrente`, `casa-varek`, `familia-talion`, `mare-negra`, `corte-cortesas`
- Eventos: `grande-guerra`, `abraco-aguas-eternas`, `caca-elfos`
- `secretsList[]` usa `{id, text, visibility}` em locais/personagens/eventos, mas `{id, title, content, visibility}` em **documentos e itens** — esquemas diferentes.
