# Calíope co-presenter

An AI co-presenter (**Calíope**) for live talks on Google Meet. She keeps listening, answers when called by name,
changes slides and runs a web page like a user: the cursor moves to the field, clicks and types key by key.
Her voice goes into Meet, so participants hear her.

She speaks the talk's language (`LANGUAGE`, default `pt-BR`) and switches if you talk to her in another one.
Voice commands work in Portuguese and English.

The repo ships a **5-minute test presentation** (5 slides + a "Demo Bank" demo) as a base for real talks.

## How it works

```
mic ─► copilot (Chrome) ◄─WebRTC─► OpenAI Realtime (voice + tools)
              │
              └─HTTP─► local server ─► Playwright ─► stage window (slides + demo) ─► shared in Meet
Calíope's voice ─► BlackHole ─► Meet's aggregate microphone
```

- `agent.mjs`: personality, language, rules and tools.
- `stage.mjs`: the stage window (Playwright). Slides by keyboard, demo by cursor and typing, ready-made scripts.
- `server.mjs`: serves the pages, creates the voice session (the key stays on the server) and runs the tools.
- `public/index.html` + `copilot.js`: the copilot panel, which you keep open outside the shared screen.
- `public/deck/`: the 5 test slides. `public/demo/`: the Demo Bank.

## Talking to Calíope

| Way | Example | What happens |
| --- | --- | --- |
| Direct command, no name | "Next slide", "back", "slide 3", "show the slides", "próximo slide" | Runs at once, without the model and without her speaking |
| By name | "Calíope, open an account for Maria" | She answers and stays **awake** |
| Awake | "And how long does that take?" | Anything goes to the model, which decides whether it is for her or for the audience |

She stays awake for 30 seconds after the last exchange (adjustable in the panel) and then **sleeps**: only her name or a
direct command wakes her. The panel shows **Listening** or **Asleep 💤** with the countdown, and a discreet badge on the
stage window shows the same to you and the audience (uncheck **badge on stage** to hide it). **Always listening** keeps
her awake all the time.

Direct commands only count when the sentence is just the command: "In the next slide we will see..." does not change slides.

**Actions are silent:** when you ask for an action, she does it without saying anything and goes back to sleep until you
call her. She only speaks for a question, an explanation or a failed action. Internally each request first becomes a
text-only response; if it is an action, nothing is said.

**The yes belongs to the human:** Calíope never confirms, approves or authorizes anything in the demo. "Calíope, confirm it
for me?" gets the ready refusal (pt-BR: "Isso eu não posso. O sim é seu."; `REFUSAL` in `.env` replaces it), without the
model, and she sleeps. If the model tries to click Confirm or type "yes", the stage refuses the tool. Details in
`docs/agents-in-practice.md`, section 4.4.

**To cut Calíope off:** start talking and she stops at once. "Ok", "stop", "thanks, Calíope", "para", "chega" or
"pode dormir" silence her and put her to sleep. In the panel, **Silence (Esc)** does the same. The utterance that
interrupted her only becomes a request if it has her name. During a guided explanation only "Calíope, stop" / "para"
or Esc stop it, and they stop the whole sequence.

## Language

| Variable | Default | Effect |
| --- | --- | --- |
| `LANGUAGE` | `pt-BR` | talk language (BCP 47): her speech, the transcription, Chrome's recognition, the macOS voices and the fixed phrases. `auto` lets the transcription detect it |
| `PRESENTER_NAME` | `Jonathan` | who presents |
| `REFUSAL` | per language | the refusal sentence |

Fixed phrases (refusal, failure, badge) exist for pt, en and es; other languages fall back to English. The prompts and
the code are in English to save tokens; the talk can be in any language.

## Speed

- **Fast ear** (on by default): Chrome's own speech recognition runs next to OpenAI and runs direct commands and
  "ok"/"stop" as soon as the sentence closes, without waiting for the transcript. It uses the system's default mic,
  so keep your real mic as the Mac's default input.
- The panel log shows, in milliseconds, the time from when you stopped talking to the transcript, the action and the
  start of her speech.
- `.env` knobs: `SILENCE_MS` (pause that closes your sentence, default 300), `CURSOR_STEPS` (default 16) and
  `TYPE_WPM` (default 40, an average person) for typing in the demo, with an uneven rhythm.

## Install (Mac)

```bash
npm run setup            # installs Playwright and Chromium
cp .env.example .env     # put in OPENAI_API_KEY
npm start                # http://localhost:8787
npm test                 # automatic test, no mic and no key
```

To have the stage window use your Google Chrome instead of Chromium, set `BROWSER_CHANNEL=chrome` in `.env`.

## Audio in Meet (once)

1. Install [BlackHole 2ch](https://existential.audio/blackhole/) (free): `brew install --cask blackhole-2ch`.
2. Open **Audio MIDI Setup** › **+** › **Create Aggregate Device**. Check your real mic and BlackHole 2ch.
   Rename it "Mic + Calíope".
3. In Meet, choose **Mic + Calíope** as the microphone. Use headphones.
4. In the copilot panel, choose your real mic in **Mic** and **BlackHole 2ch** in **Output**. Keep
   **also on headphones** checked to hear Calíope.

The copilot only listens to the real mic, so it never hears its own voice. Turn off Meet's noise suppression if
Calíope's voice sounds choppy.

## Test presentation script (5 min)

| Time | Slide | You say |
| --- | --- | --- |
| 0:00 | 1 | Opening. "Calíope, introduce yourself." |
| 0:45 | 2 | "Next slide." You talk about the problem. |
| 1:45 | 3 | "Next." "Calíope, explain in one sentence how you decide what to do." "And why don't you miss the button?" (still awake) |
| 2:45 | 4 | "Next." "Calíope, open an account for Maria Oliveira at the Demo Bank." She fills it in. |
| 4:00 | 5 | "Show the slides." "Slide 5." "Calíope, sum up what we saw in two sentences." |

Before starting: `npm start`, open http://localhost:8787 in Chrome, click **Open stage window**, share that window in
Meet and click **Connect voice**.

## Plan B

- **Plan B: browser voice** uses Chrome's speech recognition and fixed commands ("next", "slide 3", "open account",
  "back to the slides", and the Portuguese ones), with the same awake/asleep rule. It is free, but the voice is the
  system's and does not go through BlackHole.
- The panel's text box takes the same requests.
- The keyboard still works in the stage window.
- If the voice session drops (sessions have a maximum length), the copilot reconnects by itself and resends the current slide.

## Adapting to a real talk

- **Another deck:** `DECK_URL` in `.env`. Any deck that takes arrow keys works. If the deck exposes
  `window.deck.state()` with title and notes (`title`/`notes` or `titulo`/`notas`), Calíope gets the notes on every change.
- **Another demo:** `DEMO_URL`, or ask "Calíope, open the page ..." with the address. The free tools (`click`, `fill`,
  `select`, `read_screen`) find elements by label or visible text.
- **Reliable script:** for the most important part of the demo, write a function in `stage.mjs` like
  `scriptOpenAccount` and register its name in `run_script` (`agent.mjs`). Free requests are for improvising.
- **`oc` commands and APIs:** add them as a new server tool, with an allowlist of commands.
- **A scene result on the slide:** another program on this machine can `POST /api/stage/cena` with
  `{id, titulo, onde, estado, linhas}`; if the deck exposes `window.deck.cena`, the result shows over the current slide.
  This is how the demo console shows the cluster's 403 and 429 (`docs/agents-in-practice.md`, section 4.5).

## Costs

With `gpt-realtime-2.1`, 1 hour live costs up to about US$ 6.60; with `gpt-realtime-2.1-mini`, about US$ 3.
Use mini (`REALTIME_MODEL=gpt-realtime-2.1-mini`) in rehearsals.
