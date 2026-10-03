---
library_name: transformers
license: apache-2.0
license_link: https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE
pipeline_tag: image-text-to-text
---

# Qwen3.6-35B-A3B

<img width="400px" src="https://qianwen-res.oss-accelerate.aliyuncs.com/Qwen3.6/logo.png">

[![Qwen Chat](https://img.shields.io/badge/%F0%9F%92%9C%EF%B8%8F%20Qwen%20Chat%20-536af5)](https://chat.qwen.ai)

> [!Note]
> This repository contains model weights and configuration files for the post-trained model in the Hugging Face Transformers format. 
>
> These artifacts are compatible with Hugging Face Transformers,
[... trimmed ...]
ng.aliyuncs.com/Qwen3.6/Figures/qwen3.6_35b_a3b_score.png)

For more details, please refer to our blog post [Qwen3.6-35B-A3B](https://qwen.ai/blog?id=qwen3.6-35b-a3b).

## Model Overview

- Type: Causal Language Model with Vision Encoder
- Training Stage: Pre-training & Post-training
- Language Model
    - Number of Parameters: 35B in total and 3B activated
    - Hidden Dimension: 2048
    - Token Embedding: 248320 (Padded)
    - Number of Layers: 40
    - Hidden Layout: 10 × (3 × (Gated DeltaNet → MoE) → 1 × (Gated Attention → MoE))
    - Gated DeltaNet:
        - Number of Linear Attention Heads: 32 for V and 16 for QK
        - Head Dimension: 128
    - Gated Attention:
        - Number of Attention Heads: 16 for Q and 2 for KV
        - Head Dimension: 256
        - Rotary Position Embedding Dimension: 64
    - Mixture Of Experts
        - Number of Experts: 256
        - Number of Activated Experts: 8 Routed + 1 Shared
        - Expert Intermediate Dimension: 512
    - LM Output: 248320 (Padded)
    - MTP: trained with multi-steps  
- Context Length: 262,144 natively and extensible up to 1,010,000 tokens.


## Benchmark Results

### Language

<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-wi