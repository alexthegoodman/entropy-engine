# Predictive Next Actions

## User Story

**As a user working within an application, I want the application to anticipate the actions I am likely to take next and surface those actions directly in a “Suggested Next Steps” panel, so that I can complete my intended workflow without repeatedly navigating through the application to find the appropriate controls.**

The system should learn to predict upcoming actions from the semantic sequence of actions already taken, the current application state, and available context. Rather than attempting to predict mouse movements or raw UI interactions, the model operates on the application's underlying semantic functions and their parameters.

The initial objective is **assisted prediction rather than autonomous execution**. The user remains in control of whether predicted actions are performed.

---

## User Experience

The application includes a persistent or contextually available **Suggested Next Steps** panel.

As the user works, the system observes the semantic actions being performed and continuously predicts a likely continuation of the current workflow.

For example, after observing:

`search_customer → open_customer → open_order`

the system might predict:

`review_refund → issue_refund → notify_customer`

Rather than simply displaying these predictions as text, the panel renders the actual controls necessary to perform them. If issuing a refund requires an amount, the amount field and refund button appear directly in the panel. If notifying the customer requires choosing a template, the appropriate template selector appears there as well.

The user therefore does not need to navigate through the application to locate the controls associated with the predicted next actions.

Predicted steps should remain individually controllable. Depending on the action, the user may execute a step, modify its parameters, skip it, or potentially execute multiple suggested steps together.

The panel also provides a **Refresh Plan** control. Refreshing indicates that the currently predicted trajectory does not match the user's intent and requests an alternative continuation.

Over time, interactions with the panel become an additional source of high-quality behavioral feedback.

---

## Semantic Action Model

The prediction system operates over a defined vocabulary of semantic application functions rather than raw interface events.

Examples might include:

`search_customer(name)`

`open_customer(customer_id)`

`get_orders(customer_id)`

`issue_refund(order_id, amount)`

`send_email(customer_id, template)`

The application's existing UI and the Suggested Next Steps panel are therefore two different interfaces into the same underlying action system.

Each function exposes enough metadata for the application to deterministically construct its appropriate UI controls. The model predicts **what should be available next**, while the application remains responsible for rendering and validating the actual interface.

This separation allows prediction quality to improve independently from UI implementation and avoids requiring the model to generate arbitrary interfaces.

---

## Data Strategy

Initial model development will primarily use **procedurally generated semantic action sequences** rather than relying on large amounts of recorded human interaction data.

Synthetic environments will define application state, available functions, constraints, and possible tasks. Procedural generators will create many different problems and valid action trajectories through those environments.

A generated example might contain:

**Task:** Refund the customer's most recent failed order.

**Trajectory:**

`search_customer → open_customer → get_orders → open_order → issue_refund`

During training, the model receives partial trajectories and learns to predict their continuation.

Importantly, the dataset should be designed for **generalization rather than memorization**. Evaluation should deliberately contain novel problems, combinations of actions, parameters, states, and longer workflows that were not represented directly in training.

The goal is to determine whether the model can infer the latent task being performed and generalize an appropriate continuation from a partial sequence of semantic actions.

Synthetic generation also gives us access to information that ordinary behavioral logs do not provide: the underlying task, valid solutions, alternative solutions, and known incorrect actions.

---

## Real-World Behavioral Data

Real user interaction data can be introduced later as a complementary signal rather than as the sole source of training truth.

Human traces contain useful behavioral information, but they also contain exploration, mistakes, uncertainty, learning behavior, unnecessary navigation, and application friction. Simply imitating these traces could cause the model to reproduce inefficient behavior rather than anticipate useful actions.

Instead, synthetic data can establish a generalized model of competent task continuation, while real interaction data can progressively teach the system how actual users behave.

Interactions with Suggested Next Steps provide especially valuable signals:

**Accept** indicates that the predicted action or plan matched the user's intent.

**Modify** indicates that the general prediction was correct but some action, ordering, or parameter was incorrect.

**Skip** indicates that a particular predicted step was unnecessary.

**Refresh** indicates that the proposed trajectory substantially differed from the user's intended trajectory.

These signals can eventually support personalization without requiring the base model to learn every user's habits from scratch.

---

## Written WIR Brain

The predictor is a program written by hand in Yumon Pet's WIR language and compiled to a small ReLU network, not a trained model. (The first version was a Burn Mixture-of-Experts transformer trained on simulated sessions; the written brain replaced it, and scores higher on the same held-out sessions: see Implementation.)

The program reads the last substantive action, a few facts about the song (the active track's instrument family, the track count, how full the pattern and the arrangement are, how far mixing has got) and the last note, clip and mixer track touched. It scores every action the way a producer would describe a session: a new song starts with the tempo; a new track gets an instrument, its preset, the song's scale, a root, a pattern length and then notes; a filter tweak goes with the envelope; a solo is followed by the level. It also outputs the parameters it can reason about (the next note's row and step, the next clip's lane, bar and length, the mixer track, solo on/off, a pattern length).

The host chains steps into a short plan, so the panel shows where the session is heading rather than one action at a time.

---

## Prediction and UI Pipeline

At a high level, the system operates as:

**Application State + Action History**

↓

**Semantic Representation**

↓

**WIR Brain**

↓

**Candidate Next-Action Plan**

↓

**Application Policy / Validation**

↓

**UI Control Renderer**

↓

**Suggested Next Steps**

The model's responsibility ends at proposing semantic actions and their likely parameters.

Application code remains responsible for authorization, validation, rendering, and execution. This boundary is important because it allows the predictive system to remain probabilistic while actual application behavior remains deterministic and governed by existing business rules.

---

## Implementation (DAW, vocabulary v3)

**Vocabulary** (`src/prediction/daw_actions.rs`): 56 substantive actions across tracks, the song, piano roll, patterns, arrangement, mixer, sound, effects, every instrument family (drum rack, synth, wavetable, bowed strings, brass, piano, Matter kit, water, VST3), Moves and export. Interface actions are not in the vocabulary, so they are neither recorded nor predicted: view switches, windows, track/clip/pattern selection, play/stop/rewind/seek, loop mode, snap, note previews, undo, saving versions and guitar input on/off. Each action declares typed parameters (`knob`, `int`, `choice`, `toggle`, `note`, `track`) with range, default and, for choices, a named option list whose ids match the DAW's own preset ids.

**What each step carries**: the action, its parameters (a note's row and step, a fader's track and level, a preset index...) and the song's context after it: the active track's instrument family, the track count, the active pattern's notes per step and length, and how much of the song is arranged.

**Recording in the DAW** (`daw_predict.ts`, `daw_synth_addon.ts`): every edit records an action. A piano-roll click is `add_note`/`remove_note`; a drag along a row is one `paint_notes`/`erase_notes`. Continuous controls (faders, knobs, filter and envelope sliders, wavetable position) coalesce into one entry per drag.

**Brain** (`src/prediction/brain.rs`): the WIR program is `yumon-pet/wir/examples/daw_brain.wir`, generated with its plain-code rule by `wir daw` (`wir/src/daw.rs`), which checks the compiled network against the rule on 200k random inputs and exports `src/prediction/daw_brain.json` (sparse layers, the source, 64 test vectors). Entropy embeds the JSON, checks its action list against the vocabulary at load, reads the history into the 75 inputs, runs the network and takes softmax(score / 2) over the keys for confidences. Parameters the network does not predict are the ones last used for that action, else the defaults. "Another plan" opens with the next most likely first action.

**Data** (`src/prediction/daw_sim.rs`): a simulated DAW (tracks, families, patterns, clips) driven by sessions of chained goals (start song, drums, bass, chords, melody, sound design, arrange, variation, mix, finish, edit), sampled personas (painting vs clicking, slips, Moves use, tweak depth) and ten genres with their own tempo, scales, progressions, grooves and instrument choices per role. Four genre/role/family pairings are held out and make up the eval split. The rules were written against the train split; the numbers below are the eval split.

**Results** (Windows 11, Intel i5-12500, release build, 1000 held-out sessions, seed 42, 66,471 next steps; queries at the start of each session and after every substantive step):

| Predictor | Top-1 | Top-3 |
|---|---|---|
| Burn MoE (vocabulary v2 checkpoint, logits restricted to the 56 substantive actions, full history including interface actions) | 78.7% | 88.6% |
| Bigram table counted on the train split (reference, not shipped) | 77.4% | 90.8% |
| WIR brain (`wir daw --sessions`, same sessions) | 80.0% | 92.3% |
| WIR brain in Entropy (`bench_prediction`, regenerated v3 sessions, 64,809 steps) | 80.0% | 92.0% |

When the action is right, the brain's note row is right 41% of the time and its step 34% (melodic contour is not in the history), a clip's lane, bar and length together 40%, and the mixer track 87%. One ranking takes 2.5 us (median) and a 3-step plan about 10 us on the CPU.

**Changing the rules** (in `yumon-pet/wir`):

```
cargo run --release --bin gen_daw_data -- --out data/daw_sessions.json --count 3000 --eval-count 1000   # in entropy-engine
cargo run --release -- daw --sessions ../../entropy-engine/data/daw_sessions.json                        # score, top misses
cargo run --release -- daw --out examples --export ../../entropy-engine/src/prediction/daw_brain.json --vectors 64
```
