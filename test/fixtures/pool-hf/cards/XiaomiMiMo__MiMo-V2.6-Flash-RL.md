---
license: mit
language:
- en
- zh
tags:
- text-generation
- multimodal
- vision-language
- audio
- agent
- video-understanding
- long-context
- mimo_v2
- transformers
library_name: transformers
---

<br/><br/>

<div align="center">
  <picture>
    <source srcset="https://github.com/XiaomiMiMo/MiMo/raw/main/figures/Xiaomi_MiMo_darkmode.png?raw=true" media="(prefers-color-scheme: dark)">
    <img src="https://github.com/XiaomiMiMo/MiMo/raw/main/figures/Xiaomi_MiMo.png?raw=true" width="60%" alt="Xiaomi-MiMo" />
  </picture>
</div>

<br/>

<div align="center" style="line-height: 1;">
  |
  <a h
[... trimmed ...]
uts with prefix-conditioned single-turn rollouts (Teacher-Prefix and SFT-Prefix), reusing histories from teacher trajectories and SFT demonstrations so decision points train without regenerating preceding turns — extending capabilities to hard-to-verify tasks.

## Model Summary

- **Architecture**: Sparse MoE (Mixture of Experts), 309B total / 15B activated parameters
- **Context Length**: 1M tokens
- **Modalities**: Text, Image, Video, Audio
- **Vision Encoder**: 681M-param MiMo ViT (28 layers: 24 SWA + 4 Full)
- **Audio Encoder**: 308M AudioTokenizer + 127M audio patch encoder
- **Multi-Token Prediction (MTP)**: 5-layer speculative decoder

![Figure 1: MiMo-V2.6 architecture — omni encoders, hybrid
[... trimmed ...]
 71.5 | - | 70.0 | 73.4 | 69.1 |

## 4. Model Architecture

### LLM Backbone

| Component | MiMo-V2.6-Flash-RL |
| --- | --- |
| Layers (Total / SWA / GA) | 48 / 39 / 9 |
| Hidden Size | 4096 |
| SWA Heads (Q/KV) | 64 / 8 |
| GA Heads (Q/KV) | 64 / 4 |
| Head Dimensions (QK / V) | 192 / 128 |
| Sliding Window Size | 128 |
| Routed Experts (Total / Activated) | 256 / 8 |
| Max Context Length | 1M |
| MTP / Speculative Decoder | 5 SWA layers, window 1024 |

The first Transformer block uses global attention with a dense FFN. Remaining blocks interleave local SWA and GA; both use sparse MoE FFNs without shared experts.

### Vision Encoder (MiMo ViT)

| Configuration | Value |
| --- | --- |
| Layers (Tota