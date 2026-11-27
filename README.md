# Co-piloto de voz

Uma co-apresentadora de IA (a **Calíope**) para apresentações ao vivo no Google Meet. Ela fica ouvindo, responde quando é
chamada pelo nome, troca os slides e opera uma página web como um usuário: o cursor anda até o campo, clica e digita
letra por letra. A voz dela entra no Meet, então os participantes ouvem.

Este projeto traz uma **apresentação de teste de 5 minutos** (5 slides + uma demo do "Banco Demo") para servir de base
às apresentações reais.

## Como funciona

```
microfone ─► co-piloto (Chrome) ◄─WebRTC─► OpenAI Realtime (voz + ferramentas)
                    │
                    └─HTTP─► servidor local ─► Playwright ─► janela do palco (slides + demo) ─► compartilhada no Meet
voz da Calíope ─► BlackHole ─► microfone agregado do Meet
```

- `agent.mjs`: personalidade, regras e ferramentas da assistente.
- `stage.mjs`: a janela do palco (Playwright). Slides por teclado, demo por cursor e digitação, roteiros prontos.
- `server.mjs`: serve as páginas, cria a sessão de voz (a chave fica no servidor) e executa as ferramentas.
- `public/index.html` + `copiloto.js`: o painel do co-piloto, que você deixa aberto fora da tela compartilhada.
- `public/deck/`: os 5 slides de teste. `public/demo/`: o Banco Demo.

## Como falar com a Calíope

| Jeito | Exemplo | O que acontece |
| --- | --- | --- |
| Comando direto, sem nome | "Próximo slide", "volta", "slide 3", "mostra os slides" | Executa na hora, sem passar pelo modelo e sem ela falar |
| Pelo nome | "Calíope, abre a conta da Maria" | Ela responde e fica **acordada** |
| Acordada | "E quanto tempo isso leva?" | Qualquer fala vai para o modelo, que decide se é para ela ou para a plateia |

Ela fica acordada por 30 segundos depois da última troca (ajustável no painel) e depois **dorme**: aí só o nome ou um
comando direto a acordam. O painel mostra em destaque **Ouvindo** ou **Dormindo 💤**, com a contagem, e um selo
discreto no canto da janela do palco mostra o mesmo para você e para a plateia (desmarque **selo no palco** para
esconder). **Sempre atenta** deixa ela acordada o tempo todo.

Comandos diretos só valem quando a frase é curta e é só o comando: "No próximo slide vamos ver..." não troca o slide.

**Ações são silenciosas:** quando você pede uma ação ("Calíope, abre a conta da Maria"), ela executa sem falar nada e
volta a dormir até você chamá-la de novo. Ela só fala quando você faz uma pergunta ou pede uma explicação, ou quando
uma ação falha. Por dentro, cada pedido vira primeiro uma resposta só de texto; se for uma ação, nada é dito.

**O sim é do humano:** a Calíope nunca confirma, aprova nem autoriza nada na demo. "Calíope, confirma para mim?" recebe a
recusa pronta, "Isso eu não posso. O sim é seu." (`RECUSA` no `.env` troca a frase), sem passar pelo modelo, e ela
dorme. Se o modelo tentar clicar em Confirmar ou digitar "sim", o palco recusa a ferramenta. Detalhes em
`docs/agentes-na-pratica.md`, seção 4.4.

**Para cortar a Calíope:** comece a falar e ela para na hora. "Ok", "tá bom", "para", "chega", "obrigado, Calíope" ou
"pode dormir" calam a Calíope e a colocam para dormir. No painel, **Silenciar (Esc)** faz o mesmo. A fala que a
interrompeu só vira pedido se tiver o nome dela.

## Velocidade

- **Ouvido rápido** (ligado por padrão no painel): o reconhecimento de voz do próprio Chrome roda junto com a
  OpenAI e executa comandos diretos e o "ok" assim que fecha a frase, sem esperar a transcrição. Ele usa o
  microfone padrão do sistema, então deixe o seu microfone real como entrada padrão do Mac.
- O registro do painel mostra, em milissegundos, quanto tempo passou desde que você parou de falar até a
  transcrição, a ação e o começo da fala dela. Use isso para ver onde está a lentidão.
- Ajustes no `.env`: `SILENCE_MS` (pausa que fecha a sua frase, padrão 300), `CURSOR_STEPS` (padrão 16) para
  o cursor e `TYPE_WPM` (padrão 40, a média de uma pessoa) para a digitação na demo, com ritmo irregular.

## Instalar (Mac)

```bash
npm run setup            # instala o Playwright e o Chromium
cp .env.example .env     # coloque a OPENAI_API_KEY
npm start                # http://localhost:8787
npm test                 # teste automático, sem microfone e sem chave
```

Para a janela do palco usar o seu Google Chrome em vez do Chromium, defina `BROWSER_CHANNEL=chrome` no `.env`.

## Áudio no Meet (uma vez)

1. Instale o [BlackHole 2ch](https://existential.audio/blackhole/) (gratuito): `brew install --cask blackhole-2ch`.
2. Abra **Configuração de Áudio MIDI** › **+** › **Criar Dispositivo Agregado**. Marque o seu microfone real e o
   BlackHole 2ch. Renomeie para "Mic + Calíope".
3. No Meet, escolha **Mic + Calíope** como microfone. Use fone de ouvido.
4. No painel do co-piloto, escolha o seu microfone real em **Microfone** e **BlackHole 2ch** em **Saída**. Deixe
   **ouvir no fone também** marcado para você ouvir a Calíope.

O co-piloto escuta só o microfone real, então nunca ouve a própria voz. Desative a supressão de ruído do Meet se a
voz da Calíope soar cortada.

## Roteiro da apresentação de teste (5 min)

| Tempo | Slide | Você diz |
| --- | --- | --- |
| 0:00 | 1 | Abertura. "Calíope, se apresenta para o pessoal." |
| 0:45 | 2 | "Próximo slide." Você fala do problema. |
| 1:45 | 3 | "Avança." "Calíope, explica em uma frase como você decide o que fazer." "E por que não erra o botão?" (ainda acordada) |
| 2:45 | 4 | "Próximo." "Calíope, abre a conta da Maria Oliveira no Banco Demo." Ela narra e preenche. |
| 4:00 | 5 | "Mostra os slides." "Slide 5." "Calíope, resume o que vimos em duas frases." |

Antes de começar: `npm start`, abra http://localhost:8787 no Chrome, clique **Abrir janela do palco**, compartilhe
essa janela no Meet e clique **Conectar voz**.

## Plano B

- **Plano B: voz do navegador** usa o reconhecimento de voz do Chrome e comandos fixos ("próximo", "slide 3",
  "abre a conta", "volta para os slides"), com a mesma regra de acordada e dormindo. Não custa nada, mas a voz é a do sistema e não passa pelo BlackHole.
- A caixa de texto do painel aceita os mesmos pedidos.
- O teclado continua funcionando na janela do palco.
- Se a sessão de voz cair (as sessões têm duração máxima), o co-piloto reconecta sozinho e reenvia o slide atual.

## Adaptar para uma apresentação real

- **Outro deck:** `DECK_URL` no `.env`. Qualquer deck que aceite as setas funciona (por exemplo o do bbdw-2026). Se o
  deck expuser `window.deck.state()` com título e notas, a Calíope recebe as notas a cada troca de slide.
- **Outra demo:** `DEMO_URL`, ou peça "Calíope, abre a página ..." com o endereço. As ferramentas livres (`clicar`,
  `preencher`, `selecionar`, `ler_tela`) acham elementos pelo rótulo ou texto visível.
- **Roteiro confiável:** para a parte mais importante da demo, escreva uma função em `stage.mjs` como
  `scriptOpenAccount` e registre o nome em `executar_roteiro` (`agent.mjs`). Pedidos livres são para improviso.
- **Comandos `oc` e APIs:** ficam como uma nova ferramenta no servidor, com lista de comandos permitidos.
- **Resultado de uma cena no slide:** outro programa desta máquina pode mandar `POST /api/stage/cena` com
  `{id, titulo, onde, estado, linhas}`; se o deck expuser `window.deck.cena`, o resultado aparece por cima do slide
  atual. É como a Mesa da demo mostra o 403 e o 429 do cluster (`docs/agentes-na-pratica.md`, seção 4.5).

## Custos

Com `gpt-realtime-2.1`, 1 hora ao vivo custa até cerca de US$ 6,60; com `gpt-realtime-2.1-mini`, cerca de US$ 3.
Use o mini (`REALTIME_MODEL=gpt-realtime-2.1-mini`) nos ensaios.
