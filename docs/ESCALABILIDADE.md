# Escalabilidade — limites actuais e caminho para multi-veículo

Estado a 2026-09-15. Os números de tempo foram **medidos** no otimizador
real (`src/optimizer.js`), não estimados.

**Objectivo declarado:** empresa com até **10 000 encomendas/dia** na base
de dados, **divididas por vários distribuidores** (multi-veículo).

---

## 1. Onde a app está hoje

| Dimensão | Limite confortável | Onde começa a doer | Porquê |
|---|---|---|---|
| Paragens **numa rota** | ~150 | 200-300 (segundos); 500 inutilizável | Otimizador O(n²) por iteração, bloqueia o processo |
| Entradas na **base de dados** (aliases, a pé, horas) | ~10 000 | ~50 000+ | Ficheiros JSON lidos/reescritos inteiros a cada pedido |
| Cache de distâncias | ~10 000 troços | ~100 000 (20 MB reescritos por troço novo) | Escrita completa não-atómica a cada entrada nova |
| Utilizadores simultâneos | 1-3 | uma dúzia | Single-thread + sessões em memória |
| Veículos | **1** | — | Não existe conceito de frota |

### Otimizador — tempos medidos (rota de N paragens, aleatória em 40 km)

| N | otimizar | com horas-limite |
|---|---|---|
| 50 | 0,02 s | 0,03 s |
| 100 | 0,1 s | 0,2 s |
| 200 | 0,8 s | 3 s |
| 300 | 3,4 s | 9 s |
| 500 | 17 s | 74 s |

Cada duplicação de N custa 4-8×. Durante o cálculo o Node está bloqueado:
mais ninguém consegue usar a app.

### Persistência — o que acontece por baixo

- `readFileSync` do ficheiro inteiro em **cada** GET/POST de aliases,
  bloqueados e horas (`server.js` `readAliases`/`readBlocked`/
  `readDeliveryTimes`).
- `writeFileSync` do ficheiro inteiro a **cada** alteração. As caches
  (`src/cache.js`) são reescritas completas por cada troço/geocode novo.
- Só `src/routeShares.js` escreve de forma atómica (tmp + rename). As
  caches **não** — um crash a meio da escrita corrompe o ficheiro.
- Sem índices: `findBlockedMatch` é fuzzy sobre a lista toda, para cada
  endereço da rota (n_endereços × n_bloqueados).

### Rede / motores

- OSRM/Valhalla self-hosted: matriz pedida em blocos 10×10 em paralelo
  (150 paragens = 225 pedidos locais, rápido, grátis). Escala bem.
- **Google como fallback é perigoso com listas grandes**: cobra por
  elemento da matriz; 150² = 22 500 elementos por cálculo. Em produção,
  garantir que o fallback Google está desligado ou limitado.

---

## 2. O que "10 000 encomendas por vários distribuidores" exige

Isto não é "a rota actual, maior". É um problema diferente, o **VRP
(Vehicle Routing Problem)**: dado um conjunto de encomendas, um conjunto
de veículos (cada um com capacidade, ponto de partida, horário) e
restrições (janelas de tempo, endereços a pé), **atribuir** encomendas a
veículos e **ordenar** cada rota, minimizando o custo total.

O otimizador actual resolve só a segunda metade (ordenar UMA rota) e com
uma heurística que não aguenta mais de ~200 paragens. A atribuição a
veículos (a metade difícil) não existe.

Um dia típico nesse cenário: 10 000 encomendas → ~70-100 veículos ×
100-150 paragens. O cálculo tem de:

1. Geocodificar 10 000 endereços (cache faz o grosso; os novos, em lote).
2. Calcular uma matriz de distâncias — **não** 10 000² = 100 M troços
   (impossível), mas por *clusters* geográficos ou por vizinhos próximos.
3. Atribuir + ordenar (o VRP em si) — segundos a minutos num solver a
   sério, horas ou impossível com o algoritmo actual.
4. Entregar uma rota por condutor à PWA (o share já é por rota — isto
   escala).

---

## 3. Caminho recomendado, por ordem

### Passo 1 — Persistência robusta *(feito 2026-09-15)*
Escrita atómica (tmp + rename) em todos os ficheiros de `data/` e
escritas das caches agrupadas (`src/cache.js`: `writeJsonAtomic`,
`saveCache` com debounce, `flushSaves` no fim de cada pedido e no
shutdown). Verificado: 500 `saveCache()` → 1 escrita; SIGKILL a meio de
uma escrita de 8 MB → ficheiro anterior intacto; 40 leituras durante
escritas contínuas → 0 corrompidas.

### Passo 2 — Otimizador fora do processo principal *(feito 2026-09-15)*
`src/optimizerPool.js`: worker thread com fila (1 worker por defeito,
`OPTIMIZER_WORKERS` no `.env`); um worker que rebenta é substituído sem
deitar o servidor abaixo. Limite `MAX_OPTIMIZE_STOPS` (250 por defeito).
Verificado: otimização de 240 paragens com horas (3,5 s) e, durante
ela, 10 pedidos GET respondidos em 2-3 ms (antes: esperavam os 3,5 s).
Testes em `test/optimizer-pool.test.js`.

### Passo 3 — SQLite em vez de JSON *(médio, 2-3 dias)*
`better-sqlite3`: um ficheiro, zero infra, índices, transacções. As
caches deixam de ser reescritas inteiras; a base de dados passa de
"10 000" para "milhões" sem mudar de arquitectura. Os `read*/write*` em
`server.js` já estão isolados em funções — a migração é contida.

**Pré-requisito para tudo o que vem a seguir**: encomendas, veículos e
atribuições não cabem em JSON.

### Passo 4 — Contas e separação de dados *(médio, 2-3 dias)*
Sessões persistentes (`connect-sqlite3`), utilizadores, `owner_id` nas
tabelas. Cada armazém/despachante com os seus aliases, rotas e
condutores. É o que torna isto "empresa".

### Passo 5 — Solver VRP multi-veículo *(grande — é o objectivo)*
Não escrever um solver de raiz. Duas opções sérias, ambas open source:

- **VROOM** (`vroom-project`): feito exactamente para OSRM/Valhalla,
  resolve VRP com janelas de tempo, capacidades, vários veículos e
  skills (ex.: "só este veículo entra nesta zona"). Um binário C++, API
  HTTP, responde em segundos para milhares de encomendas. **Encaixa
  directamente no que já existe** (mesmos motores de rota) e resolveria
  também as janelas `14:00-17:00` de graça.
- **Google OR-Tools** (Python): mais flexível, mais trabalho de
  integração (outro runtime), melhor se as restrições forem muito
  específicas.

Recomendação: **VROOM**. Arquitectura resultante:

```
                    ┌────────────┐
  encomendas ──────►│  SQLite    │◄──── veículos, condutores, janelas
                    └─────┬──────┘
                          │ lote do dia
                          ▼
   ┌──────────┐    ┌────────────┐    ┌──────────┐
   │ OSRM /   │◄───│   VROOM    │───►│ 1 rota   │──► share → PWA (condutor 1)
   │ Valhalla │    │ (VRP)      │    │ por      │──► share → PWA (condutor 2)
   └──────────┘    └────────────┘    │ veículo  │──► …
                                     └──────────┘
```

O otimizador actual continua a servir para "o despachante ajusta uma
rota à mão" (arrastar, fixar) — o VROOM faz a distribuição inicial.

#### Como se dividem 10 000 encomendas: o pipeline da noite

Uma vez por dia (00:05, cron), o servidor faz isto sem ninguém à frente
do ecrã:

```
1. INGESTÃO          10 000 encomendas entram (CSV / API do sistema de
        │            origem / …).
        │
2. GEOCODIFICAÇÃO    endereço → coordenada. A cache faz 90%+ (clientes
        │            habituais); os novos vão ao swisstopo/Google em lote.
        │            Os que falham vão para uma fila "a corrigir à mão".
        │
3. SECTORIZAÇÃO      dividir o mapa em zonas (Valais, Vaud, Chablais…).
        │            Cada zona tem os seus veículos. Reduz o problema de
        │            1×10 000 para ~10×1 000 — sem isto nem o VROOM aguenta.
        │
4. VRP POR ZONA      VROOM recebe: as encomendas da zona (janelas, "a pé",
        │            peso/volume) + os veículos da zona (capacidade, hora
        │            de saída, armazém, hora limite de regresso).
        │            Devolve: 1 rota ordenada por veículo + a lista dos
        │            "não coube em nenhum" (excesso de encomendas).
        │
5. ATRIBUIÇÃO        cada rota → 1 condutor → 1 share (o que já existe
        │            para a PWA), gerado automaticamente.
        │
6. REVISÃO           07:00, o despachante abre a app, vê "12 rotas, 3
                     encomendas sem lugar, 8 endereços sem coordenada",
                     ajusta à mão o que for preciso (arrastar, fixar —
                     já existe), aprova, os condutores recebem.
```

#### O que já existe e o que falta

| Peça | Estado |
|---|---|
| Geocodificação com cache, swisstopo grátis, Google fallback | ✅ existe |
| Endereços "a pé", aliases, horas-limite por cliente | ✅ existe |
| Matriz de distâncias via OSRM/Valhalla self-hosted (grátis, rápido) | ✅ existe |
| Ajuste manual de uma rota (arrastar, fixar) + otimizador de 1 rota | ✅ existe (em worker thread desde o passo 2) |
| Share por rota → PWA do condutor, sync offline | ✅ existe |
| Backups, escrita atómica | ✅ existe |
| **Encomendas como entidade** (id, cliente, morada, peso, janela, estado) | ❌ hoje é um textarea |
| **Veículos/condutores** (capacidade, zona, horário, armazém) | ❌ não existe |
| **Zonas** | ❌ não existe |
| **Solver multi-veículo** (atribuir + ordenar) | ❌ o otimizador só ordena 1 rota |
| **Job nocturno + ecrã de revisão** | ❌ não existe |
| **Ingestão** (de onde vêm as 10 000?) | ❌ — primeira pergunta a responder |

#### Ordem de construção

1. **SQLite + entidades** (encomenda, veículo, zona, rota, atribuição) —
   o passo 3 acima; obrigatório, 10 000 linhas/dia com estados que mudam
   não vivem num JSON. 2-3 dias.
2. **Ingestão**: `POST /api/orders/import` (CSV) e/ou uma API para o
   sistema de origem chamar. Depende de **onde nascem as encomendas**.
3. **VROOM** ao lado do OSRM (um container, como o OSRM/Valhalla). Um
   endpoint `POST /api/plan-day` que faz os passos 3-5 do pipeline.
   3-5 dias, a maior parte no mapeamento das restrições para o formato
   do VROOM.
4. **Ecrã de revisão** — rotas do dia, o que falhou em destaque, e o
   "aprovar" que dispara os shares. Reaproveita o que a app já mostra
   por rota.
5. **Cron** a correr o passo 3 às 00:05 — trivial no fim.

#### Perguntas em aberto (decidem o desenho)

- **De onde vêm as encomendas?** Ficheiro? Sistema de facturação? App
  dos clientes? Define a ingestão e o formato da entidade.
- **Que restrições têm os veículos?** Só capacidade e horário, ou também
  "este condutor só faz esta zona", "furgão frigorífico", "este cliente
  só este condutor"? Define o que se envia ao VROOM (skills, capacidades
  por dimensão).

Com estas duas respostas escreve-se o desenho técnico completo antes de
tocar em código.

### Passo 6 — Operação *(quando houver clientes)*
Processo gerido (systemd/PM2 com restart), HTTPS próprio (o Tailscale
Funnel serve para 1-3 pessoas, não para uma frota), backups automáticos
(`npm run backup` já existe — agendar), monitorização básica.

---

## 4. Resumo em números

| | Hoje | Após passos 1-2 | Após 3-4 | Após 5 |
|---|---|---|---|---|
| Paragens por rota | ~150 | ~250 (sem bloquear) | ~250 | milhares (dividido por veículos) |
| Base de dados | ~10 000 | ~10 000 | milhões | milhões |
| Utilizadores | 1-3 | ~10 | dezenas | dezenas |
| Veículos | 1 | 1 | 1 (contas separadas) | **frota** |

Os passos 1-2 dão segurança imediata sem mudar nada do que funciona.
O passo 3 é obrigatório antes de qualquer coisa "empresa". O passo 5 é
o produto que descreveste — e é uma integração, não uma reescrita.



Limite conhecido: o casamento é só por morada de texto — duas encomendas received na mesma morada no mesmo dia, só a última fica ligada. Resolver isso a sério precisa de UI no escritório para escolher a encomenda por paragem, que ainda não existe.