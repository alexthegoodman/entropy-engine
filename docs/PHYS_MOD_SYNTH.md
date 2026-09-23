# Physical Modeling String Instrument

## Vision

As a musician using Entropy DAW, I want to play and design a physically modeled bowed-string instrument whose sound and 3D representation are two views of the same underlying instrument, so that I can understand and shape sound through intuitive physical relationships rather than relying exclusively on abstract synthesizer controls.

The instrument should be capable of producing convincing violin, viola, cello, bass, and string-section sounds without requiring recorded samples as its fundamental sound source.

However, realism is only the starting point.

The same system should eventually allow musicians to construct instruments that cannot exist in the physical world: unusual string lengths and materials, impossible body dimensions, unconventional bridges and resonators, sympathetic strings, novel excitation mechanisms, and other combinations that turn acoustic-instrument design itself into a form of synthesis.

The guiding idea is:

**Don't just program a sound. Build an instrument.**

---

## Core Experience

When I load the instrument, I see a playable 3D string instrument rather than only a conventional synthesizer panel.

Playing MIDI causes the modeled instrument to respond visually and acoustically. Strings vibrate. The bow interacts with them. Energy travels through the bridge and into the resonating body. Vibrational motion may be visually exaggerated so that phenomena too small or fast to see on a real instrument become understandable.

Traditional controls such as knobs, sliders, numerical inputs, modulation assignments, and automation remain available. The 3D instrument does not replace precise controls; it provides a more intuitive representation of what those controls mean.

Whenever practical, these two interfaces remain synchronized. Moving a bow-position control moves the bow's contact point in the visualization. Manipulating the bow directly updates the corresponding parameter. Changing the instrument's physical properties changes both its appearance or physics visualization and its sound.

The result should feel less like controlling an animation attached to a synthesizer and more like interacting with a virtual acoustic object.

---

# Phase 1 — Playable Modeled String

The first phase establishes the instrument as a genuinely playable synthesizer.

The initial target should be a single bowed string instrument, such as a violin or cello, rather than attempting an entire orchestra immediately.

The sound is generated from a physical model of the instrument. At minimum, the model represents the interaction between:

**player → bow → string → bridge/body → audible output**

The performer can play the instrument from MIDI and continuously control the most musically important dimensions of the model, including dynamics, bow force, bow velocity, bow position, vibrato, fingering/pitch, damping, and related expressive characteristics.

These parameters should behave as properties of a physical system rather than merely conventional synthesizer macros. Increasing bow pressure, for example, should alter the behavior and harmonic structure of the string rather than simply increasing volume.

A 3D representation of the instrument accompanies the synthesis. It reacts in real time to the state of the model, including the currently sounding string, fingering position, bow position and motion, and string vibration.

The visualization does not need to reproduce microscopic physics literally. Displacements and vibrations may be exaggerated substantially to communicate what the model is doing.

### Phase 1 success

A musician can load the instrument, play a convincing and expressive bowed-string performance from MIDI, and immediately develop an intuitive relationship between what they hear and what they see.

Someone unfamiliar with terms such as "bow position" should be able to manipulate the instrument visually and begin understanding the parameter by hearing the result.

---

# Phase 2 — Physics as the Interface

Once the underlying instrument is convincing, the 3D representation becomes a primary sound-design interface.

The musician can directly manipulate meaningful parts of the virtual instrument. Depending on the selected component, they can modify properties such as string characteristics, bow contact, bridge behavior, damping, resonances, body response, and coupling between components.

Traditional controls remain available for precision and automation, but manipulating the physical object and manipulating its parameters are two interfaces into the same state.

The instrument gains a dedicated **Physics View** alongside its normal visual presentation.

Physics View reveals otherwise invisible behavior: standing waves along strings, nodes and antinodes, energy entering the bridge, resonant modes of the body, damping, excitation, and other useful representations of the synthesis state.

These visualizations should prioritize musical understanding over strict scientific visualization. Microscopic motion can be exaggerated, slowed, colored, isolated, or otherwise transformed when doing so makes the behavior easier to understand.

The musician should increasingly be able to answer:

**"Why did that change the sound?"**

simply by looking at the instrument.

### Phase 2 success

Sound design no longer feels primarily like adjusting unrelated parameters.

A musician can hear an undesirable or interesting characteristic, inspect what the virtual instrument is doing, manipulate the relevant physical component, and immediately hear and see the consequences.

The 3D model has become a functional synthesis interface rather than a visualizer.

---

# Phase 3 — Instrument Laboratory

The final phase deliberately moves beyond simulation of existing instruments.

The musician can modify the architecture of the modeled instrument itself.

They might lengthen a violin body, alter string dimensions or materials, modify the bridge, change the resonating body, introduce sympathetic strings, create unusual couplings between resonators, or construct configurations with no practical real-world equivalent.

Parameters should be allowed to move beyond physically conventional ranges where the synthesis model remains stable and musically useful.

Presets can therefore represent both familiar instruments:

**Violin → Viola → Cello → Bass**

and entirely invented families of instruments.

Where appropriate, physical dimensions become continuous dimensions of synthesis. Rather than selecting "violin" or "cello," for example, the musician could move through the physical space between them and continue beyond either.

The ultimate experience resembles a virtual instrument workshop. A musician can begin with a recognizable violin, pull and reshape its physical properties while playing it, and gradually transform it into an instrument that has never existed.

### Phase 3 success

Users are no longer asking only:

**"How realistic is the violin?"**

They are also asking:

**"What happens if I build this?"**

A sound created in the instrument can be understood not merely as a collection of synthesizer settings, but as the behavior of a particular virtual acoustic object.

---

## Important Product Principle: One Instrument, Two Representations

The audio simulation and visual simulation do not need to operate at the same fidelity or update rate.

The audio engine should use whatever representation is appropriate for stable, low-latency synthesis. The visualization should consume meaningful state from that model and render an intuitive representation at graphical frame rates.

Therefore, visual geometry does not necessarily need a one-to-one correspondence with the mathematical representation used by the audio engine.

What matters is **semantic correspondence**:

When the user changes something they can see, the appropriate physical property of the synthesis model changes.

When the synthesis model changes in a musically meaningful way, the visualization communicates that change.

The visualization should never imply a physical relationship that is unrelated to the resulting sound merely for the sake of animation.

---

## Interaction Principle

Every major parameter should be considered for three possible representations:

**Physical interaction** — manipulate something on the instrument.

**Precision control** — manipulate a knob, slider, numerical value, or other conventional control.

**Modulation/automation** — allow the DAW, MIDI, envelopes, LFOs, controllers, or other sources to manipulate it over time.

These should converge on the same underlying parameter wherever possible.

For example, bow position might be changed by dragging the bow in 3D, turning a knob, recording automation, mapping MIDI CC, or assigning modulation. Regardless of how it is changed, the 3D instrument and conventional UI remain synchronized.

This allows the interface to remain approachable without sacrificing the precision expected from a serious synthesizer.

---

## North Star

The feature succeeds when the visualization stops feeling like a visualization.

The user should gradually develop the mental model that there is an **instrument inside Entropy**.

It has strings.

It has a body.

It has resonances.

Energy moves through it.

The performer excites it.

Its construction determines its voice.

And because it is virtual, its construction does not have to obey the practical limitations of wood, strings, gravity, manufacturing, or even conventional instrument design.

**Physical modeling provides the sound.
3D provides the intuition.
Entropy turns the instrument itself into the synthesizer.**
