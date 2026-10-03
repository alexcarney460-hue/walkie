---
license: apache-2.0
library_name: transformers
pipeline_tag: text-generation
tags:
- hunyuan
- hy3
- moe
- text-generation
---
<p align="left">
    <a href="https://huggingface.co/tencent/Hy3/blob/main/README_CN.md">中文</a>&nbsp;｜&nbsp;English
</p>
<br>

<p align="center">
 <img src="assets/logo-en.png" width="400"/> <br>
</p>

<div align="center" style="line-height: 1;">


[![License](https://img.shields.io/badge/License-Apache%202.0-blue)](#license)
&nbsp;&nbsp;
[![HuggingFace](https://img.shields.io/badge/%F0%9F%A4%97%20Hugging%20Face-Tencent%20Hy-ffc107?color=ffc107&logoColor=white)](ht
[... trimmed ...]
links)
- [Quickstart](#quickstart)
- [Deployment](#deployment)
  - [vLLM](#vllm)
  - [SGLang](#sglang)
- [Finetuning](#finetuning)
- [RL Post-training](#rl-post-training)
- [Quantization](#quantization)
- [License](#license)
- [Contact Us](#contact-us)

---

## Model Introduction

**Hy3** is a 295B-parameter Mixture-of-Experts (MoE) model with 21B active parameters and 3.8B MTP layer parameters, developed by the Tencent Hy Team. Following the Hy3 Preview launch in late April, we gathered feedback from 50+ products and scaled up post-training with higher quality data. Today, we introduce Hy3, which outperforms similar-size models and rivals flagship open-source models with 2-5x parameters. It also shows significant gains in utility across various products and productivity tasks.


| Property | Value |
|:---|:---|
| Architecture | Mixture-of-Experts (MoE) |
| Total Parameters | 295B |
| Activated Parameters | 21B |
| MTP Layer Parameters | 3.8B |
| Number of Layers (excluding MTP layer) | 80 |
| Number of MTP Layers | 1 |
| Attention Heads | 64 (GQA, 8 KV heads, head dim 128) |
| Hidden Size | 4096 |
| Intermediate Size | 13312 |
| Context Length | 256K |
| Vocabulary Size | 120832 |
| Number of Experts | 192 experts, top-8 activated |
| Supported Precisions | BF16 |

## Stronger Agent Capabilities

Building on Hy3 Preview, we further improved the quality and diversity of post-training data while scaling up RL training. Hy3 shows solid gains across reasoning, agentic, and long-context tasks, competitive with much larger flagship models.

<p align="center">
  <img src="assets/b