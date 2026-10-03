---
license: apache-2.0
library_name: transformers
pipeline_tag: image-text-to-text
language:
  - en
tags:
  - vision-language
  - multimodal
  - moe
---

**[ModelPage]**: https://static.stepfun.com/blog/step-3.7-flash/

## 1. Introduction

Step 3.7 Flash is a 198B-parameter sparse Mixture-of-Experts (MoE) vision-language model that combines a 196B-parameter language backbone with a 1.8B-parameter vision encoder for native image understanding. Engineered for high-frequency production workloads, it activates approximately 11B parameters per token and delivers a throughput of up to 400 tokens pe
[... trimmed ...]
r second. Step 3.7 Flash supports a 256k context window and offers three selectable reasoning levels (low, medium, and high) so developers can easily balance speed, cost, and cognitive depth.

We built Step 3.7 Flash for developers who need to scale agentic work
[... trimmed ...]
le-expert-parallel \
  --disable-cascade-attn \
  --reasoning-parser step3p5 \
  --enable-auto-tool-choice \
  --tool-call-parser step3p5 \
  --speculative_config '{"method": "mtp", "num_speculative_tokens": 3}' \
  --trust-remote-code
  ```

  - For NVFP4 model
  Compared to standard precisions, running the FP4 quantized version requires modelopt activation and FP8 KV Cache alignment.
  ```bash
  python3 -m vllm.entrypoints.openai.api_server \
  --host 0.0.0.0 \
  --port ${PORT} \
  --model stepfun-ai/Step-3.7-Flash-NVFP4 \
  --served-model-name step3p7 \
  --tensor-parallel-size 4 \
  --gpu-memory-utilization 0.9 \
  --enable-expert-parallel \
  --trust-remote-code \
  --quantization modelopt \
  --