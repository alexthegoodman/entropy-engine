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

## Mixture-of-Experts Model

The prediction model will use the team's existing **Mixture-of-Experts (MoE)** architecture as its foundation.

The intuition is that different workflows contain different behavioral patterns. Rather than requiring every part of the model to represent every type of behavior equally, specialized experts can learn different patterns while a routing mechanism determines which experts are most relevant to the current context.

Experts may naturally develop specialization around different workflow structures, action families, contexts, or behavioral patterns without requiring those categories to be manually encoded.

The model receives a representation of the recent semantic action history and relevant application state and produces predictions for likely future semantic actions.

The initial model should prioritize predicting a **short trajectory or plan**, rather than only predicting a single next action. This allows the Suggested Next Steps panel to represent where the workflow appears to be heading rather than continually reacting one action at a time.

Implementation will use the existing MoE codebase within the **Rust Burn framework**, extending it as necessary for semantic sequence modeling and action prediction.

---

## Prediction and UI Pipeline

At a high level, the system operates as:

**Application State + Action History**

↓

**Semantic Representation**

↓

**MoE Predictor**

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

Note: The model.bin will be downloaded from a CDN rather than embedding a single version in the git history or binary. (even though it is a small binary)