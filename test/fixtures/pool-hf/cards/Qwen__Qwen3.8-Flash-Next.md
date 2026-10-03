---
library_name: transformers
license: other
license_name: qwen-community-1.0
license_link: LICENSE
pipeline_tag: image-text-to-text
---

# Qwen3.8-Flash-Next

> [!Note]
> This repository contains model weights and configuration files for the post-trained model in the Hugging Face Transformers format. 
>
> These artifacts are compatible with Hugging Face Transformers, vLLM, SGLang, TokenSpeed, etc.

> [!Tip]
> For users seeking managed, scalable inference without infrastructure maintenance, the official Qwen API service is provided by [Qwen Cloud](https://www.qwencloud.com).
>
> In particular
[... trimmed ...]
ithub.com/QwenLM/Qwen3.8-Flash-Next/blob/main/tech_report.pdf).

We are excited to embark on this next chapter with you and welcome your feedback as we build what comes next.

## Model Overview

- Type: Causal Language Model with Vision Encoder
- Training Stage: Pre-training & Post-training
- Language Model
    - Number of Parameters: 125B with 6B activated, plus 51B n-gram embedding and 4B MTP
    - Hidden Dimension: 2560
    - Token Embedding: 248320 (Padded)
    - N-gram Embedding: 20,000,000 (bigrams/trigrams at layer 2)
    - Number of Layers: 48
    - Hidden Layout: 12 × (3 × (Gated DeltaNet → MoE) → 1 × (Qwen Sparse Attention → MoE))
    - Gated DeltaNet:
        - Number of Linear Attention H
[... trimmed ...]
ention Heads: 24 for Q and 2 for KV
        - Head Dimension: 256
        - Rotary Position Embedding Dimension: 64
        - Indexer Structure: MQA with 4 Query Heads and 1 Shared Key Head
        - Indexer Head Dimension: 128
        - Budget: 512 blocks or 2048 tokens
    - Mixture Of Experts
        - Number of Experts: 512
        - Number of Activated Experts: 10 Routed + 1 Shared
        - Expert Intermediate Dimension: 640
    - Gated Residual:
        - Number of Branches: 4
        - Bottleneck Rank: 320
    - LM Output: 248320 (Padded)
    - MTP: 1 layer, trained with multi-steps
- Context Length: 262,144 natively and extensible up to 1,000,000 tokens.

## Benchmark Results

<style>
.vl-ta
[... trimmed ...]
border-bottom:1px solid rgba(128, 128, 128, 0.15);vertical-align:middle;font-size:15px;line-height:1.2;">--</td>
</tr>
<tr>
<td class="benchmark-cell" style="padding:7px 7px;padding-left:20px;border-bottom:1px solid rgba(128, 128, 128, 0.15);"><div class="benchmark-capability" style="font-size:15px;font-weight:600;line-height:1.22;color:#171717"># Activated params</div></td>
<td style="padding:7px 7px;text-align:center;border-bottom:1px solid rgba(128, 128, 128, 0.15);background:rgba(10, 46, 254, 0.08);vertical-align:middle;font-size:15px;line-height:1.2;">6B</td>
<td style="padding:7px 7px;text-align:center;border-bottom:1px solid rgba(128, 128, 128, 0.15);vertical-align:middle;font-size:15px;line-h