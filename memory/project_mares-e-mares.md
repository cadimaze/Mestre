---
name: project-mares-e-mares
description: Site estático de gerenciamento da campanha D&D "Mares e Marés" — estrutura, lore central e convenções de atualização
metadata:
  type: project
---

Site de campanha D&D 5e, 100% estático (HTML/CSS/JS vanilla + D3.js CDN), localizado em `c:\Users\guica\OneDrive\Desktop\GitHub\Mestre`.

**Why:** Ferramenta pessoal do Mestre para organizar e visualizar Pelágos durante planejamento e jogo.

**How to apply:** Ao receber pedidos de atualização de conteúdo, sempre editar os JSONs em `/data` — nunca hardcodar no HTML/JS. A fonte de verdade de lore é `CAMPAIGN.md`.

## Estrutura de arquivos
- `index.html` — SPA com 6 abas
- `styles/main.css` — tema oceano profundo
- `scripts/app.js` — toda a lógica (modais, grafo D3, busca, segredos)
- `data/characters.json` — 9 personagens
- `data/locations.json` — 4 locais
- `data/events.json` — 3 eventos
- `data/factions.json` — 5 facções (inclui O Peso como entidade)
- `data/relations.json` — ~30 relações para o grafo
- `assets/images/characters/` — imagens dos personagens (sem imagens por enquanto)

## Lore central (spoilers totais)
- **O Peso** = entidade primordial selada sob o oceano por Himmel Varek (sacrifício voluntário)
- **A Maré Alta** não foi acidente — foi ritual deliberado de Himmel
- **Família Talion** são todos elfos ocultos por cristal mágico em Reva
- **Soren Mael** = cartógrafo errante, veículo inconsciente de O Peso
- **Cade Varek** vai trair os jogadores (plantar sinais sutis)
- **A Corrente** = marinha imperial de Velmarch (NÃO organização sombria)
- **Taliyah** = rainha (esposa de Aldric XIV), NÃO princesa/filha
- Escolha impossível final: destruir o império liberta O Peso

## Convenções de IDs nos JSONs
- Personagens: `himmel-varek`, `aldric-xiv`, `taliyah-varek`, `cade-varek`, `frieren-talion`, `fern-talion`, `soren-mael`, `tulo-bresh`, `gloria-vittar`
- Locais: `kaldera`, `velmyr`, `marvosa`, `reva`
- Eventos: `grande-guerra`, `abraco-aguas-eternas`, `caca-elfos`
- Facções: `velmarch`, `a-corrente`, `casa-varek`, `familia-talion`, `o-peso`
