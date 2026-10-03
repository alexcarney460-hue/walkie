---
library_name: transformers
license: other
license_name: openmdw-1.1
license_link: https://openmdw.ai/license/1-1/
pipeline_tag: text-generation
language:
- en
- es
- fr
- de
- it
- ja
tags:
- nvidia
- pytorch
- nemotron-3.5
datasets:
- nvidia/nemotron-post-training-v3
- nvidia/nemotron-pre-training-datasets
track_downloads: true
---

# NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16

<div align="center" style="line-height: 1;">
  <a href="https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b" target="_blank" style="margin: 2px;">
    <img alt="Chat" src="http
[... trimmed ...]
 line-height: 1;">
  <a href="https://openmdw.ai/license/1-1/" style="margin: 2px;">
    <img alt="License" src="https://img.shields.io/badge/License-OpenMDW--1.1-f5de53" style="display: inline-block; vertical-align: middle;"/>
  </a>
</div>

![](./accuracy_plot.png)

## Model Summary

| | |
|:---|:---|
| **Total Parameters** | 30B (3B active) |
| **Architecture** | MoE — Mamba-2 + MoE + Attention hybrid |
| **Precision** | BF16 (full-precision reference weights) |
| **Context Length** | Up to 1M tokens (for single H100 deployment, we use 256K) |
| **Single-GPU Deployment** | 1× H100 80GB (or 1× A100 80GB) |
| **Supported Hardware** | NVIDIA Blackwell (GB200, B200); NVIDIA Hopper 
[... trimmed ...]
ce.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4) instead.

The model employs a hybrid **Mixture-of-Experts** architecture, utilizing interleaved Mamba-2 and MoE layers, along with select Attention layers. The Lightning 3.5 model is released alongside a number of speculative decoding methods for faster text generation. The model has **3B active parameters** and **30B parameters in total**.

This model is ready for commercial use.

## Quick Start

> *For running Nemotron 3.5 Lightning fast — with NVFP4 quantization, W4A16 for broad hardware coverage, and the DSpark recipe for DGX Spark — please see: [NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4](https://huggingface.co/nvidia/NVIDIA-N
[... trimmed ...]
Release Date

[Hugging Face](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16) — 08/11/2026

## Model Architecture

- **Architecture Type:** Mixture-of-Experts Hybrid (Mamba + Transformer)
- **Network Architecture:** Nemotron-3-Lightning + Multi-Token Prediction (MTP)
- **Number of model parameters:** 30B Total / 3B Active

## Model Design

The model was pre-trained with over 20T tokens and supports up to 1M context length. The pre-training phase used an NVFP4 recipe. The model includes **Multi-Token Prediction (MTP)** layers, which predict multiple future tokens to provide richer training signals.

## Training Methodology

Stage 1: Pre-Training

* NVIDIA-
[... trimmed ...]
tion-calling-v2]; [SciBench]; [tigerbot-kaggle-leetcodesolutions-en-2k]; [OpenBookQA]; [Advanced Reasoning Benchmark]; Software Heritage; [Khan Academy Math Keywords]; [WildChat-1M]; [Nemotron-Personas-USA] | [gpt-oss-120b]; [Mixtral-8x22B-Instruct-v0.1]; [Qwen3-235B-A22B-Instruct-2507]; [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic Tool Use Interactive Agent from gpt-oss-120b, DeepSeek-R1-0528, Qwen3-32B, and Qwen3-235B-A22B-Thinking-2507 | Text | Undisclosed | NVIDIA Internal | [gpt-oss-120b]; [DeepSeek-R1-0528]; [Qwen3-32B]; [Qwen3-235B-A22B-Thinking-2507] |
| Synthetic DocFinQA and SWE-smith from Qwen3-Coder-480B-A35B-Instruct and Kimi-K2-Thinking | Text | Undisclosed | [DocFinQA]; [SWE-smit