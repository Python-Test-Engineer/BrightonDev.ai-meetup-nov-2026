Great question! There are several reasons why `temperature=0` doesn't guarantee perfectly deterministic outputs or eliminate hallucinations:

## Why It's Not Perfectly Deterministic

1. **Floating point operations**: Even with temperature=0, the model still performs numerous floating-point calculations. These can have slight variations depending on hardware, GPU architecture, or even the order of operations, leading to tiny numerical differences that can cascade into different token selections.

2. **Tie-breaking**: When multiple tokens have identical (or nearly identical) probabilities after applying temperature=0, the model needs to break ties somehow. This tie-breaking mechanism might not be perfectly deterministic across different runs or infrastructure.

3. **Implementation details**: The exact sampling implementation can vary. Some systems might have non-deterministic elements in their inference pipeline, parallel processing, or batching strategies.

## Why Hallucinations Still Occur

This is the more important point: **temperature controls randomness, not accuracy**. 

- **Temperature=0** means the model always picks the most likely next token (greedy decoding)
- But "most likely" doesn't mean "most accurate" or "most truthful"

The model generates what seems most probable based on its training, which can include:
- Plausible-sounding but incorrect information
- Confident statements about things it doesn't actually "know"
- Coherent text that doesn't match reality

### My addition

Greedy selection is not used but a random pick of the most likely next token. 

If there are two closely matching tokens then the model will randomly pick one. Otherwise, bias and inaccuracies could start to get built in.

**Hallucinations are a fundamental limitation of how LLMs work** - they predict tokens based on patterns, not retrieval from a verified knowledge base. Setting temperature=0 just makes the model *consistently* produce its "best guess," but that guess can still be wrong.

Think of it like this: if you ask someone who's confidently wrong to always give their most confident answer (temperature=0), they'll consistently give you wrong answers deterministically!