# Revisão de código — 2026-09-16

Revisão completa da base de código (backend, frontend do escritório, PWA do condutor),
feita como uma auditoria de engenharia/arquitetura. Cobre bugs, segurança, arquitetura
e otimização. Não inclui nitpicks de estilo/formatação — só problemas reais.

**Estado:** todos os itens marcados como **CORRIGIDO** foram implementados e verificados
(testes existentes continuam a passar, sem regressões — confirmado por comparação direta
com o estado antes das alterações via `git stash`). Os 3 marcados como **PENDENTE**
ficaram deliberadamente por fazer — ver a nota em cada um.

## Opinião geral

Para o tamanho e contexto do projeto, o código está bem acima da média. Os comentários
explicam consistentemente o *porquê* das decisões, não só o quê — a cadeia de fallback
Google→OSRM→Valhalla é honesta sobre as suas próprias limitações, e a disciplina de
escaping contra XSS é sólida em toda a app (nenhuma string vinda do utilizador chega ao
DOM sem `escapeHtml`). Não é uma base de código descuidada.

Os problemas encontrados são sobretudo **pontas soltas em infraestrutura já bem
desenhada** — não falhas de arquitetura de raiz. Vários (ex: os campos `dirty`/
`lastSyncError` do PWA, ou o padrão de debounce do `cache.js` que não foi reaplicado ao
`routeShares.js`) são casos de "o mecanismo certo já existe algures no código, só não
foi ligado a este sítio".

---

## Os 5 mais importantes (por ordem de gravidade real)

### 1. [PWA] Perda silenciosa e permanente de confirmações de entrega — HIGH — CORRIGIDO

**Ficheiros:** `public/pwa/js/app.js` (setStopStatus), `public/pwa/js/db.js`,
`public/pwa/js/sync.js`

Marcar "Entregue"/"Falhou" grava em duas transações IndexedDB **separadas**: primeiro no
store `stops`, depois (numa chamada distinta) no store `queue`, via `sync.js`. Não há
transação multi-store no `db.js` atual. Se o processo da app for morto pelo sistema
operativo entre as duas escritas — muito real numa carrinha, com a app em segundo plano
durante um turno de 8h — a paragem fica marcada como "entregue" no ecrã do condutor mas
**nunca chega ao servidor**, sem qualquer aviso.

O mais frustrante: já existem campos `dirty` e `lastSyncError` no schema, claramente
preparados para detetar e corrigir exatamente este cenário, mas **nunca são lidos em
lado nenhum do código** — é um mecanismo de reconciliação morto.

**Corrigido:** `public/pwa/js/db.js` ganhou `updateStopAndEnqueue()`, uma única transação
IndexedDB `["stops","queue"]` — as duas escritas agora ou acontecem as duas ou nenhuma.
`app.js`/`sync.js` foram atualizados para a usar. Adicionada também `reconcileDirtyStops()`,
corrida no arranque, que reenfileira qualquer stop `dirty:true` sem linha na fila (proteção
extra para dados antigos de antes desta correção). De caminho, também deixou de enviar 3
pedidos quando marcas/desmarcas a mesma paragem várias vezes seguidas — cada nova marcação
substitui a anterior ainda não enviada em vez de se acumular.

### 2. [Backend] `/api/optimize` esconde erros de rota como `null` — HIGH — CORRIGIDO

**Ficheiros:** `server.js:1671-1689`, `src/optimizer.js:164-169, 332-336, 380-398`

Quando há uma restrição de estrada ativa e um stop fica inalcançável mesmo depois do
Access Manager tentar resgatá-lo, a matriz de durações guarda `Infinity` nessa célula.
`optimizeOrder` documenta explicitamente que vai colocá-la na rota na mesma ("stop
inacessível deixado para trás; anexa-se ao fundo mesmo assim"). O resultado final soma
`Infinity`, e `JSON.stringify` converte isso silenciosamente em `null` — o dispatcher vê
`savedSeconds: null`, `lateByMinutes: null`, sem perceber que há um problema real de
rota.

O endpoint irmão `/api/road-exclusion/preview` trata exactamente esta situação
corretamente, com um campo `unreachable` explícito — `/api/optimize` não tem
equivalente.

**Corrigido:** a resposta agora inclui `unreachableIndices` (reaproveitando
`unreachableStops`), e `givenSeconds`/`optimizedSeconds`/`savedSeconds`/`lateStops` só
incluem valores quando são números reais. O frontend do escritório já mostra um aviso
específico ("X paragem(ns) sem forma de chegar/sair") em vez de ficar em silêncio.

### 3. [Frontend escritório] Condição de corrida no cálculo de rota — HIGH — CORRIGIDO

**Ficheiro:** `public/index.html:1305-1459` (`runCalculate`)

Não há token de geração/cancelamento. Cada leg é calculado com um `await` sequencial,
escrevendo o resultado de volta por `id` de elemento DOM. Qualquer ação que reordene
paragens (arrastar, desfazer, editar um alias/bloqueio) chama `runCalculate(true, true)`
de novo **sem esperar ou cancelar** o cálculo anterior. Arrastar duas paragens seguidas
(muito plausível agora que há drag-and-drop em todo o lado) pode fazer a resposta mais
lenta do primeiro cálculo chegar depois do segundo já ter reconstruído o DOM — os números
antigos sobrescrevem os novos, silenciosamente, sem aviso visual nenhum ao dispatcher.

**Corrigido:** `runCalculateGeneration`, um contador incremental — cada chamada guarda o
seu próprio valor e verifica-o depois de cada `await`; se já não corresponde ao mais
recente, a chamada antiga aborta em vez de escrever no DOM.

### 4. [PWA] Mapa por satélite não funcionava offline — CORRIGIDO

**Ficheiro:** `public/pwa/sw.js`

Regressão introduzida na própria sessão de hoje ao ativar o satélite como estilo
predefinido do mapa: o service worker só tinha as tiles do OpenFreeMap na lista de
cache-first (`isTileRequest`); as tiles Esri do satélite nunca eram guardadas, quebrando
a promessa central da app ("funciona sem rede") logo no ecrã mais usado. Já corrigido —
`arcgisonline.com` foi adicionado à lista de hosts cacheados.

### 5. [Backend] Pedidos à Google Distance Matrix são sequenciais, não paralelos — HIGH (performance/custo) — CORRIGIDO

**Ficheiro:** `src/routing.js:224-296` (`fetchGrid`/`buildDurationMatrix`)

Cada chunk (10×10) é pedido à Google um de cada vez, dentro de loops `for` aninhados com
`await`. Com o limite de 250 paragens e chunks de 10, uma rota nova com endereços todos
por calcular pode chegar a ~625 pedidos HTTP sequenciais — mais de um minuto de latência
pura de rede, só para um `/api/optimize`. O caminho equivalente do OSRM, no mesmo
ficheiro, já faz isto corretamente com `Promise.all`.

**Corrigido:** `fetchGrid` monta agora a lista de todos os pares (origem-chunk,
destino-chunk) e corre-os com `mapWithConcurrency` (novo helper local, mesmo desenho do
que já existe em `server.js`), limitado a `GOOGLE_MATRIX_CONCURRENCY = 6` em voo — rápido
o suficiente para deixar de ser sequencial, conservador o suficiente para não arriscar
`OVER_QUERY_LIMIT` num burst (relevante dado o incidente real desta sessão).

---

## Também corrigido (prioridade média/baixa)

- **[Backend, MEDIUM] CORRIGIDO** `mode` (driving/walking) agora é validado contra uma
  lista fixa (`VALID_TRAVEL_MODES`) em `/api/distance` e `/api/optimize`, antes de chegar
  a `routing.js`.
- **[Backend, MEDIUM] CORRIGIDO** `src/routeShares.js`'s `persist()` passou a usar o
  `saveCache`/`flushSaves` já existente em `src/cache.js` — escrita com debounce em vez
  de reescrever o ficheiro inteiro a cada confirmação, com a mesma garantia de durabilidade
  (flush antes de cada resposta HTTP sair).
- **[PWA, MEDIUM] CORRIGIDO** `sync.js` agora limita a 8 tentativas um erro de servidor
  persistente (não-404/400) antes de desistir e marcar `lastSyncError` — a paragem mostra
  um aviso "Não sincronizado" na lista, e voltar a marcá-la manualmente tenta de novo.
- **[PWA, MEDIUM] CORRIGIDO** (parte da correção do #1) — marcar/desmarcar a mesma paragem
  várias vezes seguidas já não acumula pedidos na fila.
- **[Frontend escritório, MEDIUM] CORRIGIDO** As três funções de picker foram unificadas
  num `createAddressPicker(...)` só, com um `refreshAddressPickers()` que atualiza sempre
  as três — isto também corrigiu vários pontos onde só duas das três eram atualizadas
  (ex: "Limpar" deixava o picker de horários com endereços já apagados).
- **[Frontend escritório, MEDIUM] CORRIGIDO** A animação passou a usar `nextIndex` como
  cursor entre frames (`animationScanIndex`), em vez de reiniciar o scan da geometria a
  cada frame; o ponto da próxima paragem também passou a ficar em cache, recalculado só
  quando a paragem-alvo muda.
- **[Frontend escritório, LOW-MEDIUM] CORRIGIDO** Editar um alias/bloqueio que muda a
  chave agora tenta remover a entrada antiga até 3 vezes; se mesmo assim falhar, mostra
  um aviso específico a dizer que pode ter ficado duplicada, em vez do erro genérico.
- **[Backend, LOW] CORRIGIDO** `road-restrictions.json` ganhou uma limpeza preguiçosa
  (mesma filosofia do `routeShares.js`) — entradas desativadas ou expiradas há mais de
  30 dias deixam de ser reescritas para sempre.

## Pendente (deliberadamente não corrigido nesta sessão)

- **[Backend, LOW-MEDIUM]** Pedidos concorrentes para os mesmos pares de endereços não
  são deduplicados (dois dispatchers, ou um duplo-clique, pagam à Google duas vezes pelo
  mesmo par). Precisa de uma cache de promises em voo, desenho um pouco maior — o próprio
  relatório original já o marcou como "baixa prioridade dado o tamanho da equipa".
- **[PWA, LOW]** Botão de permissão de câmara mostra estado por omissão no Firefox/Safari
  mesmo já concedida — limitação da própria Permissions API nesses browsers (não suportam
  consultar `"camera"|"microphone"`), não há correção limpa do lado da app.
- **[PWA, LOW]** GPS em alta precisão contínua o dia todo, sem modo poupador quando
  parado — o relatório original já o descreveu como "a ter em conta", não uma correção
  concreta a fazer.

---

## Se só corrigires uma coisa

O nº 1 (perda silenciosa de dados no PWA) — já corrigido. Era o único problema desta
lista que podia fazer um condutor achar que uma entrega ficou registada quando na
verdade nunca chegou ao servidor, precisamente o que esta app existe para evitar.

---

## O que foi verificado e está bem (não precisa de ação)

- **Login/sessão** (`server.js:358-502`): comparação de password em tempo constante,
  rate-limiting real com limpeza, rotas públicas (`/shared/:token`, `/pwa/*`) separadas
  corretamente da autenticação.
- **Construção de URLs** para Google/geocoding: sempre via `URL`/`searchParams.set`, sem
  risco de injeção na query string.
- **`writeJsonAtomic`**: padrão de ficheiro temporário + rename usado de forma correta e
  consistente em todos os stores JSON.
- **Escaping contra XSS**: disciplina sólida em toda a app, incluindo o padrão mais fácil
  de errar (interpolar endereço numa tradução e só depois escapar o resultado completo).
- **`postMessage` do popup "Gerir todos"**: verifica `e.source === iframe.contentWindow`
  em vez de `e.origin` — não é um risco real aqui porque o iframe é sempre
  same-origin (`/manage/<kind>` servido pela própria app).
