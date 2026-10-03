---
library_name: transformers
inference: false
extra_gated_description: >-
  To learn more about how we process your personal data, please read our <a
  href="https://poolside.ai/legal/privacy">Privacy Policy</a>.
tags:
- laguna-s-2.1
- vllm
license: openmdw-1.1
pipeline_tag: text-generation
---

<p align="center">
  <img alt="poolside-banner" src="https://poolside.ai/assets/laguna/laguna-s-2-1-banner.svg" width="800px">
</p>

<p align="center">
  <a href="https://openrouter.ai/poolside/laguna-s-2.1"><strong>Use on OpenRouter</strong></a> ·
  <a href="https://vercel.com/ai-gateway/models/lagu
[... trimmed ...]
na-s-2.1"><strong>Use on Vercel AI Gateway</strong></a> ·
  <a href="https://poolside.ai/blog/introducing-laguna-s-2-1"><strong>Release blog post</strong></a>
</p>

<br>

# Laguna S 2.1

Laguna S 2.1 is a 118B total parameter Mixture-of-Experts model with 8B activated
parameters per token, designed for agentic coding and long-horizon work. It sits
between [Laguna XS 2.1](https://huggingface.co/poolside/Laguna-XS-2.1) (33B-A3B) and
Laguna M.1 (225B-A23B) in the Laguna series and shares the family recipe: a
token-choice router with softplus gating over 256 routed experts plus one shared
expert, grouped-query atte
[... trimmed ...]
//huggingface.co/poolside/Laguna-S-2.1-INT4) and
  [GGUF](https://huggingface.co/poolside/Laguna-S-2.1-GGUF)
- **OpenMDW-1.1 license**: Use and modify the model and associated materials freely
  for commercial and non-commercial purposes
  ([learn more about OpenMDW](https://openmdw.ai/))

## Model overview

- Number of parameters: 118B total, ~8B activated per token
- Layers: 48 (12 global attention, 36 sliding-window attention)
- Experts: 256 routed (top-10) plus 1 shared expert
- Attention: grouped-query, 8 KV heads, head dim 128; per-head softplus output gating
- Sliding window: 512 tokens
- Context window: 1,048,576 tokens
- Vocabulary: 100,352 tokens (Laguna family tokenizer)
- Modality: text-t